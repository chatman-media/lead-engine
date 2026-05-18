import { config } from "../config.ts";
import type { ConversationRow, ConversationsRepo } from "../db/repos/conversations.ts";
import { type ExperimentsRepo, parseAllocationToExperiment } from "../db/repos/experiments.ts";
import type { StylesRepo } from "../db/repos/styles.ts";
import type { UserRow } from "../db/repos/users.ts";
import { renderVacanciesBlock } from "../db/repos/vacancies.ts";
import { VISA_PHOTO_REQUIREMENTS } from "../leads/templates.ts";
import {
  interviewQuestion,
  nextInterviewField,
  VISA_INTERVIEW_DONE,
} from "../leads/visa-interview.ts";
import { log } from "../log.ts";
import { inc } from "../metrics.ts";
import {
  type AnswerResult,
  answerWithRag,
  generateSoftFallback,
  NO_CONTEXT_MARKER,
  type Persona,
} from "../rag/answer.ts";
import type { ChatMessage } from "../rag/chat.ts";
import { gradeSkills } from "../rag/grade-skills.ts";
import { pickVariant } from "../sales/ab-router.ts";
import type { SkillForPrompt } from "../sales/prompt.ts";
import { classifyStage } from "../sales/stage-classifier.ts";
import { nextStage } from "../sales/stage-router.ts";
import { FUNNEL_STAGES, type FunnelStage, type Style } from "../sales/types.ts";
import { containsEscalationTrigger } from "./escalation.ts";
import { runIntakeUpdate, runVisaDocsUpdate } from "./lead-hooks.ts";
import { runMemoryExtraction } from "./memory-extraction.ts";
import { runPhotoClassification } from "./photo-hooks.ts";
import { runConversationSummaryRefresh } from "./summary-refresh.ts";
import type { ProcessInboundDeps, RagDeps } from "./webhook-types.ts";

/**
 * The "after every turn" maintenance tasks that have to run regardless
 * of which branch processInbound took (successful reply, NO_CONTEXT stall,
 * CTA fallback, still-queued retry). Extracted so adding another post-turn
 * hook is a one-line edit instead of a multi-call diff in several places.
 *
 * Each hook is fire-and-forget on errors (each implementation catches its
 * own exceptions and logs); they're awaited sequentially because they all
 * read/write `users.profile_json.memory` and `leads.intake_json` and would
 * otherwise race against each other. `runPhotoClassification` runs before
 * `runIntakeUpdate` so the photo classes it stamps feed the intake counters.
 */
async function runPostReplyHooks(d: ProcessInboundDeps): Promise<void> {
  await runMemoryExtraction(d);
  await runConversationSummaryRefresh(d);
  await runPhotoClassification(d);
  await runIntakeUpdate(d);
  await runVisaDocsUpdate(d);
}

/**
 * Resolves which sales-engine `Style` (if any) to use for a given conversation.
 *
 * Priority chain (highest wins):
 *   1. `rag.style` — env-based force-override (`BOT_SALES_STYLE`).
 *   2. `conv.style_id` — sticky per-conversation assignment from DB.
 *   3. Running experiment in `experiments` table — assigns and persists now.
 *   4. None — caller falls back to legacy `persona` path.
 *
 * Side-effect: when (3) fires, this function writes `conv.style_id` and
 * `conv.experiment_id` so subsequent turns are sticky. Any other result has
 * no DB writes.
 *
 * Returns `null` when no style applies — caller uses `rag.persona` instead.
 */
