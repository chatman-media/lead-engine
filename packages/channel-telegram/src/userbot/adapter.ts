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
import { TelegramClient as GramjsClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";

/**
 * MTProto userbot адаптер (личный аккаунт оператора через gramjs).
 *
 * Минимальная функциональность: connect, receive (NewMessage → Inbound),
 * send (text), downloadMedia (через client.downloadMedia). Полная sales-guru
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
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 5000));
      }
    }
    throw new Error(
      `[telegram-userbot] connect failed after ${maxAttempts} attempts${
        lastErr ? `: ${lastErr}` : ""
      }`,
    );
  }

  private registerHandler(client: GramjsClient): void {
    client.addEventHandler(async (event: NewMessageEvent) => {
      const msg = event.message;
      if (!msg) return;
      if ("out" in msg && (msg as { out?: boolean }).out) return; // skip own outgoing
      const inbound = this.eventToInbound(event);
      if (inbound) this.enqueue(inbound);
    }, new NewMessage({}));
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
        const result = await this.client.sendMessage(peer as Parameters<GramjsClient["sendMessage"]>[0], {
          message: part.text,
        });
        sentId = (result as { id?: number }).id;
      } else {
        // Send-by-mediaRef не поддерживается в минимальной реализации —
        // sales-guru использует filePath из медиа-кэша. Для платформы это
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

  async downloadMedia(mediaRef: MediaRef): Promise<Response> {
    if (!this.client) {
      throw new Error("[telegram-userbot] downloadMedia called before connect()");
    }
    // MTProto не отдаёт URL — сразу streams bytes. Заворачиваем в Response
    // через ReadableStream для единообразия с channel-core API.
    const messageId = Number(mediaRef.externalRef);
    if (Number.isNaN(messageId)) {
      throw new Error("[telegram-userbot] downloadMedia: invalid externalRef");
    }
    // gramjs.downloadMedia требует Message-объект (либо id+chat). Поскольку
    // у нас нет chat-контекста на этом уровне (mediaRef channel-agnostic),
    // реализация сейчас минимальна — апстрим вызов делается в worker'е,
    // который держит контекст из последнего Inbound.event.raw.
    throw new Error(
      "[telegram-userbot] downloadMedia: implement via Inbound.raw — pending integration with worker",
    );
  }

  async signalTyping(externalUserId: string): Promise<void> {
    if (!this.client) return;
    try {
      const peer = await this.resolvePeer(externalUserId);
      // gramjs invoke setTyping через Api.messages.SetTyping не выставлено
      // в публичном TelegramClient API напрямую. sales-guru делал это через
      // raw invoke; здесь — no-op, чтобы не падать. Когда добавим raw
      // Api.* проброс — заменим.
      void peer;
    } catch {
      // peer не резолвился — typing-индикатор optional, glob'аем
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
