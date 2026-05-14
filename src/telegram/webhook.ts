import { config, telegramOpenAccess } from "../config.ts";
import type { Sql } from "../db/postgres.ts";
import { type ConversationRow, ConversationsRepo } from "../db/repos/conversations.ts";
import { ExperimentsRepo, parseAllocationToExperiment } from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { KbSuggestionsRepo } from "../db/repos/kb-suggestions.ts";
import { LeadsRepo } from "../db/repos/leads.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { SkillsRepo } from "../db/repos/skills.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { type UserRow, UsersRepo } from "../db/repos/users.ts";
import { renderVacanciesBlock, VacanciesRepo } from "../db/repos/vacancies.ts";
import { extractIntake } from "../leads/intake.ts";
import { LeadsService } from "../leads/service.ts";
import { type IntakeFields, isIntakeComplete } from "../leads/templates.ts";
import { extractVisaDocs, type VisaFields } from "../leads/visa-docs.ts";
import {
  type AnswerResult,
  answerWithRag,
  NO_CONTEXT_MARKER,
  type Persona,
} from "../rag/answer.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import { extractUserFacts } from "../rag/extract-user-facts.ts";
import { gradeSkills } from "../rag/grade-skills.ts";
import { summarizeConversation } from "../rag/summarize-conversation.ts";
import { json, type RouteHandler } from "../router.ts";
import { pickVariant } from "../sales/ab-router.ts";
import type { SkillForPrompt } from "../sales/prompt.ts";
import { classifyStage } from "../sales/stage-classifier.ts";
import { nextStage } from "../sales/stage-router.ts";
import { FUNNEL_STAGES, type FunnelStage, type Style } from "../sales/types.ts";
import type { TelegramClient } from "./client.ts";
import { containsEscalationTrigger } from "./escalation.ts";
import type { TgMessage, TgUpdate } from "./types.ts";

export interface RagDeps {
  embedder: EmbeddingClient;
  chat: ChatClient;
  /**
   * Enable cross-session memory: after each turn, extract facts about the
   * candidate and persist them in users.profile_json.memory. Facts are
   * injected into the system prompt on subsequent turns so the bot doesn't
   * re-ask things the candidate already volunteered. Adds one async LLM call
   * after the reply (does NOT block the reply itself).
   */
  userMemory?: boolean;
  /** Query rewriting before retrieval — see `answerWithRag.rewriteQueryBeforeRetrieval`. */
  queryRewrite?: boolean;
  /** Post-generation hallucination check — see `answerWithRag.reflect`. */
  reflect?: boolean;
  /** Hybrid BM25+vector retrieval with RRF fusion — see `answerWithRag.hybridSearch`. */
  hybridSearch?: boolean;
  /** Topic-routed retrieval — see `answerWithRag.topicRouting`. */
  topicRouting?: boolean;
  /** Books-priority retrieval — see `answerWithRag.booksPriority`. */
  booksPriority?: boolean;
  /**
   * Conversation summarization for long chats: when total messages exceeds
   * `summaryStartThreshold` (default 30), older turns get compressed into a
   * paragraph stored in `conversations.summary_json` and injected into the
   * system prompt as "ИЗ РАННЕЙ ПЕРЕПИСКИ:". Refreshed lazily after each
   * reply when the gap from `summarizedThroughMsgId` exceeds
   * `summaryStaleness` (default 8 messages). Adds one async LLM call per
   * refresh (does NOT block the reply itself).
   */
  conversationSummary?: boolean;
  topK?: number;
  /** pgvector cosine distance threshold; hits above are dropped before LLM. */
  maxDistance?: number;
  /** How the bot identifies itself in answers (name, role, company).
   *  Used only when `style` is not provided. */
  persona?: Persona;
  /**
   * Sales-engine style FORCE-OVERRIDE. When set, this style is used for ALL
   * conversations regardless of DB state — the operator's escape hatch via
   * `BOT_SALES_STYLE` env. When unset, the bot picks a per-conversation
   * style from the DB (`styles` + `experiments` tables) on first inbound.
   */
  style?: Style;
  /**
   * Funnel-stage routing strategy.
   *   "regex" — fast regex-based router (default).
   *   "llm"   — LLM classifies the message; falls back to regex when
   *             confidence < `stageClassifierThreshold` or output is bad.
   * Adds one LLM call per inbound message when enabled — pick a small/fast
   * model if cost or latency matters.
   */
  stageClassifier?: "regex" | "llm";
  /** Confidence threshold for the LLM classifier (0..1). Default 0.6. */
  stageClassifierThreshold?: number;
}

