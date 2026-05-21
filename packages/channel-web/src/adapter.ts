import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  OutboundPart,
  Sent,
} from "@chatman-media/channel-core";
import { encodeServerFrame, parseClientFrame } from "./protocol.ts";

const WEB_CAPABILITIES: ChannelCapabilities = {
  text: true,
  photo: false,
  video: false,
  voice: false,
  document: false,
  edit: false,
  delete: false,
  callbackQuery: false,
  typing: false,
};

/**
 * Web-chat ChannelAdapter — text-only для in-browser клиентов через
 * WebSocket. apps/api поднимает endpoint /ws/:tenantSlug, на каждый
 * accept'нутый connection вызывает adapter.acceptConnection(ws, userId)
 * с пред-валидированным userId (из JWT или session-cookie). Дальше
 * adapter сам routes:
 *   - client → server (text) → inbound queue (наружу через receive())
 *   - send() поверх OutboundEnvelope → ws.send(JSON)
 *
 * Connection map: {externalUserId → IWebSocket}. На disconnect'е connection
 * pruned'ится; send() пытается deliver, если user offline → IsDisconnected
 * error (caller markFailed-нет в outbound_queue, оператор'у admin-UI видит).
 *
 * Media (photo/video/voice/document) и edit/delete capabilities = false —
 * это text-only adapter. Web-чат с media — отдельный adapter (или
 * расширение этого) когда понадобится.
 */
export interface IWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number; // 1 = OPEN
}

const WS_OPEN = 1;

export interface WebChannelAdapterOptions {
  /** Уникальный id канала в платформе (соответствует channels.id в БД). */
  id: string;
}

export class WebDeliveryError extends Error {
  constructor(
    public readonly externalUserId: string,
    reason: string,
  ) {
    super(`WebChannel: ${reason} (user=${externalUserId})`);
    this.name = "WebDeliveryError";
  }
}

export class WebChannelAdapter implements ChannelAdapter {
  readonly kind = "web" as const;
  readonly id: string;
  readonly capabilities = WEB_CAPABILITIES;

  private readonly connections = new Map<string, IWebSocket>();
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;

  constructor(opts: WebChannelAdapterOptions) {
    this.id = opts.id;
  }

  /**
   * apps/api зовёт после WebSocket-handshake с уже-валидированным userId
   * (auth — задача apps/api, не adapter'а). Если для userId уже есть
   * connection — старая закрывается (single-session per user).
   */
  acceptConnection(ws: IWebSocket, externalUserId: string): void {
    const prev = this.connections.get(externalUserId);
    if (prev && prev.readyState === WS_OPEN) {
      try {
        prev.close(4000, "superseded by new connection");
      } catch {
        // ignored
      }
    }
    this.connections.set(externalUserId, ws);
    ws.send(
      encodeServerFrame({ type: "ready", channelId: this.id, userId: externalUserId }),
    );
  }

  /**
   * Принимает raw WebSocket frame от client'а, парсит, генерит Inbound и
   * пушит в очередь.
   */
  onClientFrame(externalUserId: string, raw: string): void {
    const frame = parseClientFrame(raw);
    if (!frame) {
      const ws = this.connections.get(externalUserId);
      if (ws && ws.readyState === WS_OPEN) {
        ws.send(
          encodeServerFrame({ type: "error", code: "bad_frame", message: "frame invalid" }),
        );
      }
      return;
    }
    if (frame.type === "user_text") {
      const inbound: Inbound = {
        channelId: this.id,
        externalMessageId: frame.id,
        externalUserId,
        parts: [{ kind: "text", text: frame.text }],
        receivedAt: Math.floor(Date.now() / 1000),
        raw: frame,
      };
      this.enqueue(inbound);
    }
  }

  /** Client отключился — drop из registry. */
  onDisconnect(externalUserId: string): void {
    this.connections.delete(externalUserId);
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

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.({ value: undefined as unknown as Inbound, done: true });
    }
    for (const ws of this.connections.values()) {
      try {
        if (ws.readyState === WS_OPEN) ws.close(1001, "adapter closing");
      } catch {
        // ignored
      }
    }
    this.connections.clear();
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
            if (queued) return Promise.resolve({ value: queued, done: false });
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
    if (envelope.parts.length === 0) {
      throw new Error("OutboundEnvelope.parts must be non-empty");
    }
    const ws = this.connections.get(envelope.externalUserId);
    if (!ws || ws.readyState !== WS_OPEN) {
      throw new WebDeliveryError(envelope.externalUserId, "no active connection");
    }

    // Web-channel умеет только text. Не-text parts → reject.
    const texts: string[] = [];
    for (const part of envelope.parts as OutboundPart[]) {
      if (part.kind !== "text") {
        throw new WebDeliveryError(
          envelope.externalUserId,
          `unsupported part.kind=${part.kind} (web channel is text-only)`,
        );
      }
      texts.push(part.text);
    }

    // Один envelope → одно сообщение (концатенация частей через \n\n).
    // Frontend получит one bot_text frame.
    const text = texts.join("\n\n");
    const messageId = `srv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    ws.send(
      encodeServerFrame({
        type: "bot_text",
        id: messageId,
        text,
        ...(envelope.replyToExternalMessageId
          ? { replyTo: envelope.replyToExternalMessageId }
          : {}),
      }),
    );
    return {
      channelId: this.id,
      externalMessageId: messageId,
      sentAt: Math.floor(Date.now() / 1000),
    };
  }

  async edit(_opts: EditOpts): Promise<void> {
    throw new Error("WebChannel: edit not supported (capability=false)");
  }

  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("WebChannel: delete not supported (capability=false)");
  }

  async downloadMedia(_mediaRef: MediaRef): Promise<Response> {
    throw new Error("WebChannel: downloadMedia not supported (text-only)");
  }

  async signalTyping(_externalUserId: string): Promise<void> {
    // Web-channel могла бы поддержать typing через отдельный frame
    // ({type:"typing"}), но frontend сам решает рендерить ли indicator.
    // No-op в minimal scope.
  }
}
