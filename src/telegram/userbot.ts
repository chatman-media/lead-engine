import { TelegramClient as GramjsClient } from "telegram";
import { NewMessage } from "telegram/events";
import { StringSession } from "telegram/sessions";
import { telegramOpenAccess } from "../config.ts";
import type { Sql } from "../db/postgres.ts";
import { ConversationsRepo } from "../db/repos/conversations.ts";
import { ExperimentsRepo } from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { KbSuggestionsRepo } from "../db/repos/kb-suggestions.ts";
import { LeadsRepo } from "../db/repos/leads.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { SkillsRepo } from "../db/repos/skills.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { dequeuePending, markFailed, markSent } from "../db/repos/userbot-send-queue.ts";
import { loadUserbotSession, saveUserbotSession } from "../db/repos/userbot-session.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { VacanciesRepo } from "../db/repos/vacancies.ts";
import type { TelegramClient } from "./client.ts";
import type { TgReplyMarkup, TgSendMessageResult } from "./types.ts";
import type { RagDeps } from "./webhook.ts";
import { processInbound } from "./webhook.ts";

export interface UserbotDeps {
  db: Sql;
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
// replyFn is a closure over the inbound `msg` so gramjs doesn't need to
// look up an entity by bare numeric ID (which fails for first-time users
// who aren't yet in the session's entity cache).
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

/**
 * Sweep unread private dialogs and process each missed message through the
 * RAG pipeline. Idempotent — `messages.addUserMessageIfNew` skips already-
 * persisted message IDs, so this can run repeatedly without duplicating work.
 *
 * Run on:
 *   1. Startup (catch-up after a downtime window).
 *   2. Periodic interval (every 60s) — recovers messages that arrived during
 *      a connection drop. gramjs does NOT re-fire `addEventHandler` for
 *      messages received between disconnect and reconnect; without this
 *      sweep the bot would miss them silently.
 */
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
    if (!(dialog.entity && "className" in dialog.entity && dialog.entity.className === "User")) {
      continue;
    }
    const tgUserId = Number("id" in dialog.entity ? (dialog.entity.id?.toString() ?? "0") : "0");
    if (!tgUserId) continue;

    let msgs: Awaited<ReturnType<GramjsClient["getMessages"]>>;
    try {
      msgs = await d.client.getMessages(dialog.entity, {
        limit: Math.min(dialog.unreadCount, 20),
      });
    } catch (err) {
      console.warn(`[userbot] getMessages failed for tgUserId=${tgUserId}:`, err);
      continue;
    }

    // Oldest first — consistent with the live event order.
    for (const msg of [...msgs].reverse()) {
      if (msg.out) continue;
      const text = msg.text ?? "";
      if (!text.trim()) continue;

      const userExisting = await d.users.byTgId(tgUserId);
      let user = userExisting;
      if (!user && telegramOpenAccess()) {
        user = await d.users.create({ tgUserId, tgUsername: null });
      }
      if (!user) continue;

      const conv = await d.conversations.ensureForUser(user.id);
      const persisted = await d.messages.addUserMessageIfNew({
        conversationId: conv.id,
        tgMessageId: msg.id,
        text,
      });
      if (!persisted.isNew) continue;

      await d.conversations.touch(conv.id);
      d.onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });

      console.log(
        `[userbot] sweep: processing missed msg id=${msg.id} from tg_user_id=${tgUserId}`,
      );

      // Use dialog.entity (full User object) so gramjs doesn't need to
      // resolve access_hash from a bare numeric ID.
      const entity = dialog.entity;
      const telegramSender = makeUserbotSender(
        (text) => d.client.sendMessage(entity, { message: text }),
        tgUserId,
      );

      processInbound({
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
        console.error("[userbot] sweep processInbound failed:", err);
      });
    }

    // Mark dialog read so subsequent sweeps don't retry the same messages.
    try {
      await d.client.markAsRead(dialog.entity);
    } catch {
      // Non-fatal — the addUserMessageIfNew dedupe is the primary guard.
    }
  }
}

const UNREAD_SWEEP_INTERVAL_MS = 60_000;
/** Minimum ms between processing consecutive messages from the same user.
 *  Prevents a burst of rapid messages (accidental spam / double-send) from
 *  firing multiple back-to-back LLM calls. The second message in a burst is
 *  silently dropped; the user sees only the reply to the first. */
const USER_RATE_LIMIT_MS = 5_000;

