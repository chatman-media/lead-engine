import type { Database } from "bun:sqlite";

import { ConversationsRepo, type ConversationRow } from "../db/repos/conversations.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { UsersRepo, type UserRow } from "../db/repos/users.ts";
import { json, type RouteHandler } from "../router.ts";
import { answerWithRag, NO_CONTEXT_MARKER, type Persona } from "../rag/answer.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import type { TelegramClient } from "./client.ts";
import type { TgUpdate } from "./types.ts";
import { containsEscalationTrigger } from "./escalation.ts";

export interface RagDeps {
  embedder: EmbeddingClient;
  chat: ChatClient;
  topK?: number;
  /** sqlite-vec L2 distance threshold; hits above are dropped before LLM. */
  maxDistance?: number;
  /** How the bot identifies itself in answers (name, role, company). */
  persona?: Persona;
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

/**
 * Fallback replies — sent verbatim, in Russian, in the persona of a real
 * human manager. Must NOT mention «оператор», «бот», «ассистент»,
 * «искусственный интеллект» — иначе сломаем легенду «живого человека».
 */
export const ESCALATION_REPLY =
  "Секунду, уточню по этому вопросу и напишу.";
export const QUEUED_REPLY =
  "Секунду, я ещё смотрю — отвечу совсем скоро.";
export const PLACEHOLDER_REPLY = "Секунду, отвечу через минуту.";

export function createWebhookHandler(deps: WebhookDeps): RouteHandler {
  const users = new UsersRepo(deps.db);
  const conversations = new ConversationsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  const kb = new KbRepo(deps.db);

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

    const user = users.byTgId(message.from.id);
    if (!user) {
      console.log(
        `[webhook] ignoring message from non-whitelisted tg_user_id=${message.from.id}`,
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
      text: message.text,
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
      tgUserId: message.from.id,
    });

    // Decide what we *intend* to do, synchronously, so the webhook
    // response can describe it for log aggregators and tests. The
    // heavy work below may further escalate (NO_CONTEXT → queued) but
    // by then Telegram has already received its 200 OK.
    const intent = decideIntent(conv.mode, message.text, deps.rag !== undefined);

    // Heavy work (RAG, /sendMessage, write assistant reply) is detached
    // from the HTTP response so we ack Telegram immediately. Without this
    // a slow LLM (Ollama) blows past Bot API's 60s timeout and Telegram
    // retries the same update — see migration 002 commentary.
    const processing = processInbound({
      messages,
      conversations,
      kb,
      telegram: deps.telegram,
      rag: deps.rag,
      conv,
      user,
      chatId: message.chat.id,
      text: message.text,
      tgUserId: message.from.id,
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
  telegram: TelegramClient;
  rag?: RagDeps;
  conv: ConversationRow;
  user: UserRow;
  chatId: number;
  text: string;
  tgUserId: number;
  onEvent?: (event: WebhookEvent) => void;
}

async function processInbound(d: ProcessInboundDeps): Promise<void> {
  const reply = async (text: string, meta?: unknown) => {
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
    await reply(QUEUED_REPLY);
    return;
  }

  if (containsEscalationTrigger(d.text)) {
    d.conversations.setMode(d.conv.id, "queued");
    d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
    await reply(ESCALATION_REPLY);
    return;
  }

  if (!d.rag) {
    await reply(PLACEHOLDER_REPLY);
    return;
  }

  const result = await answerWithRag({
    question: d.text,
    kb: d.kb,
    embedder: d.rag.embedder,
    chat: d.rag.chat,
    topK: d.rag.topK ?? 5,
    maxDistance: d.rag.maxDistance,
    persona: d.rag.persona,
  });

  if (result.text === NO_CONTEXT_MARKER) {
    d.conversations.setMode(d.conv.id, "queued");
    d.onEvent?.({ type: "conversation-mode-changed", conversationId: d.conv.id });
    await reply(ESCALATION_REPLY);
    return;
  }

  await reply(result.text, { used_chunk_ids: result.usedChunkIds });
}
