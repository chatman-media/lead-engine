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
 * Build a minimal TelegramClient-shaped sender per incoming message.
 * `replyFn` uses `msg.reply()` so gramjs already has the peer entity —
 * sending by raw numeric userId fails because gramjs doesn't cache
 * access_hash for users it hasn't "seen" yet.
 */
function makeUserbotSender(
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
      return {
        message_id: sent.id,
        chat: { id: chatId, type: "private" },
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

interface ProcessUnreadDeps {
  client: GramjsClient;
  users: UsersRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  kb: KbRepo;
  kbSuggestions: KbSuggestionsRepo;
  styles: StylesRepo;
  skills: SkillsRepo;
  experiments: ExperimentsRepo;
  vacancies: VacanciesRepo;
  leads: LeadsRepo;
  rag?: RagDeps;
  onEvent?: Parameters<typeof processInbound>[0]["onEvent"];
}

async function processUnread(d: ProcessUnreadDeps): Promise<void> {
  let dialogs: Awaited<ReturnType<GramjsClient["getDialogs"]>>;
  try {
    dialogs = await d.client.getDialogs({ limit: 100 });
  } catch (err) {
    console.warn("[userbot] could not fetch dialogs for unread sweep:", err);
    return;
  }

  for (const dialog of dialogs) {
    if (!dialog.unreadCount || dialog.unreadCount === 0) continue;
    // Only private chats (not groups/channels).
    if (!(dialog.entity && "className" in dialog.entity && dialog.entity.className === "User"))
      continue;

    const tgUserId = Number("id" in dialog.entity ? (dialog.entity.id?.toString() ?? "0") : "0");
    if (!tgUserId) continue;

    let msgs: Awaited<ReturnType<GramjsClient["getMessages"]>>;
    try {
      msgs = await d.client.getMessages(dialog.entity, {
        limit: Math.min(dialog.unreadCount, 20),
      });
    } catch {
      continue;
    }

    for (const msg of [...msgs].reverse()) {
      if (!msg || (msg as { out?: boolean }).out) continue;
      const text = (msg as { text?: string }).text ?? "";
      if (!text.trim()) continue;

      const userExisting = d.users.byTgId(tgUserId);
      let user = userExisting;
      if (!user && telegramOpenAccess()) {
        user = d.users.create({ tgUserId, tgUsername: null });
      }
      if (!user) continue;

      const conv = d.conversations.ensureForUser(user.id);
      const msgId = (msg as { id: number }).id;

      const persisted = d.messages.addUserMessageIfNew({
        conversationId: conv.id,
        tgMessageId: msgId,
        text,
      });
      if (!persisted.isNew) continue;

      console.log(`[userbot] unread from tg_user_id=${tgUserId}: "${text.slice(0, 60)}"`);
      d.conversations.touch(conv.id);
      d.onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });

      const telegramSender = makeUserbotSender(
        (t) =>
          (msg as { reply(opts: { message: string }): Promise<{ id: number }> }).reply({
            message: t,
          }),
        tgUserId,
      );

      await processInbound({
        messages: d.messages,
        conversations: d.conversations,
        kb: d.kb,
        kbSuggestions: d.kbSuggestions,
        styles: d.styles,
        skills: d.skills,
        experiments: d.experiments,
        users: d.users,
        vacancies: d.vacancies,
        leads: d.leads,
        telegram: telegramSender,
        leadsChatId: null,
        visaChatId: null,
        rag: d.rag,
        conv,
        user,
        chatId: tgUserId,
        text,
        tgUserId,
        onEvent: d.onEvent,
      }).catch((err) => {
        console.error("[userbot] processInbound (unread) failed:", err);
      });
    }
  }
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

  // Register handlers BEFORE catchUp so missed messages flow through them.
  // catchUp() replays all updates accumulated since the last disconnect.

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

      console.log(`[userbot] incoming message from tg_user_id=${tgUserId}: "${text.slice(0, 60)}"`);

      // Sender per-message: msg.reply() uses the known peer entity from the
      // incoming update — avoids the "could not find input entity" error.
      const telegramSender = makeUserbotSender(
        (t) => msg.reply({ message: t }) as Promise<{ id: number }>,
        tgUserId,
      );

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

  // Process messages that arrived while the server was offline.
  await processUnread({
    client,
    users,
    conversations,
    messages,
    kb,
    kbSuggestions,
    styles,
    skills,
    experiments,
    vacancies,
    leads,
    rag,
    onEvent,
  });

  console.log("[userbot] connected and listening for private messages");
  return client;
}
