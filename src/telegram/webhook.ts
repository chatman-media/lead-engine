import type { Database } from "bun:sqlite";

import { ConversationsRepo } from "../db/repos/conversations.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { json, type RouteHandler } from "../router.ts";
import { answerWithRag, NO_CONTEXT_MARKER } from "../rag/answer.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import type { TelegramClient } from "./client.ts";
import type { TgUpdate } from "./types.ts";
import { containsEscalationTrigger } from "./escalation.ts";

export interface RagDeps {
  embedder: EmbeddingClient;
  chat: ChatClient;
  topK?: number;
}

export interface WebhookDeps {
  db: Database;
  telegram: TelegramClient;
  webhookSecret: string;
  /** Optional: when present, bot answers via RAG. Otherwise it sends a stub
   *  reply (useful when no LLM keys are configured yet). */
  rag?: RagDeps;
  onMessagePersisted?: (input: {
    conversationId: number;
    userId: number;
    tgUserId: number;
  }) => void;
}

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const ESCALATION_REPLY =
  "Спасибо за сообщение. Передал ваш вопрос оператору — он скоро ответит.";
const QUEUED_REPLY =
  "Принято. Скоро ответит оператор.";
const PLACEHOLDER_REPLY = "Принято. Готовлю ответ…";

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
    messages.add({
      conversationId: conv.id,
      role: "user",
      text: message.text,
      tgMessageId: message.message_id,
    });
    conversations.touch(conv.id);

    deps.onMessagePersisted?.({
      conversationId: conv.id,
      userId: user.id,
      tgUserId: message.from.id,
    });

    if (conv.mode === "human") {
      return json({ ok: true, mode: "human" });
    }

    if (conv.mode === "queued") {
      await replyAndPersist(QUEUED_REPLY);
      return json({ ok: true, mode: "queued" });
    }

    if (containsEscalationTrigger(message.text)) {
      conversations.setMode(conv.id, "queued");
      await replyAndPersist(ESCALATION_REPLY);
      return json({ ok: true, mode: "queued", reason: "user-trigger" });
    }

    if (!deps.rag) {
      await replyAndPersist(PLACEHOLDER_REPLY);
      return json({ ok: true, mode: "ai", placeholder: true });
    }

    const result = await answerWithRag({
      question: message.text,
      kb,
      embedder: deps.rag.embedder,
      chat: deps.rag.chat,
      topK: deps.rag.topK ?? 5,
    });

    if (result.text === NO_CONTEXT_MARKER) {
      conversations.setMode(conv.id, "queued");
      await replyAndPersist(ESCALATION_REPLY);
      return json({ ok: true, mode: "queued", reason: "no-context" });
    }

    await replyAndPersist(result.text, { used_chunk_ids: result.usedChunkIds });
    return json({ ok: true, mode: "ai" });

    async function replyAndPersist(text: string, meta?: unknown) {
      const sent = await deps.telegram.sendMessage({
        chatId: message!.chat.id,
        text,
      });
      messages.add({
        conversationId: conv.id,
        role: "assistant",
        text,
        tgMessageId: sent.message_id,
        meta,
      });
    }
  };
}