export type WebhookEvent =
  | { type: "user-message-persisted"; conversationId: number; tgUserId: number }
  | { type: "assistant-replied"; conversationId: number; tgUserId: number }
  | { type: "conversation-mode-changed"; conversationId: number }
  | { type: "kb-suggestion:created"; suggestionId: number; conversationId: number };

export interface WebhookDeps {
  db: Sql;
  telegram: TelegramClient;
  webhookSecret: string;
  /** Optional: when present, bot answers via RAG. Otherwise it sends a stub
   *  reply (useful when no LLM keys are configured yet). */
  rag?: RagDeps;
  /** Group chat where lead cards are auto-posted on intake_complete. */
  leadsChatId?: number | null;
  /** Group chat where the visa-submission package is posted (Phase 2C). */
  visaChatId?: number | null;
  /** Single sink for all dialog-state changes the webhook produces. The
   *  HTTP layer fans this out to AdminBus / WS subscribers. */
  onEvent?: (event: WebhookEvent) => void;
  /**
   * Handler for inline-keyboard clicks on lead cards in the ops chat
   * (`update.callback_query`). When unset, callback updates are silently
   * ignored — useful in tests / setups without the leads module wired in.
   */
  onCallbackQuery?: (query: import("./types.ts").TgCallbackQuery) => Promise<void>;
  /**
   * If true, the heavy part of processing (RAG + sendMessage + persist
   * assistant reply) is awaited inside the handler before the HTTP
   * response. Tests use this for deterministic assertions; production
   * leaves it false so we ack Telegram in <100ms and avoid retries.
   */
  awaitProcessing?: boolean;
}

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Detected media payload of an inbound Telegram message. Stored under
 * `messages.meta_json.media` so the intake auto-detector can count
 * photo / video uploads via SQL `json_extract`. Bare flag — we do NOT
 * download files in this layer; the file_id stays in case a later
 * phase wants to fetch the bytes.
 */
type MediaInfo = {
  type: "photo" | "video" | "voice" | "document";
  file_id: string;
  file_size?: number;
  mime_type?: string;
};

/**
 * Pull media info off the Telegram message envelope. Photo arrays
 * arrive as multiple sizes — we keep the largest's file_id (Telegram
 * sorts smallest-first, last entry is original). Returns null when
 * the message has no recognised media attachment.
 */
function extractMediaInfo(m: TgMessage): MediaInfo | null {
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!;
    return {
      type: "photo",
      file_id: largest.file_id,
      ...(largest.file_size !== undefined ? { file_size: largest.file_size } : {}),
    };
  }
  if (m.video) {
    return {
      type: "video",
      file_id: m.video.file_id,
      ...(m.video.file_size !== undefined ? { file_size: m.video.file_size } : {}),
      ...(m.video.mime_type ? { mime_type: m.video.mime_type } : {}),
    };
  }
  if (m.voice) {
    return {
      type: "voice",
      file_id: m.voice.file_id,
      ...(m.voice.file_size !== undefined ? { file_size: m.voice.file_size } : {}),
      ...(m.voice.mime_type ? { mime_type: m.voice.mime_type } : {}),
    };
  }
  if (m.document) {
    return {
      type: "document",
      file_id: m.document.file_id,
      ...(m.document.file_size !== undefined ? { file_size: m.document.file_size } : {}),
      ...(m.document.mime_type ? { mime_type: m.document.mime_type } : {}),
    };
  }
  return null;
}

