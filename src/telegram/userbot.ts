import type { Database } from "bun:sqlite";
import { TelegramClient as GramjsClient } from "telegram";
import { NewMessage } from "telegram/events";
import { StringSession } from "telegram/sessions";
import { telegramOpenAccess } from "../config.ts";
import { ConversationsRepo } from "../db/repos/conversations.ts";
import { ExperimentsRepo } from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { KbSuggestionsRepo } from "../db/repos/kb-suggestions.ts";
import { LeadsRepo } from "../db/repos/leads.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { SkillsRepo } from "../db/repos/skills.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { loadUserbotSession, saveUserbotSession } from "../db/repos/userbot-session.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { VacanciesRepo } from "../db/repos/vacancies.ts";
import type { TelegramClient } from "./client.ts";
import type { TgReplyMarkup, TgSendMessageResult } from "./types.ts";
import type { RagDeps } from "./webhook.ts";
import { processInbound } from "./webhook.ts";

export interface UserbotDeps {
  db: Database;
  apiId: number;
  apiHash: string;
  rag?: RagDeps;
  onEvent?: Parameters<typeof processInbound>[0]["onEvent"];
}

/**
 * Build a minimal TelegramClient-shaped sender that routes `sendMessage`
 * through the already-connected gramjs client. Only `sendMessage` is called
 * when leads are disabled (leadsChatId = null), which is always the case for
 * the userbot path — all other methods are intentionally left as stubs.
 */
function makeUserbotSender(gramjs: GramjsClient): TelegramClient {
  return {
    async sendMessage(input: {
      chatId: number | string;
      text: string;
      parseMode?: "MarkdownV2" | "HTML" | "Markdown";
      replyMarkup?: TgReplyMarkup;
      disableWebPagePreview?: boolean;
      replyToMessageId?: number;
    }) {
      const msg = await gramjs.sendMessage(input.chatId as number, { message: input.text });
      return {
        message_id: msg.id,
        chat: { id: Number(input.chatId), type: "private" },
      } as TgSendMessageResult;
    },
    getMe: () => {
      throw new Error("getMe not available in userbot mode");
    },
    getFile: () => {
      throw new Error("getFile not available in userbot mode");
    },
    downloadFile: () => {
      throw new Error("downloadFile not available in userbot mode");
    },
    sendPhoto: () => {
      throw new Error("sendPhoto not available in userbot mode");
    },
    sendVideo: () => {
      throw new Error("sendVideo not available in userbot mode");
    },
    sendDocument: () => {
      throw new Error("sendDocument not available in userbot mode");
    },
    editMessageText: () => {
      throw new Error("editMessageText not available in userbot mode");
    },
    answerCallbackQuery: () => {
      throw new Error("answerCallbackQuery not available in userbot mode");
    },
    sendChatAction: () => {
      throw new Error("sendChatAction not available in userbot mode");
    },
    setWebhook: () => {
      throw new Error("setWebhook not available in userbot mode");
    },
    deleteWebhook: () => {
      throw new Error("deleteWebhook not available in userbot mode");
    },
    getWebhookInfo: () => {
      throw new Error("getWebhookInfo not available in userbot mode");
    },
  } as unknown as TelegramClient;
}

export async function startUserbot(deps: UserbotDeps): Promise<GramjsClient> {
  const { db, apiId, apiHash, rag, onEvent } = deps;

  const sessionString = loadUserbotSession(db);
  const session = new StringSession(sessionString);

  const client = new GramjsClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();

  // Persist refreshed session after connect so it survives restarts.
  const newSession = client.session.save() as unknown as string;
  if (newSession !== sessionString) {
    saveUserbotSession(db, newSession);
  }

  const users = new UsersRepo(db);
  const conversations = new ConversationsRepo(db);
  const messages = new MessagesRepo(db);
  const kb = new KbRepo(db);
  const kbSuggestions = new KbSuggestionsRepo(db);
  const styles = new StylesRepo(db);
  const skills = new SkillsRepo(db);
  const experiments = new ExperimentsRepo(db);
  const vacancies = new VacanciesRepo(db);
  const leads = new LeadsRepo(db);
  const telegramSender = makeUserbotSender(client);

  client.addEventHandler(
    async (event) => {
      const msg = event.message;
      if (!msg || msg.out) return; // skip own outgoing messages

      // Only handle private (direct) messages.
      if (!msg.isPrivate) return;

      const tgUserId = Number(msg.senderId?.toString() ?? 0);
      if (!tgUserId) return;

      const text = msg.text ?? "";
      if (!text.trim()) return;

      const userExisting = users.byTgId(tgUserId);
      let user = userExisting;
      if (!user && telegramOpenAccess()) {
        user = users.create({ tgUserId, tgUsername: null });
        console.log(`[userbot] TELEGRAM_OPEN_ACCESS: created user tg_user_id=${tgUserId}`);
      }
      if (!user) {
        console.log(`[userbot] ignoring message from non-whitelisted tg_user_id=${tgUserId}`);
        return;
      }

      const conv = conversations.ensureForUser(user.id);

      const persisted = messages.addUserMessageIfNew({
        conversationId: conv.id,
        tgMessageId: msg.id,
        text,
      });
      if (!persisted.isNew) return;

      conversations.touch(conv.id);
      onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });

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
        telegram: telegramSender,
        leadsChatId: null,
        visaChatId: null,
        rag,
        conv,
        user,
        chatId: tgUserId,
        text,
        tgUserId,
        onEvent,
      }).catch((err) => {
        console.error("[userbot] processInbound failed:", err);
      });
    },
    new NewMessage({ incoming: true }),
  );

  console.log("[userbot] connected and listening for private messages");
  return client;
}
