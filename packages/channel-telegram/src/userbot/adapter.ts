import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  Sent,
} from "@chatman-media/channel-core";

/**
 * MTProto userbot адаптер (личный аккаунт оператора через gramjs).
 *
 * СТАТУС: stub. Полная имплементация будет в следующей итерации Этапа 2.
 * Портируется из `sales-guru/src/telegram/userbot.ts` (~1095 LOC):
 *   - long-running polling loop через gramjs
 *   - выкачка медиа (MTProto не даёт публичный file_id, нужен onProgress
 *     download)
 *   - rate-limited send queue (через DB-таблицу outbound_queue)
 *   - sessionString-based auth (хранится в userbot_session таблице)
 *
 * Причина оставить stub сейчас: реализация требует осторожной работы с
 * gramjs subprocess и DB-orchestration (Этап 5). Эта прослойка фиксирует
 * контракт — что должно быть реализовано — и позволяет conversation-engine
 * и apps/worker писать код против ChannelAdapter уже сейчас.
 */
export class TelegramUserbotAdapter implements ChannelAdapter {
  readonly kind = "telegram_userbot" as const;
  readonly id: string;
  readonly capabilities: ChannelCapabilities = {
    text: true,
    photo: true,
    video: true,
    voice: true,
    document: true,
    // MTProto умеет edit/delete, но логика тонкая — оставим до полной импл.
    edit: false,
    delete: true,
    callbackQuery: false,
    typing: true,
  };

  constructor(opts: { id: string }) {
    this.id = opts.id;
  }

  receive(_signal?: AbortSignal): AsyncIterable<Inbound> {
    throw new Error("TelegramUserbotAdapter.receive(): not implemented");
  }

  send(_envelope: OutboundEnvelope): Promise<Sent> {
    throw new Error("TelegramUserbotAdapter.send(): not implemented");
  }

  edit(_opts: EditOpts): Promise<void> {
    throw new Error("TelegramUserbotAdapter.edit(): not implemented");
  }

  delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("TelegramUserbotAdapter.delete(): not implemented");
  }

  downloadMedia(_mediaRef: MediaRef): Promise<Response> {
    throw new Error("TelegramUserbotAdapter.downloadMedia(): not implemented");
  }

  signalTyping(_externalUserId: string): Promise<void> {
    throw new Error("TelegramUserbotAdapter.signalTyping(): not implemented");
  }
}