export function createWebhookHandler(deps: WebhookDeps): RouteHandler {
  const users = new UsersRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  const kb = new KbRepo(deps.db);
  const kbSuggestions = new KbSuggestionsRepo(deps.db);
  const styles = new StylesRepo(deps.db);
  const skills = new SkillsRepo(deps.db);
  const experiments = new ExperimentsRepo(deps.db);
  const vacancies = new VacanciesRepo(deps.db);
  const leadsRepo = new LeadsRepo(deps.db);

  return async ({ req, params }) => {
    if (params.secret !== deps.webhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }
    const headerSecret = req.headers.get(SECRET_HEADER);
    if (headerSecret !== null && headerSecret !== deps.webhookSecret) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: TgUpdate;
    try {
      update = (await req.json()) as TgUpdate;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Inline-keyboard click on a lead card in the ops chat. We dispatch
    // approve/reject via a separate handler that lives outside the
    // candidate-message pipeline (different state, different side-effects).
    if (update.callback_query && deps.onCallbackQuery) {
      try {
        await deps.onCallbackQuery(update.callback_query);
      } catch (err) {
        console.error("[webhook] callback_query handler failed:", err);
      }
      return json({ ok: true, callback: true });
    }

    const message = update.message ?? update.edited_message;
    if (!message?.from) {
      return json({ ok: true, ignored: "no-message-or-from" });
    }
    const mediaInfo = extractMediaInfo(message);
    // Accept text OR caption-bearing media OR bare media (photo/video/...).
    // Bare media without text becomes "[photo]" / "[video]" placeholders so
    // the persistence layer doesn't reject the row (text is NOT NULL).
    if (!message.text && !mediaInfo) {
      return json({ ok: true, ignored: "unsupported-message" });
    }

    // Operator relay: when a message arrives in the ops chat as a reply
    // to a lead card we previously posted, route it to the candidate
    // instead of going through the candidate-message pipeline. Phase 4
    // of the lead workflow — see src/leads/service.ts:relayFromOperator.
    if (
      deps.leadsChatId != null &&
      message.chat.id === deps.leadsChatId &&
      message.reply_to_message?.message_id !== undefined
    ) {
      const parentMessageId = message.reply_to_message.message_id;
      const lead = await leadsRepo.byOpsMessage(deps.leadsChatId, parentMessageId);
      if (lead) {
        const opUser = await users.byId(lead.user_id);
        if (opUser) {
          const service = new LeadsService({
            leads: leadsRepo,
            users,
            conversations,
            messages,
            telegram: deps.telegram,
            leadsChatId: deps.leadsChatId,
            visaChatId: deps.visaChatId ?? null,
          });
          const relayInput: Parameters<typeof service.relayFromOperator>[0] = {
            lead,
            user: opUser,
            ...(message.text || message.caption
              ? { text: message.text ?? message.caption ?? "" }
              : {}),
            ...(mediaInfo ? { media: { type: mediaInfo.type, file_id: mediaInfo.file_id } } : {}),
          };
          const ok = await service.relayFromOperator(relayInput);
          if (ok) {
            // React in the ops chat so the operator sees their relay
            // landed. Best-effort — don't fail the webhook if Telegram
            // hiccups.
            await deps.telegram
              .sendMessage({
                chatId: deps.leadsChatId,
                text: `✅ отправлено в lead #${lead.id}`,
                replyToMessageId: message.message_id,
              })
              .catch(() => undefined);
          } else {
            await deps.telegram
              .sendMessage({
                chatId: deps.leadsChatId,
                text: `⚠ relay #${lead.id}: пусто (нужен текст или медиа)`,
                replyToMessageId: message.message_id,
              })
              .catch(() => undefined);
          }
          return json({ ok: true, relayed: lead.id });
        }
      }
    }

    const tgUserId = message.from.id;
    const userMessageText = message.text ?? message.caption ?? `[${mediaInfo!.type}]`;

    const userExisting = await users.byTgId(tgUserId);
    let user = userExisting;
    if (!user && telegramOpenAccess()) {
      user = await users.create({
        tgUserId,
        tgUsername: message.from.username ?? null,
      });
      console.log(`[webhook] TELEGRAM_OPEN_ACCESS: created user tg_user_id=${tgUserId}`);
    }
    if (!user) {
      console.log(`[webhook] ignoring message from non-whitelisted tg_user_id=${tgUserId}`);
      return json({ ok: true, ignored: "not-whitelisted" });
    }

    const conv = await conversations.ensureForUser(user.id);

    // Idempotency boundary. Telegram retries webhook deliveries with the
    // same message_id when we don't ack in ~60s; we collapse retries to a
    // single row and skip all downstream work for the duplicate.
    const persisted = await messages.addUserMessageIfNew({
      conversationId: conv.id,
      tgMessageId: message.message_id,
      text: userMessageText,
      ...(mediaInfo ? { meta: { media: mediaInfo } } : {}),
    });

    if (!persisted.isNew) {
      return json({
        ok: true,
        deduped: true,
        mode: conv.mode,
        tgMessageId: message.message_id,
      });
    }

    await conversations.touch(conv.id);
    deps.onEvent?.({
      type: "user-message-persisted",
      conversationId: conv.id,
      tgUserId,
    });

    // Decide what we *intend* to do, synchronously, so the webhook
    // response can describe it for log aggregators and tests. The
    // heavy work below may send nothing (NO_CONTEXT / errors) while mode
    // stays ai, or escalates on explicit operator keywords — by then Telegram
    // has already received its 200 OK.
    const intent = decideIntent(conv.mode, userMessageText, deps.rag !== undefined);

    // Heavy work (RAG, /sendMessage, write assistant reply) is detached
    // from the HTTP response so we ack Telegram immediately. Without this
    // a slow LLM (Ollama) blows past Bot API's 60s timeout and Telegram
    // retries the same update — see migration 002 commentary.
    const processing = processInbound({
      messages,
      conversations,
      kb,
      kbSuggestions,
      styles,
      skills,
      experiments,
      users,
      vacancies,
      leads: leadsRepo,
      telegram: deps.telegram,
      leadsChatId: deps.leadsChatId ?? null,
      visaChatId: deps.visaChatId ?? null,
      rag: deps.rag,
      conv,
      user,
      chatId: message.chat.id,
      text: userMessageText,
      tgUserId,
      onEvent: deps.onEvent,
    }).catch((err) => {
      console.error("[webhook] background processing failed:", err);
    });

    if (deps.awaitProcessing) {
      await processing;
    }

    return json({ ok: true, ...intent });
  };
}

interface InboundIntent {
  mode: "ai" | "queued" | "human";
  reason?: "user-trigger" | "placeholder";
}

function decideIntent(
  currentMode: ConversationRow["mode"],
  text: string,
  ragEnabled: boolean,
): InboundIntent {
  if (currentMode === "human") return { mode: "human" };
  if (currentMode === "queued") return { mode: "queued" };
  if (containsEscalationTrigger(text)) {
    return { mode: "queued", reason: "user-trigger" };
  }
  if (!ragEnabled) return { mode: "ai", reason: "placeholder" };
  return { mode: "ai" };
}

export interface ProcessInboundDeps {
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  kb: KbRepo;
  kbSuggestions: KbSuggestionsRepo;
  styles: StylesRepo;
  skills: SkillsRepo;
  experiments: ExperimentsRepo;
  users: UsersRepo;
  vacancies: VacanciesRepo;
  leads: LeadsRepo;
  telegram: TelegramClient;
  rag?: RagDeps;
  leadsChatId?: number | null;
  visaChatId?: number | null;
  conv: ConversationRow;
  user: UserRow;
  chatId: number;
  text: string;
  tgUserId: number;
  onEvent?: (event: WebhookEvent) => void;
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
 * Fire-and-forget fact extraction after a reply. We deliberately don't await
 * this in the hot path — extraction is a second LLM call, and blocking the
 * webhook on it would double our reply latency for a memory layer that only
 * matters NEXT turn anyway. Errors are logged and swallowed.
 */
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

async function runMemoryExtraction(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag?.userMemory) return;

  const stored = await d.users.getMemory(d.user.id);
  const sinceId = stored.lastExtractedFromMsgId ?? 0;
  const all = await d.messages.listByConversation(d.conv.id, 200);
  const fresh = all.filter((m) => m.id > sinceId && (m.role === "user" || m.role === "assistant"));
  if (fresh.length === 0) return;

  // Hard-cap the slice fed to the extractor. Without this, a candidate who
  // hasn't been processed in a while (e.g. extractor was disabled then
  // re-enabled, or the cursor got reset) hands the LLM 100+ messages in one
  // call — slow, expensive, and the model loses precision past ~16 turns.
  // Trimming to the most recent N messages keeps cost bounded; older facts
  // are already accumulated in `stored.facts` from prior runs.
  const MAX_EXTRACTION_SLICE = 16;
  const slicedFresh =
    fresh.length > MAX_EXTRACTION_SLICE ? fresh.slice(-MAX_EXTRACTION_SLICE) : fresh;

  const slice = slicedFresh.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));
  // Cursor advances to the last RAW fresh message even when we trimmed —
  // skipped older messages would otherwise be re-considered next turn.
  const lastId = fresh[fresh.length - 1]!.id;

  try {
    const newFacts = await extractUserFacts({
      messages: slice,
      chat: d.rag.chat,
      existingFacts: stored.facts,
    });
    if (Object.keys(newFacts).length > 0 || lastId !== sinceId) {
      await d.users.mergeMemoryFacts(d.user.id, newFacts, lastId);
    }
    if (Object.keys(newFacts).length > 0) {
      const lead = d.leads.byUserId(d.user.id);
      if (lead) {
        const allFacts = { ...stored.facts, ...newFacts };
        const lines = Object.entries(allFacts)
          .filter(([, v]) => v?.trim())
          .map(([k, v]) => `• ${k}: ${v}`);
        if (lines.length > 0) {
          await d.leads.upsertAutoFactsNote(lead.id, `Факты из разговора:\n${lines.join("\n")}`);
        }
      }
    }
  } catch (err) {
    console.error("[memory] extraction failed:", err);
  }
}

