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
import { MaxClient, type MaxClientOptions, parseMaxRecipient } from "./client.ts";
import { parseUpdatePayload } from "./parser.ts";
import type { MaxUpdate } from "./types.ts";

const MAX_CAPABILITIES: ChannelCapabilities = {
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

export interface MaxAdapterOptions extends MaxClientOptions {
  /** Уникальный id канала в платформе (соответствует channels.id в БД). */
  id: string;
}

export class MaxAdapter implements ChannelAdapter {
  readonly kind = "max" as const;
  readonly id: string;
  readonly capabilities = MAX_CAPABILITIES;

  private readonly client: MaxClient;
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;

  constructor(opts: MaxAdapterOptions) {
    this.id = opts.id;
    this.client = new MaxClient(opts);
  }

  get rawClient(): MaxClient {
    return this.client;
  }

  pushUpdate(payload: MaxUpdate): void {
    for (const inbound of parseUpdatePayload(this.id, payload)) this.enqueue(inbound);
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
        throw new Error(`MAX: unsupported part.kind=${part.kind}`);
      }
      const sent = await this.client.sendText({
        externalUserId: envelope.externalUserId,
        text: part.text,
        ...(part.parseMode ? { format: part.parseMode } : {}),
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
    throw new Error("MAX: edit not supported (capability=false)");
  }

  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("MAX: delete not supported (capability=false)");
  }

  downloadMedia(mediaRef: MediaRef): Promise<Response> {
    return this.client.downloadMedia(mediaRef.externalRef);
  }

  async signalTyping(externalUserId: string): Promise<void> {
    const recipient = parseMaxRecipient(externalUserId);
    if (recipient.kind === "chat") {
      await this.client.sendAction({
        chatId: recipient.id,
        action: "typing_on",
      });
    }
  }
}
