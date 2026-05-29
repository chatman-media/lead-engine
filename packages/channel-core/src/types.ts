// Канал-агностичные типы. Никаких зависимостей от Telegram/WhatsApp/etc.
// Адаптеры (channel-telegram, channel-whatsapp, …) реализуют контракт через
// маппинг своих native payload'ов в эти типы.

/**
 * Виды каналов, поддерживаемых платформой. Перечисление расширяется по мере
 * добавления адаптеров — но conversation-engine не должен switchиться по
 * этому полю: всю канал-специфику должен прятать ChannelAdapter.
 */
export type ChannelKind =
  | "telegram_bot"
  | "telegram_userbot"
  | "whatsapp"
  | "web";

/**
 * Капабилити канала — что конкретный адаптер реально умеет. WhatsApp, например,
 * не даёт edit; web-chat может не уметь callback_query. conversation-engine
 * читает это, чтобы решать, какие части envelope можно отправить.
 */
export interface ChannelCapabilities {
  text: boolean;
  photo: boolean;
  video: boolean;
  voice: boolean;
  document: boolean;
  edit: boolean;
  delete: boolean;
  callbackQuery: boolean;
  typing: boolean;
}

/**
 * Канал-агностичная ссылка на медиа. Для Telegram externalRef = file_id,
 * для WhatsApp = media_id, для web = upload-URL. Адаптер сам резолвит
 * externalRef → байты через downloadMedia().
 */
export interface MediaRef {
  channelId: string;
  externalRef: string;
}

// ---- Inbound -----------------------------------------------------------

export type InboundPart =
  | { kind: "text"; text: string }
  | { kind: "photo"; mediaRef: MediaRef; caption?: string }
  | { kind: "video"; mediaRef: MediaRef; caption?: string }
  | { kind: "voice"; mediaRef: MediaRef; durationSec?: number }
  // Telegram «кружок» (видео-сообщение). Используется для опциональной
  // видео-верификации личности в обменнике (уходит оператору).
  | { kind: "video_note"; mediaRef: MediaRef; durationSec?: number }
  | { kind: "document"; mediaRef: MediaRef; mimeType?: string; fileName?: string }
  | { kind: "callback_query"; data: string; originalMessageId: string };

/**
 * Входящее событие. Адаптер собирает его из webhook-payload (BotAPI) или
 * MTProto-update (userbot) — наверх отдаётся уже unified-структура.
 */
export interface Inbound {
  channelId: string;
  externalMessageId: string;
  externalUserId: string;
  externalUsername?: string;
  parts: InboundPart[];
  receivedAt: number;
  /**
   * Escape-hatch: канал-специфичный raw payload. Conversation-engine не
   * должен на это смотреть — нужно только для audit/debug и адаптер-специфичных
   * расширений (например, MTProto reply-to-resolve).
   */
  raw: unknown;
}

// ---- Outbound ----------------------------------------------------------

export interface ReplyMarkup {
  /** Inline-кнопки: каждая внутренняя строка — это ряд. */
  inlineButtons?: Array<Array<{ label: string; callbackData: string }>>;
}

export type OutboundPart =
  | { kind: "text"; text: string; parseMode?: "markdown" | "html" }
  | { kind: "photo"; mediaRef: MediaRef; caption?: string }
  | { kind: "video"; mediaRef: MediaRef; caption?: string }
  | { kind: "document"; mediaRef: MediaRef; caption?: string };

/**
 * Запрос на отправку. conversation-engine кладёт это в outbound-очередь,
 * worker дёргает соответствующий ChannelAdapter.send().
 */
export interface OutboundEnvelope {
  channelId: string;
  externalUserId: string;
  parts: OutboundPart[];
  replyToExternalMessageId?: string;
  replyMarkup?: ReplyMarkup;
  /** Опционально — для дедупликации повторных send-попыток. */
  idempotencyKey?: string;
}

/** Результат успешной отправки. */
export interface Sent {
  channelId: string;
  externalMessageId: string;
  sentAt: number;
}

// ---- Edit / Delete -----------------------------------------------------

export interface EditOpts {
  channelId: string;
  externalUserId: string;
  externalMessageId: string;
  /** Новый текст. Замена и фото/видео в этом API не поддерживается — channel-specific. */
  text: string;
  parseMode?: "markdown" | "html";
  replyMarkup?: ReplyMarkup;
}

export interface DeleteOpts {
  channelId: string;
  externalUserId: string;
  externalMessageId: string;
}