async function resolveStyle(d: {
  rag?: RagDeps;
  conv: ConversationRow;
  user: UserRow;
  styles: StylesRepo;
  experiments: ExperimentsRepo;
  conversations: ConversationsRepo;
}): Promise<Style | null> {
  // Priority 1: env force-override.
  if (d.rag?.style) return d.rag.style;

  // Priority 2: existing assignment.
  if (d.conv.style_id != null) {
    const row = await d.styles.byId(d.conv.style_id);
    if (!row) {
      log.warn("style row missing; falling back", {
        scope: "sales",
        conv_id: d.conv.id,
        style_id: d.conv.style_id,
      });
      return null;
    }
    try {
      return d.styles.parseRow(row);
    } catch (err) {
      log.error("failed to parse style row", { scope: "sales", style_id: row.id, err });
      return null;
    }
  }

  // Priority 3: running experiment → pickVariant + persist assignment.
  const running = await d.experiments.getRunning();
  if (!running) return null;

  const experiment = parseAllocationToExperiment(running);
  if (!experiment) {
    log.warn("experiment has malformed allocation_json; skipping", {
      scope: "sales",
      experiment_slug: running.slug,
    });
    return null;
  }

  const variantSlug = pickVariant(experiment, d.user.tg_user_id);
  const variantRow = await d.styles.bySlug(variantSlug);
  if (!variantRow) {
    log.warn("experiment variant missing/inactive in styles table", {
      scope: "sales",
      experiment_slug: running.slug,
      variant_slug: variantSlug,
    });
    return null;
  }

  try {
    const style = d.styles.parseRow(variantRow);
    await d.conversations.assignStyle(d.conv.id, variantRow.id, running.id);
    // Reflect on the in-memory row so downstream code sees the assignment.
    d.conv.style_id = variantRow.id;
    d.conv.experiment_id = running.id;
    return style;
  } catch (err) {
    log.error("failed to parse style row", { scope: "sales", style_id: variantRow.id, err });
    return null;
  }
}

const FUNNEL_STAGE_SET: ReadonlySet<string> = new Set(FUNNEL_STAGES);

/** Coerce a string from `conversations.current_stage` into a typed FunnelStage,
 *  or null if it's NULL / unrecognized (treat as fresh conversation). */
function toFunnelStage(raw: string | null): FunnelStage | null {
  if (raw === null) return null;
  return FUNNEL_STAGE_SET.has(raw) ? (raw as FunnelStage) : null;
}

/** Support mode: a lead past approval that is waiting on the visa
 *  process. `docs_pending` → still collecting her documents;
 *  `submitted` → filed with the consulate. Any other lead state (or no
 *  lead) → undefined (normal sales behaviour). */
async function resolveSupportPhase(
  d: ProcessInboundDeps,
): Promise<"docs" | "submitted" | undefined> {
  const lead = await d.leads.byUserId(d.user.id);
  if (lead?.state === "docs_pending") return "docs";
  if (lead?.state === "submitted") return "submitted";
  return undefined;
}

/**
 * Step-by-step visa-anketa interview. While a lead is `submitted` ("подача
 * на визу") and `visa_interview_field` points at a field, every candidate
 * message is treated as the answer to the current field: it's stored into
 * `visa_docs_json`, the pointer advances, and the next question is sent.
 * When the last field is answered the pointer is cleared and the photo /
 * passport-pages request is sent.
 *
 * Returns `true` when it handled the turn (caller must skip RAG), `false`
 * when the lead is not mid-interview (normal flow continues).
 */
async function maybeHandleVisaInterview(
  d: ProcessInboundDeps,
  reply: (text: string, meta?: unknown) => Promise<{ messageId: number }>,
): Promise<boolean> {
  const lead = await d.leads.byUserId(d.user.id);
  if (!lead || lead.state !== "submitted" || !lead.visa_interview_field) return false;
  // A bare photo/media upload is not a text answer — let it fall through to
  // the media-only handler (classification / ack) without consuming the
  // current step or overwriting its field with an empty string.
  if (d.mediaOnly) return false;

  const currentField = lead.visa_interview_field;

  // Store the candidate's answer into the current visa-anketa field.
  let docs: Record<string, string> = {};
  if (lead.visa_docs_json) {
    try {
      const parsed = JSON.parse(lead.visa_docs_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        docs = parsed as Record<string, string>;
      }
    } catch {
      // Corrupt JSON — start fresh rather than abort the interview.
    }
  }
  docs[currentField] = d.text.trim();
  await d.leads.setVisaDocs(lead.id, JSON.stringify(docs));

  const next = nextInterviewField(currentField);
  if (next) {
    await d.leads.setVisaInterviewField(lead.id, next);
    const question = interviewQuestion(next);
    if (question) await reply(question, { source: "visa-interview" });
  } else {
    await d.leads.setVisaInterviewField(lead.id, null);
    await reply(`${VISA_INTERVIEW_DONE}\n\n${VISA_PHOTO_REQUIREMENTS}`, {
      source: "visa-interview",
    });
  }
  return true;
}