// Conversation summary refresh thresholds. Tunable via constants here, not
// env vars — these are quality knobs not deployment knobs, and they should
// stay coupled to RECENT_HISTORY_SIZE (12) used in runRagForInbound.
const SUMMARY_START_THRESHOLD = 30; // total messages before summary kicks in
const SUMMARY_RECENT_WINDOW = 12; // last N raw messages always go in prompt
const SUMMARY_STALENESS = 8; // refresh once we drift this many msgs past last summary

/**
 * Lazy summary refresh after a reply. Skipped on short conversations to
 * avoid LLM cost when a summary wouldn't help. Otherwise:
 *   - if no summary yet → summarize all but the recent window
 *   - if summary stale (gap to current latest > SUMMARY_STALENESS) → refresh
 *     by passing the previous summary + new chunk to the summarizer (refining,
 *     not re-summarizing the whole history)
 *
 * Fire-and-forget — errors logged, current turn already replied.
 */
/**
 * After each candidate message, refresh the lead's intake fields
 * (text-extracted via LLM + media counts via SQL) and auto-promote
 * when the 7-item checklist is complete. Idempotent — re-running on
 * the same conversation just re-merges the same fields.
 *
 * Promotion rules:
 *   - if no lead exists yet: create one in intake_pending
 *   - update lead.intake_json with the merged IntakeFields
 *   - when isIntakeComplete && state == intake_pending:
 *       transition → intake_complete
 *       post lead card to LEADS_CHAT_ID (if configured)
 *       send "ждите, отправили запрос в клуб" to candidate
 *
 * Skips entirely when RAG isn't configured (no LLM = no extraction).
 */
