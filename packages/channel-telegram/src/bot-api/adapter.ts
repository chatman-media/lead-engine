import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  OutboundPart,
  ReplyMarkup,
  Sent,
} from "@chatman-media/channel-core";
import { TelegramClient, type TelegramClientOptions } from "./client.ts";
import type { TgReplyMarkup, TgUpdate } from "./types.ts";
import { parseUpdate } from "./update-parser.ts";

export interface TelegramBotAdapterOptions extends TelegramClientOptions {
  /** Уникальный id канала в платформе (соответствует `channels.id` в БД). */
  id: string;
}

const TG_BOT_CAPABILITIES: ChannelCapabilities = {
  text: true,
  photo: true,
  video: true,
  // Bot API позволяет отправлять voice через файл, но в нашем пайплайне голос
  // только входит (от кандидата), не отправляется ботом. Если понадобится —
  // расширим OutboundPart и снимем флаг.
  voice: false,
  document: true,
  edit: true,
  delete: true,
  callbackQuery: true,
  typing: true,
};

function toTgReplyMarkup(rm: ReplyMarkup | undefined): TgReplyMarkup | undefined {
  if (!rm?.inlineButtons) return undefined;
  return {
    inline_keyboard: rm.inlineButtons.map((row) =>
      row.map((b) => ({ text: b.label, callback_data: b.callbackData })),
    ),
  };
}

function parseMode(mode: "markdown" | "html" | undefined): "MarkdownV2" | "HTML" | undefined {
  if (mode === "markdown") return "MarkdownV2";
  if (mode === "html") return "HTML";
  return undefined;
}

/**
 * Telegram Bot API адаптер. Получает входящие через `pushUpdate()` (HTTP webhook
 * в apps/api дёргает этот метод на каждый incoming POST), отправляет исходящие
 * через TelegramClient.
 *
 * Адаптер не делает rate-limiting и retry сам — это ответственность outbound-
 * dispatcher'а в apps/worker (использует `attempts`/`sent_at` в outbound_queue).
 */
export class TelegramBotAdapter implements ChannelAdapter {
  readonly kind = "telegram_bot" as const;
  readonly id: string;
  readonly capabilities = TG_BOT_CAPABILITIES;

  private readonly client: TelegramClient;
  private readonly inbox: Inbound[] = [];
  private waiters: Array<(v: IteratorResult<Inbound>) => void> = [];
  private closed = false;

  constructor(opts: TelegramBotAdapterOptions) {
    this.id = opts.id;
    this.client = new TelegramClient(opts);
  }

  /** Доступ к raw-клиенту для admin-операций (setWebhook, getMe, и т.д.). */
  get rawClient(): TelegramClient {
    return this.client;
  }

  /**
   * Пушит сырой Telegram update в очередь. Парсится в Inbound; если update
   * нерелевантен (нет сообщения и нет callback_query) — silent drop.
   * Вызывается из HTTP-хэндлера webhook'а.
   */
  pushUpdate(update: TgUpdate): void {
    const inbound = parseUpdate(this.id, update);
    if (!inbound) return;
    this.enqueue(inbound);
  }

  private enqueue(inbound: Inbound): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: inbound, done: false });
      return;
    }
    this.inbox.push(inbound);
  }

  /** Закрыть стрим: receive() завершится после дренажа очереди. */
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
    if (envelope.parts.length === 0) {
      throw new Error("OutboundEnvelope.parts must be non-empty");
    }
    const chatId = Number(envelope.externalUserId);
    if (Number.isNaN(chatId)) {
      throw new Error(`telegram-bot: invalid externalUserId "${envelope.externalUserId}"`);
    }

    // Sequential send for каждой части — Bot API не поддерживает atomic batch.
    // Возвращаем id ПЕРВОГО отправленного — это якорь для replyTo/edit/delete.
    let firstMessageId: number | undefined;
    const lastIdx = envelope.parts.length - 1;
    for (let i = 0; i < envelope.parts.length; i++) {
      const part = envelope.parts[i] as OutboundPart;
      // reply_markup и reply_to_message_id применяются только к последней части,
      // чтобы кнопки висели под финальным сообщением.
      const isLast = i === lastIdx;
      const replyMarkup = isLast ? toTgReplyMarkup(envelope.replyMarkup) : undefined;
      const replyToMessageId =
        i === 0 && envelope.replyToExternalMessageId !== undefined
          ? Number(envelope.replyToExternalMessageId)
          : undefined;

      let res: { message_id: number };
      if (part.kind === "text") {
        res = await this.client.sendMessage({
          chatId,
          text: part.text,
          ...(parseMode(part.parseMode) ? { parseMode: parseMode(part.parseMode) } : {}),
          ...(replyMarkup ? { replyMarkup } : {}),
          ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
        });
      } else if (part.kind === "photo") {
        res = await this.client.sendPhoto({
          chatId,
          photoFileId: part.mediaRef.externalRef,
          ...(part.caption ? { caption: part.caption } : {}),
        });
      } else if (part.kind === "video") {
        res = await this.client.sendVideo({
          chatId,
          videoFileId: part.mediaRef.externalRef,
          ...(part.caption ? { caption: part.caption } : {}),
        });
      } else {
        res = await this.client.sendDocument({
          chatId,
          documentFileId: part.mediaRef.externalRef,
          ...(part.caption ? { caption: part.caption } : {}),
        });
      }
      if (firstMessageId === undefined) firstMessageId = res.message_id;
    }

    return {
      channelId: this.id,
      externalMessageId: String(firstMessageId ?? ""),
      sentAt: Math.floor(Date.now() / 1000),
    };
  }

  async edit(opts: EditOpts): Promise<void> {
    const chatId = Number(opts.externalUserId);
    const messageId = Number(opts.externalMessageId);
    if (Number.isNaN(chatId) || Number.isNaN(messageId)) {
      throw new Error("telegram-bot: edit requires numeric externalUserId / externalMessageId");
    }
    await this.client.editMessageText({
      chatId,
      messageId,
      text: opts.text,
      ...(parseMode(opts.parseMode) ? { parseMode: parseMode(opts.parseMode) } : {}),
      ...(toTgReplyMarkup(opts.replyMarkup)
        ? { replyMarkup: toTgReplyMarkup(opts.replyMarkup) as TgReplyMarkup }
        : {}),
    });
  }

  async delete(opts: DeleteOpts): Promise<void> {
    const chatId = Number(opts.externalUserId);
    const messageId = Number(opts.externalMessageId);
    if (Number.isNaN(chatId) || Number.isNaN(messageId)) {
      throw new Error("telegram-bot: delete requires numeric externalUserId / externalMessageId");
    }
    await this.client.deleteMessage({ chatId, messageId });
  }

  downloadMedia(mediaRef: MediaRef): Promise<Response> {
    return this.client.downloadFile(mediaRef.externalRef);
  }

  async signalTyping(externalUserId: string): Promise<void> {
    const chatId = Number(externalUserId);
    if (Number.isNaN(chatId)) return;
    await this.client.sendChatAction({ chatId, action: "typing" });
  }
}
