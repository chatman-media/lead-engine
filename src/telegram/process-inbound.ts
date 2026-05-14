import { config } from "../config.ts";
import type { ConversationRow, ConversationsRepo } from "../db/repos/conversations.ts";
import { type ExperimentsRepo, parseAllocationToExperiment } from "../db/repos/experiments.ts";
import type { StylesRepo } from "../db/repos/styles.ts";
import type { UserRow } from "../db/repos/users.ts";
import { renderVacanciesBlock } from "../db/repos/vacancies.ts";
import { inc } from "../metrics.ts";
import { type AnswerResult, answerWithRag, NO_CONTEXT_MARKER } from "../rag/answer.ts";
import { gradeSkills } from "../rag/grade-skills.ts";
import { pickVariant } from "../sales/ab-router.ts";
import type { SkillForPrompt } from "../sales/prompt.ts";
import { classifyStage } from "../sales/stage-classifier.ts";
import { nextStage } from "../sales/stage-router.ts";
import { FUNNEL_STAGES, type FunnelStage, type Style } from "../sales/types.ts";
import { containsEscalationTrigger } from "./escalation.ts";
import { runIntakeUpdate, runVisaDocsUpdate } from "./lead-hooks.ts";
import { runMemoryExtraction } from "./memory-extraction.ts";
import { runConversationSummaryRefresh } from "./summary-refresh.ts";
import type { ProcessInboundDeps, RagDeps } from "./webhook-types.ts";

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
      console.warn(
        `[sales] conv ${d.conv.id} references style_id=${d.conv.style_id} that no longer exists; falling back`,
      );
      return null;
    }
    try {
      return d.styles.parseRow(row);
    } catch (err) {
      console.error(`[sales] failed to parse style row id=${row.id}:`, err);
      return null;
    }
  }

  // Priority 3: running experiment → pickVariant + persist assignment.
  const running = await d.experiments.getRunning();
  if (!running) return null;

  const experiment = parseAllocationToExperiment(running);
  if (!experiment) {
    console.warn(`[sales] experiment ${running.slug} has malformed allocation_json; skipping`);
    return null;
  }

  const variantSlug = pickVariant(experiment, d.user.tg_user_id);
  const variantRow = await d.styles.bySlug(variantSlug);
  if (!variantRow) {
    console.warn(
      `[sales] experiment ${running.slug} allocates to slug "${variantSlug}" that's missing/inactive in styles table`,
    );
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
    console.error(`[sales] failed to parse style row id=${variantRow.id}:`, err);
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

async function runRagForInbound(
  d: ProcessInboundDeps,
): Promise<{ result: AnswerResult; stage?: FunnelStage; skillSlugs: string[] }> {
  if (!d.rag) throw new Error("runRagForInbound: rag deps required");

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
      console.log(
        `[sales] stage=${stage} source=${result.source} confidence=${result.confidence.toFixed(2)}` +
          (result.fallbackReason ? ` reason=${result.fallbackReason}` : ""),
      );
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
  });
  // path is the categorical outcome of the RAG turn — ok / no_context /
  // ungrounded / smalltalk / persona_fact. Bucketed here so the /metrics
  // dashboard can see retrieval health without scraping per-message
  // telemetry JSON.
  if (result.telemetry?.path) {
    inc("rag_kb_hits_total", 1, { path: result.telemetry.path });
  }
  return {
    result,
    stage,
    skillSlugs: resolvedSkills?.map((s) => s.slug) ?? [],
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
    console.warn("[skill-grading] failed:", err);
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
      console.error("[webhook] sendMessage failed (non-fatal):", err);
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

  console.log(
    `[processInbound] conv=${d.conv.id} mode=${d.conv.mode} rag=${d.rag ? "yes" : "no"} tgUserId=${d.tgUserId}`,
  );

  if (d.conv.mode === "human") {
    console.log(`[processInbound] conv=${d.conv.id} → skipped (human mode)`);
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
    await runMemoryExtraction(d);
    await runConversationSummaryRefresh(d);
    await runIntakeUpdate(d);
    await runVisaDocsUpdate(d);
    return;
  }

  if (containsEscalationTrigger(d.text)) {
    await d.conversations.setMode(d.conv.id, "queued");
    d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
    return;
  }

  if (!d.rag) {
    console.log(`[processInbound] conv=${d.conv.id} → skipped (no rag)`);
    return;
  }

  const { result, stage, skillSlugs } = await runRagForInbound(d);

  console.log(
    `[processInbound] conv=${d.conv.id} rag result=${result.text === NO_CONTEXT_MARKER ? "NO_CONTEXT" : `reply(${result.text.length}chars)`} stage=${stage ?? "none"}`,
  );

  if (result.text === NO_CONTEXT_MARKER) {
    // Consecutive-stall anti-deadloop: after STALL_LIMIT silent turns in a row,
    // send a CTA-fallback instead of staying silent. This keeps the candidate
    // engaged rather than watching "Секунду, уточню…" repeat endlessly.
    const STALL_LIMIT = 3;
    const stallCount = (await d.conversations.getStallCount(d.conv)) + 1;
    await d.conversations.setStallCount(d.conv.id, stallCount);

    console.log(`[processInbound] conv=${d.conv.id} stall=${stallCount}/${STALL_LIMIT}`);
    if (stallCount >= STALL_LIMIT) {
      // Reset counter so next stall cycle restarts from 0.
      await d.conversations.setStallCount(d.conv.id, 0);
      // Send CTA-fallback: pivot to call — moves toward conversion instead
      // of silently queuing. Keep the conversation in AI mode so the bot can
      // still reply to follow-ups.
      const ctaReply =
        d.rag?.style?.voice?.stallCtaReply ??
        "Давай созвонимся — так быстрее всё объясню. В какое время удобно? 😊";
      console.log(
        `[webhook] stall limit (${STALL_LIMIT}) reached for conv=${d.conv.id} — sending CTA`,
      );
      await reply(ctaReply, { used_chunk_ids: [], telemetry: result.telemetry }, stage);
      await runMemoryExtraction(d);
      await runConversationSummaryRefresh(d);
      await runIntakeUpdate(d);
      await runVisaDocsUpdate(d);
      return;
    }

    // Queue the conversation so the operator sees it needs a manual reply.
    if (d.conv.mode === "ai") {
      await d.conversations.setMode(d.conv.id, "queued");
      d.conv.mode = "queued";
      d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
    }

    // Record the unanswered question for the KB approval pipeline.
    // Dedup: if there is already a pending suggestion for this conversation
    // (same question lingering) a new row is NOT inserted — see KbSuggestionsRepo.create.
    try {
      const userMsg = (await d.messages.recentForContext(d.conv.id, 1)).find(
        (m) => m.role === "user",
      );
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
      console.error("[webhook] kb_suggestion create failed (non-fatal):", err);
    }

    // Run memory extraction even on silent turns — the user message itself
    // may carry persistent facts ("I'm Anya, 25, from Moscow") that we want
    // remembered regardless of whether RAG could answer.
    await runMemoryExtraction(d);
    await runConversationSummaryRefresh(d);
    await runIntakeUpdate(d);
    await runVisaDocsUpdate(d);
    return;
  }

  // Successful answer — reset the stall counter.
  await d.conversations.setStallCount(d.conv.id, 0);

  const { messageId } = await reply(
    result.text,
    { used_chunk_ids: result.usedChunkIds, telemetry: result.telemetry },
    stage,
  );
  await runMemoryExtraction(d);
  await runConversationSummaryRefresh(d);
  await runIntakeUpdate(d);
  await runVisaDocsUpdate(d);

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