async function runRagForInbound(d: ProcessInboundDeps): Promise<{
  result: AnswerResult;
  stage?: FunnelStage;
  skillSlugs: string[];
  supportPhase?: "docs" | "submitted";
  /** Conversation history + resolved persona — reused by the soft-fallback
   *  path when RAG returns NO_CONTEXT so the bot can still answer. */
  history: ChatMessage[];
  persona: Persona;
}> {
  if (!d.rag) throw new Error("runRagForInbound: rag deps required");

  const supportPhase = await resolveSupportPhase(d);

  const style = await resolveStyle({
    rag: d.rag,
    conv: d.conv,
    user: d.user,
    styles: d.styles,
    experiments: d.experiments,
    conversations: d.conversations,
  });

  // Resolve skills attached to this style. `style_id` on the conversation
  // is the canonical pointer (set by resolveStyle when forking via A/B);
  // for env-forced styles we look up by slug. Both filtered by catalogue's
  // is_enabled flag so operators can globally disable a noisy skill.
  let resolvedSkills: SkillForPrompt[] | undefined;
  if (style) {
    let styleId: number | null = d.conv.style_id;
    if (styleId == null) {
      const row = await d.styles.bySlug(style.slug);
      styleId = row?.id ?? null;
    }
    if (styleId != null) {
      const rows = (await d.skills.skillsForStyle(styleId)).filter((r) => r.is_enabled);
      resolvedSkills = rows.map((r) => ({
        slug: r.slug,
        displayName: r.display_name,
        promptFragment: r.prompt_fragment,
        applicableStages: parseStagesJson(r.applicable_stages_json),
      }));
    }
  }

  // Funnel-stage routing. Default is the regex router (sub-ms, predictable).
  // When `rag.stageClassifier === "llm"` we delegate to an LLM-based
  // classifier that falls back to regex on low confidence / parse errors.
  // Persist the resolved stage on the conversation so it survives restarts.
  let stage: FunnelStage | undefined;
  let includeFewShot: boolean | undefined;
  if (style) {
    const userMessageCount = (await d.messages.listByConversation(d.conv.id)).filter(
      (m) => m.role === "user",
    ).length;
    const previousStage = toFunnelStage(d.conv.current_stage);

    if (d.rag.stageClassifier === "llm") {
      const result = await classifyStage({
        chat: d.rag.chat,
        userMessage: d.text,
        currentStage: previousStage,
        turnNumber: userMessageCount,
        ...(d.rag.stageClassifierThreshold !== undefined
          ? { confidenceThreshold: d.rag.stageClassifierThreshold }
          : {}),
      });
      stage = result.stage;
      log.debug("stage classified", {
        scope: "sales",
        conv_id: d.conv.id,
        stage,
        source: result.source,
        confidence: result.confidence,
        ...(result.fallbackReason ? { fallback_reason: result.fallbackReason } : {}),
      });
    } else {
      stage = nextStage({
        turnNumber: userMessageCount,
        currentStage: previousStage,
        lastUserMessage: d.text,
      });
    }

    await d.conversations.setCurrentStage(d.conv.id, stage);
    includeFewShot = userMessageCount <= 1;
  }

  // Conversation history — без неё каждый turn идёт изолированно и модель
  // отвечает на «все» / «расскажи подробнее» наугад (без знания о чём была
  // прошлая реплика). Берём 12 последних сообщений и КИДАЕМ только тот
  // user-row, который мы только что вставили (он же в d.text), чтобы не
  // дублировать его в финальном prompt.
  const recent = await d.messages.recentForContext(d.conv.id, 12);
  const justInsertedIdx = recent
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role === "user" && m.text === d.text)
    .pop()?.i;
  const history = recent
    .filter((_, i) => i !== justInsertedIdx)
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "human")
    .map((m) => ({
      // Из перспективы LLM, ответы оператора (human) и AI (assistant) одинаковы:
      // это всё «реплики бота-Алины». Кандидат не должен видеть разницу.
      role: m.role === "human" ? ("assistant" as const) : (m.role as "user" | "assistant"),
      content: m.text,
    }));

  // Cross-session memory: pull facts learned in past turns (and past
  // conversations) so the bot doesn't re-ask the candidate's city/age/etc.
  // Read is cheap (single DB row); facts from current message land on the
  // NEXT turn (extraction runs after the reply, see processInbound).
  const userFacts = d.rag.userMemory ? (await d.users.getMemory(d.user.id)).facts : undefined;

  // Long-conversation summary (when feature is on AND a summary exists).
  // Refresh decision happens AFTER reply (see runConversationSummaryRefresh)
  // so the hot path stays fast — current turn uses whatever is currently
  // stored, next turn benefits from the refresh.
  const conversationSummary = d.rag.conversationSummary
    ? ((await d.conversations.getSummary(d.conv.id))?.summary ?? undefined)
    : undefined;

  // Active vacancies (admin-managed). Fast SQL read on every turn.
  // Empty when none configured — answerWithRag treats "" as "no block".
  const vacanciesBlock = renderVacanciesBlock(await d.vacancies.listActive());

  const result = await answerWithRag({
    question: d.text,
    kb: d.kb,
    embedder: d.rag.embedder,
    chat: d.rag.chat,
    history,
    topK: d.rag.topK ?? 5,
    maxDistance: d.rag.maxDistance,
    persona: d.rag.persona,
    ...(style ? { style } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(includeFewShot !== undefined ? { includeFewShot } : {}),
    ...(userFacts && Object.keys(userFacts).length > 0 ? { userFacts } : {}),
    ...(conversationSummary ? { conversationSummary } : {}),
    ...(d.rag.queryRewrite ? { rewriteQueryBeforeRetrieval: true } : {}),
    ...(d.rag.reflect ? { reflect: true } : {}),
    ...(d.rag.hybridSearch ? { hybridSearch: true } : {}),
    ...(d.rag.topicRouting ? { topicRouting: true } : {}),
    ...(d.rag.booksPriority ? { booksPriority: true } : {}),
    ...(vacanciesBlock ? { vacanciesBlock } : {}),
    ...(resolvedSkills && resolvedSkills.length > 0 ? { skills: resolvedSkills } : {}),
    ...(supportPhase ? { supportPhase } : {}),
  });
  // path is the categorical outcome of the RAG turn — ok / no_context /
  // ungrounded / smalltalk / persona_fact. Bucketed here so the /metrics
  // dashboard can see retrieval health without scraping per-message
  // telemetry JSON.
  if (result.telemetry?.path) {
    inc("rag_kb_hits_total", 1, { path: result.telemetry.path });
  }
  // Resolved persona — style.persona when a sales style is active, otherwise
  // the env-configured persona (defaulted). Used by the soft-fallback reply.
  const persona: Persona = style
    ? {
        name: style.persona.name,
        role: style.persona.role,
        ...(style.persona.company?.trim() ? { company: style.persona.company.trim() } : {}),
      }
    : (d.rag.persona ?? { name: "Менеджер", role: "human" });
  return {
    result,
    stage,
    skillSlugs: resolvedSkills?.map((s) => s.slug) ?? [],
    ...(supportPhase ? { supportPhase } : {}),
    history,
    persona,
  };
}

