import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Api, TelegramClient as GramjsClient } from "telegram";
import { NewMessage } from "telegram/events";
import { StringSession } from "telegram/sessions";
import { config, telegramOpenAccess } from "../config.ts";
import type { Sql } from "../db/postgres.ts";
import { type ConversationRow, ConversationsRepo } from "../db/repos/conversations.ts";
import { ExperimentsRepo } from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { KbSuggestionsRepo } from "../db/repos/kb-suggestions.ts";
import { LeadsRepo } from "../db/repos/leads.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { SkillsRepo } from "../db/repos/skills.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import {
  dequeuePending,
  MAX_SEND_ATTEMPTS,
  markFailed,
  markSent,
} from "../db/repos/userbot-send-queue.ts";
import { loadUserbotSession, saveUserbotSession } from "../db/repos/userbot-session.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { VacanciesRepo } from "../db/repos/vacancies.ts";
import { log } from "../log.ts";
import { classifyPhoto } from "../rag/vision.ts";
import type { TelegramClient } from "./client.ts";
import type { ParsedMTProxy } from "./mtproxy.ts";
import type { TgReplyMarkup, TgSendMessageResult } from "./types.ts";
import type { RagDeps } from "./webhook.ts";
import { processInbound } from "./webhook.ts";

export interface UserbotDeps {
  db: Sql;
  apiId: number;
  apiHash: string;
  /** Optional MTProto proxy. Pre-parsed via `parseMTProxy()` from a config
   *  string. Used when the server can't reach Telegram DCs directly. */
  proxy?: ParsedMTProxy;
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

/**
 * Persist a photo a candidate sent to the userbot (Alina's) account.
 *
 * MTProto media has no Bot API `file_id`, so we download the bytes via
 * gramjs once, save them under `config.media.dir`, and reference the
 * filename in `meta_json.media`. Without this the userbot dropped photos
 * entirely (the live handler/sweep skipped non-text messages) — passport
 * photos in the real funnel were never recorded.
 *
 * Vision classification (passport / full_body / ...) runs fire-and-forget
 * so it never delays persistence; the result is stamped onto
 * `meta_json.media.photo_class` and an event nudges the admin UI.
 *
 * Idempotent: album re-delivery / sweep overlap is collapsed by
 * `addUserMessageIfNew`'s (conversation_id, tg_message_id) dedupe.
 */
async function handleInboundPhoto(d: {
  client: GramjsClient;
  msg: Api.Message;
  conv: ConversationRow;
  tgUserId: number;
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  onEvent?: UserbotDeps["onEvent"];
}): Promise<{ isNew: boolean; caption: string }> {
  const { client, msg, conv, tgUserId, messages, conversations, onEvent } = d;
  const caption = msg.text?.trim() ?? "";
  // Returned when the photo is a duplicate or could not be downloaded/saved
  // — the caller skips processInbound on `isNew: false`.
  const NOT_NEW = { isNew: false, caption };

  let buf: Buffer;
  try {
    const downloaded = await client.downloadMedia(msg, {});
    if (!downloaded || typeof downloaded === "string") {
      log.warn("userbot: photo download returned no bytes", {
        scope: "userbot",
        tg_message_id: msg.id,
      });
      return NOT_NEW;
    }
    buf = downloaded as Buffer;
  } catch (err) {
    log.error("userbot: photo download failed", { scope: "userbot", tg_message_id: msg.id, err });
    return NOT_NEW;
  }

  const filename = `${conv.id}-${msg.id}.jpg`;
  try {
    await mkdir(config.media.dir, { recursive: true });
    await Bun.write(join(config.media.dir, filename), buf);
  } catch (err) {
    log.error("userbot: photo save failed", { scope: "userbot", filename, err });
    return NOT_NEW;
  }

  const persisted = await messages.addUserMessageIfNew({
    conversationId: conv.id,
    tgMessageId: msg.id,
    text: caption || "[photo]",
    meta: { media: { type: "photo", source: "userbot", file: filename } },
  });
  if (!persisted.isNew) return NOT_NEW;

  await conversations.touch(conv.id);
  onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });
  log.info("userbot: photo persisted", {
    scope: "userbot",
    tg_message_id: msg.id,
    conv_id: conv.id,
  });

  // Classify synchronously (await) so the photo_class is stamped BEFORE
  // the caller runs processInbound → runPhotoClassification. That hook
  // re-downloads pending photos by Bot API file_id, which userbot/MTProto
  // media doesn't have — classifying here makes the hook's ack step see
  // the class without needing a re-download.
  if (config.vision.enabled && config.openrouter.apiKey) {
    try {
      const bytes = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
      const photoClass = await classifyPhoto({
        bytes,
        model: config.vision.model,
        apiKey: config.openrouter.apiKey,
        baseUrl: config.openrouter.baseUrl,
      });
      await messages.setPhotoClass(persisted.message.id, photoClass);
      log.info("userbot: photo classified", {
        scope: "userbot",
        tg_message_id: msg.id,
        photo_class: photoClass,
      });
      // Nudge the admin UI to re-fetch so the passport badge appears.
      onEvent?.({ type: "conversation-mode-changed", conversationId: conv.id });
    } catch (err) {
      log.error("userbot: photo classification failed", { scope: "userbot", err });
    }
  }

  return { isNew: true, caption };
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
    log.warn("could not fetch dialogs for unread sweep", { scope: "userbot", err });
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
      log.warn("getMessages failed", { scope: "userbot", tg_user_id: tgUserId, err });
      continue;
    }

    // Oldest first — consistent with the live event order.
    for (const msg of [...msgs].reverse()) {
      if (msg.out) continue;
      const text = msg.text ?? "";
      const isPhoto = !!msg.photo;
      if (!isPhoto && !text.trim()) continue;

      const userExisting = await d.users.byTgId(tgUserId);
      let user = userExisting;
      if (!user && telegramOpenAccess()) {
        user = await d.users.create({ tgUserId, tgUsername: null });
      }
      if (!user) continue;

      const conv = await d.conversations.ensureForUser(user.id, "userbot");

      // Persist the inbound. Photos download + classify in
      // handleInboundPhoto; text is a plain insert. `isNew` collapses
      // album re-delivery / sweep overlap. A bare photo (no caption) is a
      // media-only turn — processInbound acknowledges it without a chat reply.
      let isNew: boolean;
      let inboundText: string;
      let mediaOnly: boolean;
      if (isPhoto) {
        const photo = await handleInboundPhoto({
          client: d.client,
          msg,
          conv,
          tgUserId,
          messages: d.messages,
          conversations: d.conversations,
          ...(d.onEvent ? { onEvent: d.onEvent } : {}),
        });
        isNew = photo.isNew;
        inboundText = photo.caption || "[photo]";
        mediaOnly = photo.caption.length === 0;
      } else {
        const persisted = await d.messages.addUserMessageIfNew({
          conversationId: conv.id,
          tgMessageId: msg.id,
          text,
        });
        isNew = persisted.isNew;
        inboundText = text;
        mediaOnly = false;
        if (isNew) {
          await d.conversations.touch(conv.id);
          d.onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });
        }
      }
      if (!isNew) continue;

      log.info("sweep: processing missed msg", {
        scope: "userbot",
        tg_message_id: msg.id,
        tg_user_id: tgUserId,
      });

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
        text: inboundText,
        tgUserId,
        mediaOnly,
        onEvent: d.onEvent,
      }).catch((err) => {
        log.error("sweep processInbound failed", { scope: "userbot", err });
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
  const { db, apiId, apiHash, proxy, rag, onEvent } = deps;

  const sessionString = process.env.USERBOT_SESSION || (await loadUserbotSession(db));
  const session = new StringSession(sessionString);

  if (proxy) {
    log.info("starting via MTProto proxy", {
      scope: "userbot",
      proxy_host: proxy.ip,
      proxy_port: proxy.port,
      // secret intentionally not logged — it'd land in centralized logs
      // verbatim. Host+port already give an operator enough to pinpoint
      // which entry from their list is in use.
    });
  }

  const client = new GramjsClient(session, apiId, apiHash, {
    // gramjs uses this in `for (attempt = 0; attempt < retries; attempt++)`
    // inside MTProtoSender.connect — so it's a COUNT, not a flag. The old
    // value `-1` made `0 < -1` false → the connect loop ran ZERO times →
    // the socket was never opened, `_updateLoop` then pinged a dead sender
    // and threw TIMEOUT forever. gramjs's own "unlimited" sentinel is
    // `Infinity`; we use a finite 5 so a genuinely unreachable Telegram
    // lets `connect()` return false (handled below) and the subprocess
    // restarts cleanly instead of spinning.
    connectionRetries: 5,
    retryDelay: 3000,
    // Default timeout is 10s; first connect over a slow link can exceed
    // that. 30s gives the update-state fetch headroom.
    timeout: 30,
    ...(proxy ? { proxy } : {}),
  });

  // `client.connect()` RETURNS a boolean (false = could not connect) — it
  // doesn't throw on a plain connection failure. The old code ignored the
  // return value and always set connected=true, so a false return let the
  // userbot march on with a dead sender: getDialogs would hang forever and
  // `connected and listening` was never reached. Check the boolean; also
  // keep the try/catch for the cases where connect DOES throw (TIMEOUT on a
  // slow link).
  let connected = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const ok = await client.connect();
      if (ok) {
        connected = true;
        break;
      }
      log.warn("connect returned false", { scope: "userbot", attempt, max_attempts: 5 });
    } catch (err) {
      log.warn("connect attempt threw", {
        scope: "userbot",
        attempt,
        max_attempts: 5,
        err,
      });
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 5_000));
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
  // Per-user last-processed timestamp for rate limiting. Bounded so a
  // long-running process doesn't accumulate one entry per ever-seen user
  // forever — when over the cap, drop the half that hasn't been seen in
  // the longest time (Map preserves insertion order; entries get
  // rewritten on every hit so iteration order tracks recency).
  const lastProcessedAt = new Map<number, number>();
  const LAST_PROCESSED_CAP = 10_000;
  function pruneLastProcessed(): void {
    if (lastProcessedAt.size <= LAST_PROCESSED_CAP) return;
    const drop = Math.floor(LAST_PROCESSED_CAP / 2);
    const it = lastProcessedAt.keys();
    for (let i = 0; i < drop; i++) {
      const k = it.next();
      if (k.done) break;
      lastProcessedAt.delete(k.value);
    }
  }

  client.addEventHandler(
    async (event) => {
      const msg = event.message;
      if (!msg || msg.out) return; // skip own outgoing messages

      // Only handle private (direct) messages.
      if (!msg.isPrivate) return;

      const tgUserId = Number(msg.senderId?.toString() ?? 0);
      if (!tgUserId) return;

      const text = msg.text ?? "";
      const isPhoto = !!msg.photo;
      if (!isPhoto && !text.trim()) return;

      // Rate limit: drop text messages arriving faster than USER_RATE_LIMIT_MS
      // per user. Photos are exempt — an album arrives as a burst of separate
      // messages and doesn't trigger an LLM reply, so rate-limiting them would
      // silently drop uploaded passport / full-body photos.
      if (!isPhoto) {
        const now = Date.now();
        const last = lastProcessedAt.get(tgUserId) ?? 0;
        if (now - last < USER_RATE_LIMIT_MS) {
          log.debug("rate-limited inbound", {
            scope: "userbot",
            tg_user_id: tgUserId,
            since_last_ms: now - last,
          });
          return;
        }
        lastProcessedAt.delete(tgUserId);
        lastProcessedAt.set(tgUserId, now);
        pruneLastProcessed();
      }

      const userExisting = await users.byTgId(tgUserId);
      let user = userExisting;
      if (!user && telegramOpenAccess()) {
        user = await users.create({ tgUserId, tgUsername: null });
        log.info("TELEGRAM_OPEN_ACCESS: created user", {
          scope: "userbot",
          tg_user_id: tgUserId,
        });
      }
      if (!user) {
        log.debug("ignoring message from non-whitelisted user", {
          scope: "userbot",
          tg_user_id: tgUserId,
        });
        return;
      }

      const conv = await conversations.ensureForUser(user.id, "userbot");

      // Persist the inbound. Photos download + classify in
      // handleInboundPhoto; text is a plain insert. A bare photo (no
      // caption) is a media-only turn — processInbound acknowledges it
      // (one deduped ack per album) without a chat reply.
      let isNew: boolean;
      let inboundText: string;
      let mediaOnly: boolean;
      if (isPhoto) {
        const photo = await handleInboundPhoto({
          client,
          msg,
          conv,
          tgUserId,
          messages,
          conversations,
          ...(onEvent ? { onEvent } : {}),
        });
        isNew = photo.isNew;
        inboundText = photo.caption || "[photo]";
        mediaOnly = photo.caption.length === 0;
      } else {
        const persisted = await messages.addUserMessageIfNew({
          conversationId: conv.id,
          tgMessageId: msg.id,
          text,
        });
        isNew = persisted.isNew;
        inboundText = text;
        mediaOnly = false;
        if (isNew) {
          await conversations.touch(conv.id);
          onEvent?.({ type: "user-message-persisted", conversationId: conv.id, tgUserId });
        }
      }
      if (!isNew) return;

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
        text: inboundText,
        tgUserId,
        mediaOnly,
        onEvent,
      }).catch((err) => {
        log.error("processInbound failed", { scope: "userbot", err });
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
    log.warn("initial unread sweep failed", { scope: "userbot", err });
  });

  // Periodic sweep — recovers messages received between a disconnect and
  // the subsequent gramjs reconnect (the live `addEventHandler` does NOT
  // replay buffered messages after "Handling reconnect!"). Idempotent
  // by way of `messages.addUserMessageIfNew` so re-runs are safe.
  const sweepHandle = setInterval(() => {
    processUnread(sweepDeps).catch((err) => {
      log.warn("periodic sweep failed", { scope: "userbot", err });
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
  // In-flight guard: if a previous tick is still running (slow Telegram
  // send / network blip), skip this tick. dequeuePending already uses
  // FOR UPDATE SKIP LOCKED so multi-instance is safe, but a single
  // instance shouldn't waste CPU on overlapping drains either.
  let draining = false;
  const sendQueueHandle = setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      await drainSendQueue();
    } finally {
      draining = false;
    }
  }, SEND_QUEUE_POLL_MS);

  async function drainSendQueue(): Promise<void> {
    let pending: Awaited<ReturnType<typeof dequeuePending>>;
    try {
      pending = await dequeuePending(db);
    } catch (err) {
      log.error("send-queue dequeuePending failed", { scope: "userbot", err });
      return;
    }
    if (pending.length > 0) {
      log.info("send-queue draining", { scope: "userbot", pending: pending.length });
    }
    for (const row of pending) {
      log.info("send-queue sending", {
        scope: "userbot",
        queue_id: row.id,
        tg_user_id: row.tg_user_id,
        text_len: row.text.length,
      });
      try {
        // Try resolving by numeric ID first (works if user has ever messaged
        // this account and their entity is in the gramJS session cache).
        // Fall back to @username lookup if the ID resolution fails — this
        // handles admins replying to users who only ever chatted with the bot,
        // not with Alina's personal account directly.
        let peer: Awaited<ReturnType<typeof client.getInputEntity>>;
        try {
          peer = await client.getInputEntity(row.tg_user_id);
        } catch (entityErr) {
          log.warn("send-queue: getInputEntity failed, trying username lookup", {
            scope: "userbot",
            tg_user_id: row.tg_user_id,
            err: entityErr,
          });
          const [userRow] = await db<{ tg_username: string | null }[]>`
            SELECT tg_username FROM users WHERE tg_user_id = ${row.tg_user_id} LIMIT 1
          `;
          if (!userRow?.tg_username) {
            throw new Error(
              `Cannot resolve entity for tg_user_id=${row.tg_user_id}: not in session cache and no tg_username in DB`,
            );
          }
          peer = await client.getInputEntity(`@${userRow.tg_username}`);
          log.info("send-queue: resolved via @username", {
            scope: "userbot",
            tg_username: userRow.tg_username,
            tg_user_id: row.tg_user_id,
          });
        }
        await client.sendMessage(peer, { message: row.text });
        await markSent(db, row.id);
        log.info("send-queue: sent ok", { scope: "userbot", queue_id: row.id });
      } catch (err) {
        log.error("send-queue failed", {
          scope: "userbot",
          queue_id: row.id,
          tg_user_id: row.tg_user_id,
          err,
        });
        await markFailed(db, row.id, err instanceof Error ? err.message : String(err)).catch(
          () => undefined,
        );
        // Surface the moment a row hits the attempts cap so an operator
        // can see in logs why a message stopped retrying.
        if (row.attempts >= MAX_SEND_ATTEMPTS - 1) {
          log.warn("send-queue: row hit attempt cap, giving up", {
            scope: "userbot",
            queue_id: row.id,
            max_attempts: MAX_SEND_ATTEMPTS,
          });
        }
      }
    }
  }
  if (typeof (sendQueueHandle as { unref?: () => void }).unref === "function") {
    (sendQueueHandle as { unref: () => void }).unref();
  }

  log.info("connected and listening for private messages", {
    scope: "userbot",
    sweep_interval_s: UNREAD_SWEEP_INTERVAL_MS / 1000,
  });
  return client;
}
