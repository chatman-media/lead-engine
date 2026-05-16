#!/usr/bin/env bun
/**
 * Local userbot — handles incoming messages on Alina's account + admin queue.
 * Uses a connect→sweep→disconnect cycle (8s window) to avoid the gramJS
 * TIMEOUT bug that crashes the process when staying connected indefinitely.
 *
 * Run: bun scripts/userbot-local.ts
 * Needs: TELEGRAM_API_ID, TELEGRAM_API_HASH, USERBOT_SESSION, DATABASE_URL
 *        + LLM keys (OPENROUTER_API_KEY or OPENAI_API_KEY)
 */

import { TelegramClient as GramjsClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { config, telegramOpenAccess } from "../src/config.ts";
import { sql } from "../src/db/postgres.ts";
import { ConversationsRepo } from "../src/db/repos/conversations.ts";
import { ExperimentsRepo } from "../src/db/repos/experiments.ts";
import { KbRepo } from "../src/db/repos/kb.ts";
import { KbSuggestionsRepo } from "../src/db/repos/kb-suggestions.ts";
import { LeadsRepo } from "../src/db/repos/leads.ts";
import { MessagesRepo } from "../src/db/repos/messages.ts";
import { SkillsRepo } from "../src/db/repos/skills.ts";
import { StylesRepo } from "../src/db/repos/styles.ts";
import { dequeuePending, markFailed, markSent } from "../src/db/repos/userbot-send-queue.ts";
import { loadUserbotSession } from "../src/db/repos/userbot-session.ts";
import { UsersRepo } from "../src/db/repos/users.ts";
import { VacanciesRepo } from "../src/db/repos/vacancies.ts";
import { OpenAIChatClient } from "../src/rag/chat.ts";
import { NullEmbeddingClient, OpenAIEmbeddingClient } from "../src/rag/embed.ts";
import { OllamaChatClient } from "../src/rag/providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "../src/rag/providers/ollama-embed.ts";
import { OpenRouterChatClient } from "../src/rag/providers/openrouter-chat.ts";
import type { Style } from "../src/sales/types.ts";
import type { TelegramClient } from "../src/telegram/client.ts";
import type { TgReplyMarkup, TgSendMessageResult } from "../src/telegram/types.ts";
import type { RagDeps } from "../src/telegram/webhook.ts";
import { processInbound } from "../src/telegram/webhook.ts";

// ── RAG setup ──────────────────────────────────────────────────────────────
let rag: RagDeps | undefined;

if (config.llm.provider === "openrouter" ? !!config.openrouter.apiKey : !!config.openai.apiKey) {
  const chat =
    config.llm.provider === "ollama"
      ? new OllamaChatClient({ host: config.ollama.host, model: config.ollama.chatModel })
      : config.llm.provider === "openrouter"
        ? new OpenRouterChatClient({
            apiKey: config.openrouter.apiKey,
            baseUrl: config.openrouter.baseUrl,
            model: config.openrouter.chatModel,
          })
        : new OpenAIChatClient({
            apiKey: config.openai.apiKey,
            baseUrl: config.openai.baseUrl,
            model: config.openai.chatModel,
          });

  const embedApiKey = config.embed.apiKey ?? config.openai.apiKey;
  const embedder =
    config.llm.embeddingProvider === "ollama"
      ? new OllamaEmbeddingClient({
          host: config.ollama.host,
          model: config.ollama.embeddingModel,
          dim: config.ollama.embeddingDim,
        })
      : embedApiKey
        ? new OpenAIEmbeddingClient({
            apiKey: embedApiKey,
            baseUrl: config.embed.baseUrl ?? config.openai.baseUrl,
            model: config.embed.model ?? config.openai.embeddingModel,
            dim: config.embed.dim ?? config.openai.embeddingDim,
          })
        : new NullEmbeddingClient(config.embed.dim ?? config.openai.embeddingDim);

  const stylesRepo = new StylesRepo(sql);
  const styleRow = config.sales.forcedStyleSlug
    ? await stylesRepo.bySlug(config.sales.forcedStyleSlug)
    : undefined;
  const style = styleRow ? (stylesRepo.parseRow(styleRow) as Style) : undefined;

  rag = {
    chat,
    embedder,
    persona: config.persona,
    topK: config.rag.topK,
    maxDistance: config.rag.maxDistance,
    ...(style ? { style } : {}),
    stageClassifier: config.sales.stageClassifier,
    userMemory: config.rag.userMemory,
    queryRewrite: config.rag.queryRewrite,
    reflect: config.rag.reflect,
    hybridSearch: config.rag.hybridSearch,
    conversationSummary: config.rag.conversationSummary,
    topicRouting: config.rag.topicRouting,
    booksPriority: config.rag.booksPriority,
  };
  console.log("[userbot-local] RAG ready");
} else {
  console.warn("[userbot-local] No LLM keys — RAG disabled, only draining send queue");
}

// ── DB repos ───────────────────────────────────────────────────────────────
const users = new UsersRepo(sql);
const conversations = new ConversationsRepo(sql);
const messages = new MessagesRepo(sql);
const kb = new KbRepo(sql);
const kbSuggestions = new KbSuggestionsRepo(sql);
const styles = new StylesRepo(sql);
const skills = new SkillsRepo(sql);
const experiments = new ExperimentsRepo(sql);
const vacancies = new VacanciesRepo(sql);
const leads = new LeadsRepo(sql);

const sessionStr = process.env.USERBOT_SESSION || (await loadUserbotSession(sql));

function makeSender(
  replyFn: (text: string) => Promise<{ id: number }>,
  chatId: number,
): TelegramClient {
  return {
    async sendMessage(input: {
      chatId: number | string;
      text: string;
      parseMode?: "MarkdownV2" | "HTML" | "Markdown";
      replyMarkup?: TgReplyMarkup;
      disableWebPagePreview?: boolean;
      replyToMessageId?: number;
    }) {
      const sent = await replyFn(input.text);
      return { message_id: sent.id, chat: { id: chatId, type: "private" } } as TgSendMessageResult;
    },
    getMe: () => {
      throw new Error("n/a");
    },
    getFile: () => {
      throw new Error("n/a");
    },
    downloadFile: () => {
      throw new Error("n/a");
    },
    sendPhoto: () => {
      throw new Error("n/a");
    },
    sendVideo: () => {
      throw new Error("n/a");
    },
    sendDocument: () => {
      throw new Error("n/a");
    },
    editMessageText: () => {
      throw new Error("n/a");
    },
    answerCallbackQuery: () => {
      throw new Error("n/a");
    },
    sendChatAction: () => {
      throw new Error("n/a");
    },
    setWebhook: () => {
      throw new Error("n/a");
    },
    deleteWebhook: () => {
      throw new Error("n/a");
    },
    getWebhookInfo: () => {
      throw new Error("n/a");
    },
  } as unknown as TelegramClient;
}

// ── One cycle: connect → sweep + drain → disconnect ────────────────────────
async function runCycle(iteration: number): Promise<void> {
  const client = new GramjsClient(
    new StringSession(sessionStr),
    config.userbot.apiId,
    config.userbot.apiHash,
    {
      connectionRetries: 3,
      retryDelay: 1000,
    },
  );

  try {
    await client.connect();
  } catch (err) {
    console.error(`[userbot-local] #${iteration} connect failed:`, (err as Error).message);
    return;
  }

  const inboundTasks: Promise<void>[] = [];

  // ── Sweep unread dialogs (incoming messages) ──
  if (rag) {
    try {
      const dialogs = await client.getDialogs({ limit: 100 });
      for (const dialog of dialogs) {
        if (!dialog.unreadCount || dialog.unreadCount === 0) continue;
        if (!(dialog.entity && "className" in dialog.entity && dialog.entity.className === "User"))
          continue;
        const tgUserId = Number(
          "id" in dialog.entity ? (dialog.entity.id?.toString() ?? "0") : "0",
        );
        if (!tgUserId) continue;

        let msgs: Awaited<ReturnType<typeof client.getMessages>>;
        try {
          msgs = await client.getMessages(dialog.entity, {
            limit: Math.min(dialog.unreadCount, 20),
          });
        } catch {
          continue;
        }

        for (const msg of [...msgs].reverse()) {
          if (msg.out) continue;
          const text = msg.text ?? "";
          if (!text.trim()) continue;

          const userExisting = await users.byTgId(tgUserId);
          let user = userExisting;
          if (!user && telegramOpenAccess()) {
            user = await users.create({ tgUserId, tgUsername: null });
          }
          if (!user) continue;

          const conv = await conversations.ensureForUser(user.id, "userbot");
          const persisted = await messages.addUserMessageIfNew({
            conversationId: conv.id,
            tgMessageId: msg.id,
            text,
          });
          if (!persisted.isNew) continue;

          await conversations.touch(conv.id);
          console.log(
            `[userbot-local] #${iteration} incoming msg tg_user_id=${tgUserId}: "${text.slice(0, 60)}"`,
          );

          const entity = dialog.entity;
          const telegram = makeSender(
            (t) =>
              client
                .sendMessage(entity, { message: t })
                .then((s) => ({ id: (s as { id: number }).id ?? 0 })),
            tgUserId,
          );

          inboundTasks.push(
            processInbound({
              messages,
              conversations,
              kb,
              kbSuggestions,
              styles,
              skills,
              experiments,
              users,
              vacancies,
              leads,
              telegram,
              leadsChatId: null,
              visaChatId: null,
              rag,
              conv,
              user,
              chatId: tgUserId,
              text,
              tgUserId,
            }).catch((err) => {
              console.error("[userbot-local] processInbound failed:", err);
            }),
          );
        }

        await client.markAsRead(dialog.entity).catch(() => {});
      }
    } catch (err) {
      console.warn(`[userbot-local] #${iteration} sweep failed:`, (err as Error).message);
    }
  }

  // Wait for all RAG replies before draining queue (need connection alive)
  if (inboundTasks.length > 0) {
    console.log(`[userbot-local] #${iteration} processing ${inboundTasks.length} message(s)...`);
    await Promise.allSettled(inboundTasks);
  }

  // ── Drain admin send queue ──
  try {
    const pending = await dequeuePending(sql);
    for (const row of pending) {
      try {
        let peer: Awaited<ReturnType<typeof client.getInputEntity>>;
        try {
          peer = await client.getInputEntity(Number(row.tg_user_id));
        } catch {
          const [u] = await sql<
            { tg_username: string | null }[]
          >`SELECT tg_username FROM users WHERE tg_user_id = ${row.tg_user_id} LIMIT 1`;
          if (!u?.tg_username) throw new Error(`no entity for tg_user_id=${row.tg_user_id}`);
          peer = await client.getInputEntity(`@${u.tg_username}`);
        }
        await client.sendMessage(peer, { message: row.text });
        await markSent(sql, row.id);
        console.log(
          `[userbot-local] #${iteration} queue sent id=${row.id} → tg_user_id=${row.tg_user_id}`,
        );
      } catch (err) {
        console.error(
          `[userbot-local] #${iteration} queue failed id=${row.id}:`,
          (err as Error).message,
        );
        await markFailed(sql, row.id, (err as Error).message).catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[userbot-local] #${iteration} queue drain failed:`, (err as Error).message);
  }

  await client.disconnect().catch(() => {});
}

// ── Main loop ──────────────────────────────────────────────────────────────
console.log("[userbot-local] started — cycling every 5s (sweep incoming + drain queue)");

let iteration = 0;
while (true) {
  iteration++;
  await runCycle(iteration).catch((err) => {
    console.error(`[userbot-local] cycle #${iteration} error:`, (err as Error).message);
  });
  await Bun.sleep(5_000);
}
