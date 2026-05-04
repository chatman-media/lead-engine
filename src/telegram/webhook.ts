import type { Database } from "bun:sqlite";

import { ConversationsRepo, type ConversationRow } from "../db/repos/conversations.ts";
import { ExperimentsRepo, parseAllocationToExperiment } from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { UsersRepo, type UserRow } from "../db/repos/users.ts";
import { telegramOpenAccess } from "../config.ts";
import { json, type RouteHandler } from "../router.ts";
import {
  answerWithRag,
  NO_CONTEXT_MARKER,
  type AnswerResult,
  type Persona,
} from "../rag/answer.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import { extractUserFacts } from "../rag/extract-user-facts.ts";
import { pickVariant } from "../sales/ab-router.ts";
import { classifyStage } from "../sales/stage-classifier.ts";
import { nextStage } from "../sales/stage-router.ts";
import { FUNNEL_STAGES, type FunnelStage, type Style } from "../sales/types.ts";
import type { TelegramClient } from "./client.ts";
import type { TgUpdate } from "./types.ts";
import { containsEscalationTrigger } from "./escalation.ts";

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
  topK?: number;
  /** sqlite-vec L2 distance threshold; hits above are dropped before LLM. */
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
  | { type: "conversation-mode-changed"; conversationId: number };

export interface WebhookDeps {
  db: Database;
  telegram: TelegramClient;
  webhookSecret: string;
  /** Optional: when present, bot answers via RAG. Otherwise it sends a stub
   *  reply (useful when no LLM keys are configured yet). */
  rag?: RagDeps;
  /** Single sink for all dialog-state changes the webhook produces. The
   *  HTTP layer fans this out to AdminBus / WS subscribers. */
  onEvent?: (event: WebhookEvent) => void;
  /**
   * If true, the heavy part of processing (RAG + sendMessage + persist
   * assistant reply) is awaited inside the handler before the HTTP
   * response. Tests use this for deterministic assertions; production
   * leaves it false so we ack Telegram in <100ms and avoid retries.
   */
  awaitProcessing?: boolean;
}

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export function createWebhookHandler(deps: WebhookDeps): RouteHandler {
  const users = new UsersRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  const kb = new KbRepo(deps.db);
  const styles = new StylesRepo(deps.db);
  const experiments = new ExperimentsRepo(deps.db);

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

    const message = update.message ?? update.edited_message;
    if (!message || !message.from || !message.text) {
      return json({ ok: true, ignored: "no-text-message" });
    }

    const tgUserId = message.from.id;
    const userMessageText = message.text;

    const userExisting = users.byTgId(tgUserId);
    let user = userExisting;
    if (!user && telegramOpenAccess()) {
      user = users.create({
        tgUserId,
        tgUsername: message.from.username ?? null,
      });
      console.log(
        `[webhook] TELEGRAM_OPEN_ACCESS: created user tg_user_id=${tgUserId}`,
      );
    }
    if (!user) {
      console.log(
        `[webhook] ignoring message from non-whitelisted tg_user_id=${tgUserId}`,
      );
      return json({ ok: true, ignored: "not-whitelisted" });
    }

    const conv = conversations.ensureForUser(user.id);

    // Idempotency boundary. Telegram retries webhook deliveries with the
    // same message_id when we don't ack in ~60s; we collapse retries to a
    // single row and skip all downstream work for the duplicate.
    const persisted = messages.addUserMessageIfNew({
      conversationId: conv.id,
      tgMessageId: message.message_id,
      text: userMessageText,
    });

    if (!persisted.isNew) {
      return json({
        ok: true,
        deduped: true,
        mode: conv.mode,
        tgMessageId: message.message_id,
      });
    }

    conversations.touch(conv.id);
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
      styles,
      experiments,
      users,
      telegram: deps.telegram,
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

interface ProcessInboundDeps {
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  kb: KbRepo;
  styles: StylesRepo;
  experiments: ExperimentsRepo;
  users: UsersRepo;
  telegram: TelegramClient;
  rag?: RagDeps;
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
function resolveStyle(d: {
  rag?: RagDeps;
  conv: ConversationRow;
  user: UserRow;
  styles: StylesRepo;
  experiments: ExperimentsRepo;
  conversations: ConversationsRepo;
}): Style | null {
  // Priority 1: env force-override.
  if (d.rag?.style) return d.rag.style;

  // Priority 2: existing assignment.
  if (d.conv.style_id != null) {
    const row = d.styles.byId(d.conv.style_id);
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
  const running = d.experiments.getRunning();
  if (!running) return null;

  const experiment = parseAllocationToExperiment(running);
  if (!experiment) {
    console.warn(
      `[sales] experiment ${running.slug} has malformed allocation_json; skipping`,
    );
    return null;
  }

  const variantSlug = pickVariant(experiment, d.user.tg_user_id);
  const variantRow = d.styles.bySlug(variantSlug);
  if (!variantRow) {
    console.warn(
      `[sales] experiment ${running.slug} allocates to slug "${variantSlug}" that's missing/inactive in styles table`,
    );
    return null;
  }

  try {
    const style = d.styles.parseRow(variantRow);
    d.conversations.assignStyle(d.conv.id, variantRow.id, running.id);
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
): Promise<{ result: AnswerResult; stage?: FunnelStage }> {
  if (!d.rag) throw new Error("runRagForInbound: rag deps required");

  const style = resolveStyle({
    rag: d.rag,
    conv: d.conv,
    user: d.user,
    styles: d.styles,
    experiments: d.experiments,
    conversations: d.conversations,
  });

  // Funnel-stage routing. Default is the regex router (sub-ms, predictable).
  // When `rag.stageClassifier === "llm"` we delegate to an LLM-based
  // classifier that falls back to regex on low confidence / parse errors.
  // Persist the resolved stage on the conversation so it survives restarts.
  let stage: FunnelStage | undefined;
  let includeFewShot: boolean | undefined;
  if (style) {
    const userMessageCount = d.messages
      .listByConversation(d.conv.id)
      .filter((m) => m.role === "user").length;
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

    d.conversations.setCurrentStage(d.conv.id, stage);
    includeFewShot = userMessageCount <= 1;
  }

  // Conversation history — без неё каждый turn идёт изолированно и модель
  // отвечает на «все» / «расскажи подробнее» наугад (без знания о чём была
  // прошлая реплика). Берём 12 последних сообщений и КИДАЕМ только тот
  // user-row, который мы только что вставили (он же в d.text), чтобы не
  // дублировать его в финальном prompt.
  const recent = d.messages.recentForContext(d.conv.id, 12);
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
  const userFacts = d.rag.userMemory
    ? d.users.getMemory(d.user.id).facts
    : undefined;

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
    ...(d.rag.queryRewrite ? { rewriteQueryBeforeRetrieval: true } : {}),
    ...(d.rag.reflect ? { reflect: true } : {}),
    ...(d.rag.hybridSearch ? { hybridSearch: true } : {}),
  });
  return { result, stage };
}

/**
 * Fire-and-forget fact extraction after a reply. We deliberately don't await
 * this in the hot path — extraction is a second LLM call, and blocking the
 * webhook on it would double our reply latency for a memory layer that only
 * matters NEXT turn anyway. Errors are logged and swallowed.
 */
async function runMemoryExtraction(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag?.userMemory) return;

  const stored = d.users.getMemory(d.user.id);
  const sinceId = stored.lastExtractedFromMsgId ?? 0;
  const all = d.messages.listByConversation(d.conv.id, 200);
  const fresh = all.filter((m) => m.id > sinceId && (m.role === "user" || m.role === "assistant"));
  if (fresh.length === 0) return;

  const slice = fresh.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));
  const lastId = fresh[fresh.length - 1]!.id;

  try {
    const newFacts = await extractUserFacts({
      messages: slice,
      chat: d.rag.chat,
      existingFacts: stored.facts,
    });
    if (Object.keys(newFacts).length > 0 || lastId !== sinceId) {
      d.users.mergeMemoryFacts(d.user.id, newFacts, lastId);
    }
  } catch (err) {
    console.error("[memory] extraction failed:", err);
  }
}

