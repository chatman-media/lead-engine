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
import { MessengerClient, type MessengerClientOptions } from "./client.ts";
import { parseWebhookPayload } from "./parser.ts";
import type { FbWebhookPayload } from "./types.ts";

const FB_CAPABILITIES: ChannelCapabilities = {
  text: true,
  photo: true,
  video: true,
  voice: true,
  document: true,
  edit: false, // Messenger Send API не даёт edit
  delete: false, // и delete
  callbackQuery: true, // postbacks / quick replies
  typing: true, // sender_action typing_on
};

export interface MessengerAdapterOptions extends MessengerClientOptions {
  /** Уникальный id канала в платформе (соответствует channels.id в БД). */
  id: string;
}

/**
 * Facebook Messenger channel adapter. Inbound — через webhook push
 * (`pushUpdate` дёргает apps/api на каждый POST), outbound — через Send API.
 * Зеркалит WhatsAppCloudAdapter: тот же Meta Graph, отличается формат payload
 * (`entry[].messaging[]`) и эндпоинт отправки (`/me/messages`).
 */
export class MessengerAdapter implements ChannelAdapter {
  readonly kind = "facebook" as const;
  readonly id: string;
  readonly capabilities = FB_CAPABILITIES;

  private readonly client: MessengerClient;
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;

  constructor(opts: MessengerAdapterOptions) {
    this.id = opts.id;
    this.client = new MessengerClient(opts);
  }

  /** Raw-клиент для admin-операций (validate token, sender_action). */
  get rawClient(): MessengerClient {
    return this.client;
  }

  /**
   * apps/api дёргает на каждый webhook POST. Один payload может содержать
   * несколько messaging-событий — все enqueue'аются.
   */
  pushUpdate(payload: FbWebhookPayload): void {
    for (const i of parseWebhookPayload(this.id, payload)) this.enqueue(i);
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
    if (envelope.parts.length === 0) {
      throw new Error("OutboundEnvelope.parts must be non-empty");
    }
    const to = envelope.externalUserId;
    let firstMessageId: string | undefined;
    for (const part of envelope.parts as OutboundPart[]) {
      let sentId: string;
      if (part.kind === "text") {
        const r = await this.client.sendText({ to, text: part.text });
        sentId = r.messageId;
      } else if (part.kind === "photo") {
        const r = await this.client.sendAttachment({
          to,
          kind: "image",
          url: part.mediaRef.externalRef,
        });
        sentId = r.messageId;
      } else if (part.kind === "video") {
        const r = await this.client.sendAttachment({
          to,
          kind: "video",
          url: part.mediaRef.externalRef,
        });
        sentId = r.messageId;
      } else {
        const r = await this.client.sendAttachment({
          to,
          kind: "file",
          url: part.mediaRef.externalRef,
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
    throw new Error("Messenger: edit not supported (capability=false)");
  }

  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("Messenger: delete not supported (capability=false)");
  }

  downloadMedia(mediaRef: MediaRef): Promise<Response> {
    return this.client.downloadMedia(mediaRef.externalRef);
  }

  async signalTyping(externalUserId: string): Promise<void> {
    await this.client.sendAction({ to: externalUserId, action: "typing_on" });
  }
}
