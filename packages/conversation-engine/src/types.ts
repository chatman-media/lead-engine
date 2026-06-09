import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";

/**
 * Минимальный snapshot tenant'а нужный для pipeline. Резолвится по
 * channels.tenant_id один раз на inbound и прокидывается через context.
 */
export interface TenantContext {
  tenantId: number;
  slug: string;
  llmBillingMode: "byok" | "managed";
}

/**
 * Канал-уровневый контекст. channelId стабильный — соответствует
 * channels.id в БД, использовать его, не external_id.
 */
export interface ChannelContext {
  channelId: number;
  kind: "telegram_bot" | "telegram_userbot" | "whatsapp" | "facebook" | "vk" | "max" | "web";
  /** External id канала у провайдера (bot username, phone). Для логов. */
  externalId: string;
}

/**
 * Решение pipeline по входящему: что было сделано и нужны ли downstream
 * действия. Возвращается из processInbound() так чтобы apps/worker мог
 * dispatch'ить telemetry / WebSocket events без дёрганья БД.
 */
export interface ProcessInboundResult {
  contactId: number;
  conversationId: number;
  /**
   * Сообщение записано в messages? Может быть false если inbound полностью
   * проигнорирован (например, callback_query без матча на функционал).
   */
  persisted: boolean;
  /**
   * Сколько OutboundEnvelope'ов было поставлено в outbound_queue в этом
   * pipeline-проходе. 0 = бот ничего не отвечает (mediaOnly / handover-mode).
   */
  outboundEnqueued: number;
  /**
   * Текст user-сообщения (после inboundText() свёртки). Заполняется когда
   * pipeline вызван с `deferReply: true` — `generateReplyAndEnqueue` потом
   * использует это значение для reply.generate БЕЗ нового read'а из БД.
   * Когда deferReply=false (default) — поле не выставляется.
   */
  userMessageText?: string;
  /** True если только media без caption (бот не должен отвечать). */
  mediaOnly?: boolean;
  /**
   * True если stage classifier / memory extractor были отложены, потому что
   * caller попросил split-pipeline. Caller должен завершить этот шаг до
   * reply.generate, чтобы ответ видел свежие stage/memory writes.
   */
  postProcessingDeferred?: boolean;
  /** current_stage до deferred stage-classifier; нужно для classifier input/log. */
  previousStage?: string | null;
  /** Conversation была создана на этом inbound turn. */
  conversationCreated?: boolean;
  /**
   * True если processInbound пропустил reply.generate (deferReply=true) —
   * caller должен вызвать `generateReplyAndEnqueue` чтобы завершить
   * pipeline. False (или undefined) = pipeline отработал полностью.
   */
  replyDeferred?: boolean;
  /** Если конверсация переключилась в режим оператора — сюда попадает причина. */
  escalatedReason?: string;
}

/**
 * Дешёвый side-effect sink. Тонкая обёртка чтобы pipeline не зависел от
 * конкретного логгера/EventBus'а. apps/worker подсоединяет реальный sink
 * на boot. Все поля опциональные — testkit-fake может не реализовывать
 * ничего и pipeline всё равно работает.
 */
export interface PipelineSink {
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
  emit?: (event: PipelineEvent) => void;
}

export type PipelineEvent =
  | { type: "inbound-received"; tenantId: number; conversationId: number; inbound: Inbound }
  | { type: "message-persisted"; tenantId: number; conversationId: number; messageId: number; role: "user" | "assistant" }
  | { type: "outbound-enqueued"; tenantId: number; conversationId: number; queueItemId: number; envelope: OutboundEnvelope }
  | { type: "conversation-escalated"; tenantId: number; conversationId: number; reason: string };

/**
 * Стандартный clock — для тестирования (replace на fake clock в unit-тестах).
 * `nowEpoch()` возвращает unix-seconds — формат, в котором БД хранит timestamps.
 */
export interface Clock {
  nowEpoch(): number;
}

export const systemClock: Clock = {
  nowEpoch: () => Math.floor(Date.now() / 1000),
};
