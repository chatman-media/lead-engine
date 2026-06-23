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
import { VkClient, type VkClientOptions } from "./client.ts";
import { parseCallbackPayload } from "./parser.ts";
import type { VkCallbackPayload } from "./types.ts";

const VK_CAPABILITIES: ChannelCapabilities = {
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

export interface VkAdapterOptions extends VkClientOptions {
  /** Уникальный id канала в платформе (соответствует channels.id в БД). */
  id: string;
}

export class VkAdapter implements ChannelAdapter {
  readonly kind = "vk" as const;
  readonly id: string;
  readonly capabilities = VK_CAPABILITIES;

  private readonly client: VkClient;
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;

  constructor(opts: VkAdapterOptions) {
    this.id = opts.id;
    this.client = new VkClient(opts);
  }

  get rawClient(): VkClient {
    return this.client;
  }

  pushUpdate(payload: VkCallbackPayload): void {
    for (const inbound of parseCallbackPayload(this.id, payload)) this.enqueue(inbound);
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
              return Promise.resolve({
                value: undefined as unknown as Inbound,
                done: true,
              });
            }
            const queued = self.inbox.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (self.closed) {
              return Promise.resolve({
                value: undefined as unknown as Inbound,
                done: true,
              });
            }
            return new Promise((resolve) => {
              self.waiters.push(resolve);
              if (signal) {
                signal.addEventListener(
                  "abort",
                  () => {
                    const idx = self.waiters.indexOf(resolve);
                    if (idx >= 0) self.waiters.splice(idx, 1);
                    resolve({
                      value: undefined as unknown as Inbound,
                      done: true,
                    });
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
    let firstMessageId: string | undefined;
    for (const part of envelope.parts as OutboundPart[]) {
      if (part.kind !== "text") {
        throw new Error(`VK: unsupported part.kind=${part.kind}`);
      }
      const sent = await this.client.sendText({
        peerId: envelope.externalUserId,
        text: part.text,
      });
      if (firstMessageId === undefined) firstMessageId = sent.messageId;
    }
    return {
      channelId: this.id,
      externalMessageId: firstMessageId ?? "",
      sentAt: Math.floor(Date.now() / 1000),
    };
  }

  async edit(_opts: EditOpts): Promise<void> {
    throw new Error("VK: edit not supported (capability=false)");
  }

  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("VK: delete not supported (capability=false)");
  }

  downloadMedia(mediaRef: MediaRef): Promise<Response> {
    return this.client.downloadMedia(mediaRef.externalRef);
  }

  async signalTyping(_externalUserId: string): Promise<void> {
    // VK typing indicator is intentionally disabled until verified.
  }
}
