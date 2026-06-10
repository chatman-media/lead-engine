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
import { WhatsAppClient, type WhatsAppClientOptions } from "./client.ts";
import { parseWebhookPayload } from "./parser.ts";
import type { WaWebhookPayload } from "./types.ts";

const WA_CAPABILITIES: ChannelCapabilities = {
  text: true,
  photo: true,
  video: true,
  voice: true,
  document: true,
  edit: false, // Cloud API: edits limited (template-only); disabled пока
  delete: false, // Cloud API: delete не expose'нут — оставляем false
  callbackQuery: false,
  typing: false,
};

export interface WhatsAppCloudAdapterOptions extends WhatsAppClientOptions {
  /** Уникальный id канала в платформе (соответствует channels.id в БД). */
  id: string;
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly kind = "whatsapp" as const;
  readonly id: string;
  readonly capabilities = WA_CAPABILITIES;

  private readonly client: WhatsAppClient;
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;

  constructor(opts: WhatsAppCloudAdapterOptions) {
    this.id = opts.id;
    this.client = new WhatsAppClient(opts);
  }

  /** Raw-клиент для admin-операций (verify webhook, send template). */
  get rawClient(): WhatsAppClient {
    return this.client;
  }

  /**
   * apps/api дёргает на каждый webhook POST. Один payload может содержать
   * несколько messages — все enqueue'аются.
   */
  pushUpdate(payload: WaWebhookPayload): void {
    const inbounds = parseWebhookPayload(this.id, payload);
    for (const i of inbounds) this.enqueue(i);
  }

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
    const template = envelope.transport?.whatsapp?.template;
    if (!template && envelope.parts.length === 0) {
      throw new Error("OutboundEnvelope.parts must be non-empty");
    }
    const to = envelope.externalUserId;
    if (template) {
      const sent = await this.client.sendTemplate({ to, template });
      return {
        channelId: this.id,
        externalMessageId: sent.messageId,
        sentAt: Math.floor(Date.now() / 1000),
      };
    }
    let firstMessageId: string | undefined;
    for (const part of envelope.parts as OutboundPart[]) {
      let sentId: string;
      if (part.kind === "text") {
        const r = await this.client.sendText({ to, text: part.text });
        sentId = r.messageId;
      } else if (part.kind === "photo") {
        const r = await this.client.sendMedia({
          to,
          kind: "image",
          mediaId: part.mediaRef.externalRef,
          ...(part.caption ? { caption: part.caption } : {}),
        });
        sentId = r.messageId;
      } else if (part.kind === "video") {
        const r = await this.client.sendMedia({
          to,
          kind: "video",
          mediaId: part.mediaRef.externalRef,
          ...(part.caption ? { caption: part.caption } : {}),
        });
        sentId = r.messageId;
      } else {
        const r = await this.client.sendMedia({
          to,
          kind: "document",
          mediaId: part.mediaRef.externalRef,
          ...(part.caption ? { caption: part.caption } : {}),
        });
        sentId = r.messageId;
      }
      if (firstMessageId === undefined) firstMessageId = sentId;
    }
    return {
      channelId: this.id,
      externalMessageId: firstMessageId ?? "",
      sentAt: Math.floor(Date.now() / 1000),
    };
  }

  async edit(_opts: EditOpts): Promise<void> {
    throw new Error("WhatsApp Cloud: edit not supported (capability=false)");
  }

  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("WhatsApp Cloud: delete not supported (capability=false)");
  }

  downloadMedia(mediaRef: MediaRef): Promise<Response> {
    return this.client.downloadMedia(mediaRef.externalRef);
  }

  async signalTyping(_externalUserId: string): Promise<void> {
    // Cloud API не expose'ит typing-indicator publicly. No-op.
  }
}