async function runIntakeUpdate(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag) return;

  // When an ops chat is configured, auto-create a lead for every candidate
  // so intake tracking kicks in from the first message. Without an ops chat,
  // only extract intake for leads that were manually promoted by the operator
  // (so the admin UI fields stay up-to-date even without LEADS_CHAT_ID).
  let lead = await d.leads.byUserId(d.user.id);
  if (!lead) {
    if (d.leadsChatId == null) return;
    lead = await d.leads.ensureForUser(d.user.id);
  }

  // Stop updating once the operator has made a final decision — approved,
  // rejected, submitted, or lost leads are operator-owned and extraction
  // could overwrite manual edits. intake_pending and intake_complete are
  // still "in progress" so we keep extracting.
  if (lead.state !== "intake_pending" && lead.state !== "intake_complete") return;

  const recent = await d.messages.recentForContext(d.conv.id, 30);
  const messagesForLlm = recent
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    }));

  const mediaCounts = await d.messages.countMediaForConversation(d.conv.id);

  const existing = parseIntakeJson(lead.intake_json);
  const intake = await extractIntake({
    messages: messagesForLlm,
    chat: d.rag.chat,
    mediaCounts,
    ...(existing ? { existingIntake: existing } : {}),
  });

  await d.leads.setIntake(lead.id, JSON.stringify(intake));

  // Auto-promote + post ops card only when all conditions met:
  // 1. intake is complete, 2. lead was in intake_pending (not already promoted),
  // 3. an ops chat is configured to post the card to.
  if (!isIntakeComplete(intake) || lead.state !== "intake_pending" || d.leadsChatId == null) return;

  const promoted = await d.leads.setState(lead.id, "intake_complete");
  if (!promoted) return;

  const service = new LeadsService({
    leads: d.leads,
    users: d.users,
    conversations: d.conversations,
    messages: d.messages,
    telegram: d.telegram,
    leadsChatId: d.leadsChatId ?? null,
    visaChatId: d.visaChatId ?? null,
  });
  const recentForCard = recent
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "human")
    .map((m) => ({ role: m.role, text: m.text }));
  const withCard = await service.postCardToOpsChat({
    lead: promoted,
    user: d.user,
    recentMessages: recentForCard,
  });
  await service.sendAwaitingApprovalNote({ user: d.user });
  console.log(
    `[leads] auto-promoted lead ${promoted.id} (user ${d.user.id}) on intake completion` +
      (withCard.ops_message_id ? ` (card msg=${withCard.ops_message_id})` : ""),
  );
}

