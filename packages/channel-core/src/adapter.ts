import type {
  ChannelCapabilities,
  ChannelKind,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  Sent,
} from "./types.ts";

/**
 * Контракт канала. Конкретные реализации:
 *   - `@chatman-media/channel-telegram` (BotAPI + MTProto userbot)
 *   - `@chatman-media/channel-whatsapp` (когда появится)
 *   - testkit/in-memory adapter для тестов
 *
 * Адаптер инкапсулирует ВСЁ, что специфично для платформы: protocol, rate
 * limits, media-API, retry-policy. Выше адаптера никто не должен знать про
 * Telegram-конкретику (chat_id, file_id, MTProto sessions и т.д.).
 *
 * Жизненный цикл:
 *   1. Конструируется в worker'е с per-tenant credentials.
 *   2. `receive()` запускает long-running stream входящих (webhook drain
 *      или MTProto polling) — крутится до cancellation.
 *   3. `send()`/`edit()`/`delete()` вызываются из conversation-engine при
 *      обработке outbound-queue.
 *   4. `downloadMedia()` дёргается KB-ingest / photo-classifier для байтов.
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Уникальный id канала в платформе (соответствует `channels.id` в БД). */
  readonly id: string;
  readonly capabilities: ChannelCapabilities;

  /**
   * Stream входящих. Адаптер сам решает, как наполнять (webhook-push для
   * BotAPI, polling для MTProto). conversation-engine просто for-of'ит и
   * передаёт каждый Inbound в process-inbound.
   */
  receive(signal?: AbortSignal): AsyncIterable<Inbound>;

  send(envelope: OutboundEnvelope): Promise<Sent>;
  edit(opts: EditOpts): Promise<void>;
  /** No-op если канал не поддерживает delete (capabilities.delete = false). */
  delete(opts: DeleteOpts): Promise<void>;

  /**
   * Скачать байты медиа. Адаптер сам резолвит externalRef → URL/blob и
   * возвращает Response (стрим), чтобы вызывающий мог пайпать без буферизации.
   */
  downloadMedia(mediaRef: MediaRef): Promise<Response>;

  /** Индикатор "печатает...". No-op если capabilities.typing = false. */
  signalTyping(externalUserId: string): Promise<void>;
}