async function processInbound(d: ProcessInboundDeps): Promise<void> {
  const reply = async (text: string, meta?: unknown, stage?: FunnelStage) => {
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
    d.messages.add({
      conversationId: d.conv.id,
      role: "assistant",
      text,
      tgMessageId,
      meta,
      ...(stage !== undefined ? { stage } : {}),
    });
    d.conversations.touch(d.conv.id);
    d.onEvent?.({
      type: "assistant-replied",
      conversationId: d.conv.id,
      tgUserId: d.tgUserId,
    });
  };

  if (d.conv.mode === "human") {
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
      d.conversations.setMode(d.conv.id, "ai");
      d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
      await reply(result.text, { used_chunk_ids: result.usedChunkIds }, stage);
      return;
    }
    return;
  }

  if (containsEscalationTrigger(d.text)) {
    d.conversations.setMode(d.conv.id, "queued");
    d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
    return;
  }

  if (!d.rag) {
    return;
  }

  const { result, stage } = await runRagForInbound(d);

  if (result.text === NO_CONTEXT_MARKER) {
    // Run memory extraction even on silent turns — the user message itself
    // may carry persistent facts ("I'm Anya, 25, from Moscow") that we want
    // remembered regardless of whether RAG could answer.
    await runMemoryExtraction(d);
    return;
  }

  await reply(result.text, { used_chunk_ids: result.usedChunkIds }, stage);
  await runMemoryExtraction(d);
}