/** Parse the `applicable_stages_json` JSON-array string from skills row.
 *  Falls back to [] on any parse error so a corrupt row doesn't 500
 *  the whole webhook. */
function parseStagesJson(raw: string): readonly FunnelStage[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is FunnelStage =>
      ["opener", "qualify", "pitch", "objection", "close"].includes(s),
    );
  } catch {
    return [];
  }
}

/**
 * Self-grade the just-sent reply: ask the LLM which configured skills it
 * actually used, then patch the message's meta_json with the result.
 * Fire-and-forget — doesn't block the candidate. Errors are logged.
 */
async function runSkillGrading(
  d: ProcessInboundDeps,
  args: {
    messageId: number;
    question: string;
    reply: string;
    usedChunkIds: number[];
    telemetry: unknown;
    skillSlugs: string[];
  },
): Promise<void> {
  if (!d.rag?.chat) return;
  try {
    const used = await gradeSkills({
      question: args.question,
      reply: args.reply,
      availableSlugs: args.skillSlugs,
      chat: d.rag.chat,
    });
    // Merge `skills_used` into existing telemetry blob without losing
    // the other fields the webhook persisted on the message.
    const existing = (args.telemetry ?? {}) as Record<string, unknown>;
    const mergedTelemetry = { ...existing, skills_used: used };
    await d.messages.setMeta(args.messageId, {
      used_chunk_ids: args.usedChunkIds,
      telemetry: mergedTelemetry,
    });
  } catch (err) {
    log.warn("skill-grading failed", { err });
  }
}

