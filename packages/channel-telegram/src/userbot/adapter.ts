import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  InboundPart,
  MediaRef,
  OutboundEnvelope,
  Sent,
} from "@chatman-media/channel-core";
import { Api, TelegramClient as GramjsClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";

/**
 * Healthcheck-статусы MTProto userbot'а. apps/worker отслеживает их через
 * healthEvents() async iterable и:
 *   - "connected" → нормальная работа
 *   - "auth_key_duplicated" → session revoked (оператор нажал "Terminate
 *     other sessions" в TG-клиенте, либо Telegram сам killед). Требует
 *     re-auth через admin-UI; supervisor НЕ должен respawn в петле.
 *   - "connection_failed" → transient (network blip); supervisor respawn'ит.
 */
export type UserbotHealthStatus = "connected" | "auth_key_duplicated" | "connection_failed";

export interface UserbotHealthEvent {
  status: UserbotHealthStatus;
  reason?: string;
  at: number;
}

/**
 * MTProto userbot адаптер (личный аккаунт оператора через gramjs).
 *
 * Минимальная функциональность: connect, receive (NewMessage → Inbound),
 * send (text), downloadMedia (через client.downloadMedia). Полная legacy-codebase
 * импл'я имеет +supervisor для AUTH_KEY_DUPLICATED, delete-queue, per-
 * conversation serialization, vision/photo-classify — это всё надстраивается
 * сверху в conversation-engine и apps/worker.
 *
 * Жизненный цикл:
 *   1. new TelegramUserbotAdapter({ id, apiId, apiHash, sessionString,
 *      onSessionUpdated })
 *   2. await adapter.connect() — gramjs client.connect() с retry, при
 *      обновлённой session сохраняется callback'ом onSessionUpdated.
 *   3. await for inbound of adapter.receive() — push'ит NewMessage events.
 *   4. adapter.send(envelope) — text via gramjs.sendMessage(peer).
 *   5. adapter.close() / signal.abort() — disconnect.
 */
export interface TelegramUserbotAdapterOptions {
  id: string;
  apiId: number;
  apiHash: string;
  /**
   * StringSession строка. Пустая = первичная auth (требует операторского
   * вмешательства через admin /userbot-login flow). При успешном connect
   * gramjs может выдать обновлённый session — это сохраняется через
   * onSessionUpdated callback.
   */
  sessionString: string;
  /**
   * Callback при обновлении session-string'а после connect или re-auth.
   * apps/worker записывает её в userbot_session таблицу.
   */
  onSessionUpdated?: (sessionString: string) => Promise<void> | void;
  /** Количество retry connect'ов, default 5. */
  connectionRetries?: number;
  /** ms между connect-попытками, default 5000. */
  retryDelayMs?: number;
}

const TG_USERBOT_CAPABILITIES: ChannelCapabilities = {
  text: true,
  photo: true,
  video: true,
  voice: true,
  document: true,
  edit: false,
  delete: true,
  callbackQuery: false,
  typing: true,
};

export class TelegramUserbotAdapter implements ChannelAdapter {
  readonly kind = "telegram_userbot" as const;
  readonly id: string;
  readonly capabilities = TG_USERBOT_CAPABILITIES;

  private readonly opts: TelegramUserbotAdapterOptions;
  private client: GramjsClient | null = null;
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;
  /**
   * LRU-кэш Message-объектов для последующего downloadMedia. Ключ —
   * `${external_user_id}:${msg_id}`. Размер ограничен MAX_RECENT_MESSAGES
   * чтобы long-running процесс не утекал. Если worker'у нужен старый
   * media — он должен скачать его сразу в onInbound, не отсрочивать.
   */
  private static readonly MAX_RECENT_MESSAGES = 256;
  private readonly recentMessages = new Map<string, unknown>();
  /** Healthcheck events queue (separate от inbox'а). */
  private readonly healthQueue: UserbotHealthEvent[] = [];
  private healthWaiters: Array<(v: IteratorResult<UserbotHealthEvent>) => void> = [];

  constructor(opts: TelegramUserbotAdapterOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  /**
   * Установить MTProto-соединение. Бросает Error если все retry'и failед —
   * supervisor в apps/worker делает respawn. Идемпотентно при повторных
   * вызовах (no-op если уже connected).
   */
  async connect(): Promise<void> {
    if (this.client && this.client.connected) return;
    const session = new StringSession(this.opts.sessionString);
    const client = new GramjsClient(session, this.opts.apiId, this.opts.apiHash, {
      // count, not flag — Infinity = бесконечно, 5 = разумный лимит чтобы
      // supervisor мог перерестартить вместо infinite-spin'а.
      connectionRetries: this.opts.connectionRetries ?? 5,
      retryDelay: this.opts.retryDelayMs ?? 3000,
      timeout: 30,
    });
    // GramJS на уровне ERROR console.error'ит рутинные ping-timeout'ы своего
    // update-loop'а (он сам их ловит и делает reconnect — см. updates.js).
    // Для long-running SaaS это шум; значимые статусы (connected /
    // connection_failed / auth_key_duplicated) мы отдаём через healthEvents().
    client.setLogLevel(LogLevel.NONE);

    const maxAttempts = this.opts.connectionRetries ?? 5;
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const ok = await client.connect();
        if (ok) {
          this.client = client;
          // Persist updated session if changed.
          const updated = client.session.save() as unknown as string;
          if (updated !== this.opts.sessionString && this.opts.onSessionUpdated) {
            await this.opts.onSessionUpdated(updated);
          }
          this.registerHandler(client);
          return;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        // AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED — terminal состояние.
        // Прерываем retry-loop, эмитим health event "auth_key_duplicated"
        // и бросаем — supervisor НЕ должен respawn (требуется операторская
        // re-auth через admin-UI).
        if (lastErr && /AUTH_KEY_(DUPLICATED|UNREGISTERED)/i.test(lastErr)) {
          this.emitHealth({ status: "auth_key_duplicated", reason: lastErr });
          throw new Error(`[telegram-userbot] auth key revoked: ${lastErr}`);
        }
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 5000));
      }
    }
    this.emitHealth({ status: "connection_failed", reason: lastErr ?? "no specific error" });
    throw new Error(
      `[telegram-userbot] connect failed after ${maxAttempts} attempts${
        lastErr ? `: ${lastErr}` : ""
      }`,
    );
  }

  // ---- Health events stream ---------------------------------------------

  private emitHealth(event: Omit<UserbotHealthEvent, "at">): void {
    const full: UserbotHealthEvent = { ...event, at: Math.floor(Date.now() / 1000) };
    const waiter = this.healthWaiters.shift();
    if (waiter) {
      waiter({ value: full, done: false });
      return;
    }
    this.healthQueue.push(full);
  }

  /**
   * Async iterable healthcheck-events для supervisor'а в apps/worker.
   * Emit'ится при connect success ("connected") / connect failure
   * ("connection_failed") / auth revocation ("auth_key_duplicated").
   * Supervisor читает их и решает: respawn vs notify-operator-and-stop.
   */
  healthEvents(): AsyncIterable<UserbotHealthEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<UserbotHealthEvent> {
        return {
          next(): Promise<IteratorResult<UserbotHealthEvent>> {
            const queued = self.healthQueue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (self.closed) {
              return Promise.resolve({
                value: undefined as unknown as UserbotHealthEvent,
                done: true,
              });
            }
            return new Promise((resolve) => self.healthWaiters.push(resolve));
          },
        };
      },
    };
  }

  private registerHandler(client: GramjsClient): void {
    client.addEventHandler(async (event: NewMessageEvent) => {
      const msg = event.message;
      if (!msg) return;
      if ("out" in msg && (msg as { out?: boolean }).out) return; // skip own outgoing
      const inbound = this.eventToInbound(event);
      if (inbound) {
        // Кэш для downloadMedia — без него mediaRef из Inbound не резолвится
        // обратно к Message-объекту (MTProto не даёт публичный file_id).
        this.cacheMessage(inbound.externalUserId, inbound.externalMessageId, msg);
        this.enqueue(inbound);
      }
    }, new NewMessage({}));
    this.emitHealth({ status: "connected" });
  }

  private cacheMessage(externalUserId: string, externalMessageId: string, msg: unknown): void {
    const key = `${externalUserId}:${externalMessageId}`;
    this.recentMessages.set(key, msg);
    if (this.recentMessages.size > TelegramUserbotAdapter.MAX_RECENT_MESSAGES) {
      // Map preserves insertion order — drop oldest entries first.
      const dropCount = this.recentMessages.size - TelegramUserbotAdapter.MAX_RECENT_MESSAGES;
      const it = this.recentMessages.keys();
      for (let i = 0; i < dropCount; i++) {
        const next = it.next();
        if (next.done) break;
        this.recentMessages.delete(next.value);
      }
    }
  }

  private eventToInbound(event: NewMessageEvent): Inbound | null {
    const msg = event.message;
    if (!msg) return null;
    const senderId = msg.senderId?.toString();
    if (!senderId) return null;

    // Игнорируем не-private (групповые чаты, каналы).
    const peer = msg.peerId as { className?: string } | undefined;
    if (peer?.className !== "PeerUser") return null;

    const parts: InboundPart[] = [];
    const text = (msg as { message?: string }).message ?? "";
    if (text.length > 0 && !this.hasMedia(msg)) {
      parts.push({ kind: "text", text });
    } else if (this.hasMedia(msg)) {
      const mediaPart = this.mediaToPart(msg, text);
      if (mediaPart) parts.push(mediaPart);
    }
    if (parts.length === 0) return null;

    const externalMessageId = ((msg as { id?: number }).id ?? 0).toString();
    return {
      channelId: this.id,
      externalMessageId,
      externalUserId: senderId,
      parts,
      receivedAt: Math.floor(Date.now() / 1000),
      raw: event,
    };
  }

  private hasMedia(msg: unknown): boolean {
    const m = msg as { photo?: unknown; video?: unknown; voice?: unknown; document?: unknown };
    return !!(m.photo || m.video || m.voice || m.document);
  }

  private mediaToPart(msg: unknown, caption: string): InboundPart | null {
    // MTProto media не имеют публичного file_id (как BotAPI) — instead мы
    // храним сам msg.id как ref, чтобы потом downloadMedia(msg) мог
    // достать байты через gramjs.
    const m = msg as {
      photo?: unknown;
      video?: { duration?: number; mimeType?: string };
      voice?: { duration?: number };
      document?: { mimeType?: string; attributes?: Array<{ fileName?: string }> };
      id: number;
    };
    const ref: MediaRef = { channelId: this.id, externalRef: String(m.id) };

    if (m.photo) {
      return {
        kind: "photo",
        mediaRef: ref,
        ...(caption ? { caption } : {}),
      };
    }
    if (m.video) {
      return {
        kind: "video",
        mediaRef: ref,
        ...(caption ? { caption } : {}),
      };
    }
    if (m.voice) {
      return {
        kind: "voice",
        mediaRef: ref,
        ...(m.voice.duration ? { durationSec: m.voice.duration } : {}),
      };
    }
    if (m.document) {
      const fileName = m.document.attributes?.find((a) => a.fileName)?.fileName;
      return {
        kind: "document",
        mediaRef: ref,
        ...(m.document.mimeType ? { mimeType: m.document.mimeType } : {}),
        ...(fileName ? { fileName } : {}),
      };
    }
    return null;
  }

  // ---- ChannelAdapter методы ---------------------------------------------

  private enqueue(inbound: Inbound): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: inbound, done: false });
      return;
    }
    this.inbox.push(inbound);
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.({ value: undefined as unknown as Inbound, done: true });
    }
    while (this.healthWaiters.length > 0) {
      const w = this.healthWaiters.shift();
      w?.({ value: undefined as unknown as UserbotHealthEvent, done: true });
    }
    this.recentMessages.clear();
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // ignore — process restart всё равно очистит
      }
      this.client = null;
    }
  }

  receive(signal?: AbortSignal): AsyncIterable<Inbound> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Inbound> {
        return {
          next(): Promise<IteratorResult<Inbound>> {
            if (signal?.aborted) {
              return Promise.resolve({ value: undefined as unknown as Inbound, done: true });
            }
            const queued = self.inbox.shift();
            if (queued) {
              return Promise.resolve({ value: queued, done: false });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined as unknown as Inbound, done: true });
            }
            return new Promise((resolve) => {
              self.waiters.push(resolve);
              if (signal) {
                signal.addEventListener(
                  "abort",
                  () => {
                    const idx = self.waiters.indexOf(resolve);
                    if (idx >= 0) self.waiters.splice(idx, 1);
                    resolve({ value: undefined as unknown as Inbound, done: true });
                  },
                  { once: true },
                );
              }
            });
          },
        };
      },
    };
  }

  async send(envelope: OutboundEnvelope): Promise<Sent> {
    if (!this.client) {
      throw new Error("[telegram-userbot] send called before connect()");
    }
    if (envelope.parts.length === 0) {
      throw new Error("OutboundEnvelope.parts must be non-empty");
    }
    const peer = await this.resolvePeer(envelope.externalUserId);
    let firstId: number | undefined;
    for (const part of envelope.parts) {
      // MTProto.sendMessage принимает text-only через { message: ... }, файлы
      // через { file: ... }. Здесь только text — media-send из БД-стора
      // (file:path) добавляется отдельной миграцией если понадобится.
      let sentId: number | undefined;
      if (part.kind === "text") {
        const result = await this.client.sendMessage(
          peer as Parameters<GramjsClient["sendMessage"]>[0],
          {
            message: part.text,
          },
        );
        sentId = (result as { id?: number }).id;
      } else {
        // Send-by-mediaRef не поддерживается в минимальной реализации —
        // legacy-codebase использует filePath из медиа-кэша. Для платформы это
        // добавляется когда worker'у понадобится re-relay медиа.
        throw new Error(`[telegram-userbot] send: unsupported part.kind=${part.kind}`);
      }
      if (firstId === undefined) firstId = sentId;
    }

    return {
      channelId: this.id,
      externalMessageId: String(firstId ?? ""),
      sentAt: Math.floor(Date.now() / 1000),
    };
  }

  async edit(_opts: EditOpts): Promise<void> {
    throw new Error("[telegram-userbot] edit: capability disabled (MTProto edit pending)");
  }

  async delete(opts: DeleteOpts): Promise<void> {
    if (!this.client) {
      throw new Error("[telegram-userbot] delete called before connect()");
    }
    const peer = await this.resolvePeer(opts.externalUserId);
    const messageId = Number(opts.externalMessageId);
    if (Number.isNaN(messageId)) {
      throw new Error("[telegram-userbot] delete: externalMessageId must be numeric");
    }
    await this.client.deleteMessages(
      peer as Parameters<GramjsClient["deleteMessages"]>[0],
      [messageId],
      { revoke: true },
    );
  }

  /**
   * Скачивает медиа через cached Message-объект. mediaRef.externalRef —
   * msg.id из last-received Inbound; caller вызывает downloadMedia сразу
   * после inbound'а (worker pipe'ит в media-кэш).
   *
   * mediaRef.externalRef сам по себе не хватает (gramjs.downloadMedia
   * требует Message), поэтому мы кэшируем последние MAX_RECENT_MESSAGES
   * объектов в recentMessages Map при registerHandler.
   *
   * Throws если: client не подключён / mediaRef не найден в кэше /
   * downloadMedia ошибается.
   */
  async downloadMedia(mediaRef: MediaRef, opts?: { externalUserId?: string }): Promise<Response> {
    if (!this.client) {
      throw new Error("[telegram-userbot] downloadMedia called before connect()");
    }
    if (!opts?.externalUserId) {
      throw new Error(
        "[telegram-userbot] downloadMedia requires opts.externalUserId — pass it from Inbound.externalUserId",
      );
    }
    const key = `${opts.externalUserId}:${mediaRef.externalRef}`;
    const cached = this.recentMessages.get(key);
    if (!cached) {
      throw new Error(
        `[telegram-userbot] downloadMedia: msg ${key} evicted from cache (>${TelegramUserbotAdapter.MAX_RECENT_MESSAGES} messages ago); download immediately on inbound`,
      );
    }
    // gramjs.downloadMedia принимает Message + опции и возвращает Buffer.
    const bytes = (await this.client.downloadMedia(
      cached as Parameters<GramjsClient["downloadMedia"]>[0],
    )) as Buffer | Uint8Array | string | null;
    if (!bytes) {
      throw new Error("[telegram-userbot] downloadMedia: empty result");
    }
    const buf = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    return new Response(buf);
  }

  async signalTyping(externalUserId: string): Promise<void> {
    if (!this.client) return;
    try {
      const peer = await this.resolvePeer(externalUserId);
      // Raw Api.messages.SetTyping. action=SendMessageTypingAction — indicator
      // погаснет автоматически через ~6 сек у клиента, либо при send'е
      // следующего сообщения.
      // biome-ignore lint/suspicious/noExplicitAny: raw gramjs invoke API
      await (this.client as any).invoke(
        new Api.messages.SetTyping({
          peer: peer as Parameters<GramjsClient["sendMessage"]>[0],
          action: new Api.SendMessageTypingAction(),
        }),
      );
    } catch {
      // typing-индикатор optional, не ломаем pipeline если не получилось.
    }
  }

  /** Резолв peer'а по external_user_id (string из Inbound). */
  private async resolvePeer(externalUserId: string): Promise<unknown> {
    if (!this.client) throw new Error("client not connected");
    const userId = Number(externalUserId);
    if (Number.isNaN(userId)) {
      throw new Error(`[telegram-userbot] invalid externalUserId "${externalUserId}"`);
    }
    return this.client.getInputEntity(userId);
  }
}