export async function startUserbot(deps: UserbotDeps): Promise<GramjsClient> {
  const { db, apiId, apiHash, rag, onEvent } = deps;

  const sessionString = process.env.USERBOT_SESSION || (await loadUserbotSession(db));
  const session = new StringSession(sessionString);

  const client = new GramjsClient(session, apiId, apiHash, {
    // -1 = unlimited retries; gramjs will keep reconnecting after network
    // drops without dying. Individual reconnect attempts are logged by
    // gramjs itself at WARN level ("Started reconnecting").
    connectionRetries: -1,
    retryDelay: 3000,
  });

  // connect() can throw TIMEOUT on the first attempt when Telegram is slow.
  // Retry up to 5 times with a 5s pause before giving up and letting the
  // parent process (index.ts) restart the subprocess in 10s.
  let connected = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await client.connect();
      connected = true;
      break;
    } catch (err) {
      console.warn(
        `[userbot] connect attempt ${attempt}/5 failed:`,
        (err as Error)?.message ?? err,
      );
      if (attempt < 5) await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!connected) {
    throw new Error("[userbot] could not connect after 5 attempts — subprocess will restart");
  }

  // Persist refreshed session after connect so it survives restarts.
  const newSession = client.session.save() as unknown as string;
  if (newSession !== sessionString) {
    await saveUserbotSession(db, newSession);
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
  // Per-user last-processed timestamp for rate limiting.
  const lastProcessedAt = new Map<number, number>();

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

      // Rate limit: drop messages arriving faster than USER_RATE_LIMIT_MS per user.
      const now = Date.now();
      const last = lastProcessedAt.get(tgUserId) ?? 0;
      if (now - last < USER_RATE_LIMIT_MS) {
        console.log(
          `[userbot] rate-limited tg_user_id=${tgUserId} (${now - last}ms since last msg)`,
        );
        return;
      }
      lastProcessedAt.set(tgUserId, now);

      const userExisting = await users.byTgId(tgUserId);
      let user = userExisting;
      if (!user && telegramOpenAccess()) {
        user = await users.create({ tgUserId, tgUsername: null });
        console.log(`[userbot] TELEGRAM_OPEN_ACCESS: created user tg_user_id=${tgUserId}`);
      }
      if (!user) {
        console.log(`[userbot] ignoring message from non-whitelisted tg_user_id=${tgUserId}`);
        return;
      }

      const conv = await conversations.ensureForUser(user.id);

      const persisted = await messages.addUserMessageIfNew({
        conversationId: conv.id,
        tgMessageId: msg.id,
        text,
      });
      if (!persisted.isNew) return;

      await conversations.touch(conv.id);
      onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });

      // Create sender bound to this specific inbound message so that
      // msg.reply() is used instead of sendMessage(numericId) — the
      // latter fails for users not yet in gramjs's entity cache.
      const telegramSender = makeUserbotSender(async (text) => {
        const sent = await msg.reply({ message: text });
        return { id: sent?.id ?? 0 };
      }, tgUserId);

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

  // Initial sweep of unread dialogs — recovers messages received during
  // any prior downtime window.
  const sweepDeps: ProcessUnreadDeps = {
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
    ...(rag ? { rag } : {}),
    ...(onEvent ? { onEvent } : {}),
  };
  await processUnread(sweepDeps).catch((err) => {
    console.warn("[userbot] initial unread sweep failed:", err);
  });

  // Periodic sweep — recovers messages received between a disconnect and
  // the subsequent gramjs reconnect (the live `addEventHandler` does NOT
  // replay buffered messages after "Handling reconnect!"). Idempotent
  // by way of `messages.addUserMessageIfNew` so re-runs are safe.
  const sweepHandle = setInterval(() => {
    processUnread(sweepDeps).catch((err) => {
      console.warn("[userbot] periodic sweep failed:", err);
    });
  }, UNREAD_SWEEP_INTERVAL_MS);
  // Don't keep the process alive just because of this timer. Bun-specific
  // API; falls back to no-op on Node.
  if (typeof (sweepHandle as { unref?: () => void }).unref === "function") {
    (sweepHandle as { unref: () => void }).unref();
  }

  // Drain admin-reply send queue — picks up messages enqueued by the main process
  // so they are sent from Alina's personal account instead of the bot.
  const SEND_QUEUE_POLL_MS = 2_000;
  const sendQueueHandle = setInterval(async () => {
    let pending: Awaited<ReturnType<typeof dequeuePending>>;
    try {
      pending = await dequeuePending(db);
    } catch {
      return;
    }
    for (const row of pending) {
      try {
        await client.sendMessage(row.tg_user_id, { message: row.text });
        await markSent(db, row.id);
      } catch (err) {
        console.error(`[userbot] send-queue failed tg_user_id=${row.tg_user_id}:`, err);
        await markFailed(db, row.id, err instanceof Error ? err.message : String(err)).catch(
          () => undefined,
        );
      }
    }
  }, SEND_QUEUE_POLL_MS);
  if (typeof (sendQueueHandle as { unref?: () => void }).unref === "function") {
    (sendQueueHandle as { unref: () => void }).unref();
  }

  console.log(
    `[userbot] connected and listening for private messages (sweep every ${UNREAD_SWEEP_INTERVAL_MS / 1000}s)`,
  );
  return client;
}