export async function processInbound(d: ProcessInboundDeps): Promise<void> {
  const reply = async (
    text: string,
    meta?: unknown,
    stage?: FunnelStage,
  ): Promise<{ messageId: number }> => {
    let tgMessageId: number | undefined;
    try {
      const sent = await d.telegram.sendMessage({
        chatId: d.chatId,
        text,
      });
      tgMessageId = sent.message_id;
      inc("tg_replies_total", 1, { source: "webhook" });
    } catch (err) {
      inc("llm_errors_total", 1, { stage: "sendMessage" });
      log.error("sendMessage failed (non-fatal)", {
        scope: "webhook",
        conv_id: d.conv.id,
        err,
      });
    }
    const inserted = await d.messages.add({
      conversationId: d.conv.id,
      role: "assistant",
      text,
      tgMessageId,
      meta,
      ...(stage !== undefined ? { stage } : {}),
    });
    await d.conversations.touch(d.conv.id);
    d.onEvent?.({
      type: "assistant-replied",
      conversationId: d.conv.id,
      tgUserId: d.tgUserId,
    });
    return { messageId: inserted.id };
  };

  log.info("processInbound start", {
    scope: "webhook",
    conv_id: d.conv.id,
    mode: d.conv.mode,
    rag: !!d.rag,
    tg_user_id: d.tgUserId,
  });

  // Step-by-step visa-anketa interview ("подача на визу") takes precedence
  // over the conversation-mode gates below: while it's active, the
  // candidate's message is an answer to the current field. Without this a
  // lead the operator handled in `human` mode — or a `queued` chat — would
  // never have its answers stored: the interview would stall after Q1.
  if (await maybeHandleVisaInterview(d, reply)) {
    return;
  }

  if (d.conv.mode === "human") {
    log.debug("skipped (human mode)", { scope: "webhook", conv_id: d.conv.id });
    return;
  }

  // A bare photo/media upload (no caption) is not a question — never
  // generate a chat reply for it. Still run the post-reply hooks so the
  // photo gets classified and the candidate gets ONE deduped
  // acknowledgement per album (passport received / full-body nudge),
  // plus the intake / visa-docs updates. Applies the same in ai and
  // queued mode — a photo never triggers the queued-retry RAG path.
  if (d.mediaOnly) {
    log.debug("media-only turn — hooks only, no chat reply", {
      scope: "webhook",
      conv_id: d.conv.id,
    });
    if (d.rag) await runPostReplyHooks(d);
    return;
  }

  if (d.conv.mode === "queued") {
    if (!d.rag) {
      return;
    }
    if (containsEscalationTrigger(d.text)) {
      return;
    }
    // Conversation is queued (explicit operator request). Retry RAG on each
    // inbound — a contextual hit returns mode to ai.
    const { result, stage } = await runRagForInbound(d);
    if (result.text !== NO_CONTEXT_MARKER) {
      await d.conversations.setMode(d.conv.id, "ai");
      d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
      await reply(
        result.text,
        { used_chunk_ids: result.usedChunkIds, telemetry: result.telemetry },
        stage,
      );
      return;
    }
    // Still no answer — stay queued. Run background tasks so intake/memory
    // continue to update even while the conversation awaits a manual reply.
    await runPostReplyHooks(d);
    return;
  }

  if (containsEscalationTrigger(d.text)) {
    await d.conversations.setMode(d.conv.id, "queued");
    d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
    return;
  }

  if (!d.rag) {
    log.debug("skipped (no rag)", { scope: "webhook", conv_id: d.conv.id });
    return;
  }

  const { result, stage, skillSlugs, supportPhase, history, persona } = await runRagForInbound(d);

  log.info("rag finished", {
    scope: "webhook",
    conv_id: d.conv.id,
    no_context: result.text === NO_CONTEXT_MARKER,
    reply_chars: result.text === NO_CONTEXT_MARKER ? 0 : result.text.length,
    stage: stage ?? null,
  });

  if (result.text === NO_CONTEXT_MARKER) {
    // Support mode (lead waiting on the visa process): the candidate is
    // already approved — a question we can't answer from KB gets a calm,
    // deterministic reassurance (no LLM call, no risk of a sales CTA),
    // and the chat stays in `ai` mode so the bot keeps handling the wait.
    // The "оператор" keyword still escalates manually (handled earlier).
    if (supportPhase) {
      await reply(
        "Виза сейчас оформляется, всё идёт своим ходом. Как будут новости — обязательно напишу 🌷",
        { used_chunk_ids: [], telemetry: result.telemetry },
        stage,
      );
      await runPostReplyHooks(d);
      return;
    }

    // No groundable answer — no KB hit, or the fact-checker dropped the draft
    // as ungrounded. The bot must never go silent: reply in its own persona
    // voice with a soft answer that invents NO specifics (generateSoftFallback
    // is hard-constrained against fabricating numbers / dates / visa terms).
    //
    // The conversation stays in AI mode — no "queued" highlight. The question
    // is still logged to kb_suggestions so an operator can give a precise
    // answer later from that section, if they choose to.

    // Capture the candidate's message id BEFORE replying (reply() inserts an
    // assistant row, which would otherwise shadow it in recentForContext).
    const userMsg = (await d.messages.recentForContext(d.conv.id, 1)).find(
      (m) => m.role === "user",
    );

    let fallbackText: string;
    try {
      fallbackText = await generateSoftFallback({
        question: d.text,
        chat: d.rag.chat,
        persona,
        history,
      });
    } catch (err) {
      log.error("soft fallback generation failed — using static reply", {
        scope: "webhook",
        conv_id: d.conv.id,
        err,
      });
      fallbackText =
        d.rag?.style?.voice?.stallCtaReply ??
        "Хороший вопрос — уточню детали и вернусь к вам чуть позже 🙏";
    }
    await reply(fallbackText, { used_chunk_ids: [], telemetry: result.telemetry }, stage);

    // Record the unanswered question for the KB approval pipeline.
    // Dedup: if there is already a pending suggestion for this conversation
    // (same question lingering) a new row is NOT inserted — see KbSuggestionsRepo.create.
    try {
      const suggestion = await d.kbSuggestions.create({
        questionText: d.text,
        sourceConversationId: d.conv.id,
        sourceMessageId: userMsg?.id,
      });
      d.onEvent?.({
        type: "kb-suggestion:created",
        suggestionId: suggestion.id,
        conversationId: d.conv.id,
      });
    } catch (err) {
      log.error("kb_suggestion create failed (non-fatal)", {
        scope: "webhook",
        conv_id: d.conv.id,
        err,
      });
    }

    await runPostReplyHooks(d);
    return;
  }

  // Successful answer — reset the stall counter.
  await d.conversations.setStallCount(d.conv.id, 0);

  const { messageId } = await reply(
    result.text,
    { used_chunk_ids: result.usedChunkIds, telemetry: result.telemetry },
    stage,
  );
  await runPostReplyHooks(d);

  // Fire-and-forget: self-grade which skills the reply demonstrated, write
  // the result back into meta_json. Gated by RAG_SKILL_GRADING because
  // it's an extra LLM call per turn.
  if (config.rag.skillGrading && d.rag?.chat && skillSlugs.length > 0) {
    void runSkillGrading(d, {
      messageId,
      question: d.text,
      reply: result.text,
      usedChunkIds: result.usedChunkIds,
      telemetry: result.telemetry,
      skillSlugs,
    });
  }
}