function parseIntakeJson(raw: string | null): IntakeFields | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as IntakeFields;
  } catch {
    return undefined;
  }
}

/**
 * After each candidate message during the docs collection phase,
 * extract structured visa-application fields from the conversation
 * and accumulate them in `lead.visa_docs_json`. Operator's manual
 * edits via PATCH /admin/api/leads/:id/visa-docs are preserved
 * because the LLM extractor only returns NEWLY-mentioned fields
 * (existing values stay intact when not re-mentioned).
 *
 * Same gating as runIntakeUpdate: requires LEADS_CHAT_ID configured
 * (without an ops chat, the parsing is busy work). Skipped when the
 * lead isn't in `docs_pending` — operator owns the lead in approved/
 * docs_complete/submitted/rejected states.
 */
async function runVisaDocsUpdate(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag) return;
  if (d.leadsChatId == null) return;

  const lead = await d.leads.byUserId(d.user.id);
  if (!lead) return;
  if (lead.state !== "docs_pending") return;

  // Read recent messages from the conversation. The visa form is
  // typically sent by the candidate as one or two long messages, so
  // 30 turns of context is plenty (and a hard upper bound on cost).
  const recent = await d.messages.recentForContext(d.conv.id, 30);
  const messagesForLlm = recent
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    }));

  const existing = parseVisaDocsJson(lead.visa_docs_json);
  const merged = await extractVisaDocs({
    messages: messagesForLlm,
    chat: d.rag.chat,
    ...(existing ? { existingDocs: existing } : {}),
  });

  // Only persist when the merge produced any change at all — avoids
  // bumping updated_at + WS noise on every silent turn.
  const before = JSON.stringify(existing ?? {});
  const after = JSON.stringify(merged);
  if (before !== after) {
    await d.leads.setVisaDocs(lead.id, after);
  }
}

function parseVisaDocsJson(raw: string | null): VisaFields | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as VisaFields;
  } catch {
    return undefined;
  }
}

async function runConversationSummaryRefresh(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag?.conversationSummary) return;

  const all = await d.messages.listByConversation(d.conv.id, 500);
  if (all.length < SUMMARY_START_THRESHOLD) return;

  const stored = await d.conversations.getSummary(d.conv.id);
  const _latestId = all[all.length - 1]!.id;
  const lastSummarizedId = stored?.summarizedThroughMsgId ?? 0;

  // Anything strictly older than the recent window is fair game for the
  // summarizer. We add `+1` margin so the just-replied turn doesn't get
  // pulled in mid-stride.
  const summarizableTail = all.slice(0, all.length - SUMMARY_RECENT_WINDOW);
  if (summarizableTail.length === 0) return;

  const lastSummarizable = summarizableTail[summarizableTail.length - 1]!;
  const gap = lastSummarizable.id - lastSummarizedId;
  if (stored && gap < SUMMARY_STALENESS) return; // not stale enough yet

  // When refreshing: only feed the slice that's NEW since the previous
  // summary cutoff. Combined with `previousSummary` parameter the model
  // refines instead of re-reading everything.
  const newSlice = summarizableTail.filter(
    (m) =>
      m.id > lastSummarizedId &&
      (m.role === "user" || m.role === "assistant" || m.role === "human"),
  );
  if (newSlice.length === 0) return;

  const messages = newSlice.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));

  try {
    const summary = await summarizeConversation({
      messagesToSummarize: messages,
      chat: d.rag.chat,
      ...(stored?.summary ? { previousSummary: stored.summary } : {}),
    });
    if (summary.trim().length > 0) {
      await d.conversations.setSummary(d.conv.id, summary, lastSummarizable.id);
    }
    console.log(
      `[summary] conv=${d.conv.id} refreshed through msg=${lastSummarizable.id} (gap=${gap}, refined=${stored !== null})`,
    );
  } catch (err) {
    console.error("[summary] refresh failed:", err);
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
    } catch (err) {
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
