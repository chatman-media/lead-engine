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
  | "facebook"
  | "vk"
  | "max"
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
   * Сообщение — это правка ранее отправленного (Telegram `edited_message`,
   * WhatsApp edited, и т.д.), а не новое. externalMessageId совпадает с
   * исходным. Conversation-engine на правку обновляет уже сохранённое
   * сообщение (а не дедупит как ретрай). Каналы без edit-семантики флаг не
   * ставят. См. processInbound.
   */
  edited?: boolean;
  /**
   * Слабый bootstrap-сигнал языка от канала (не язык переписки!).
   * Telegram: `from.language_code` — язык интерфейса клиента (`en-US`, `ru`, …).
   * WhatsApp / VK / web — обычно undefined. Conversation-engine использует
   * это только если текстовый детект не дал результата (media-only, цифры).
   * Никогда не перебивает confident-детект по тексту. См. #735 `language.ts`.
   */
  channelLangHint?: string;
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

export interface OperatorHandoffMeta {
  reason: "kyc_review" | "payment_review" | "office_payout" | "payout_review" | "operator_request";
  title: string;
  action: string;
  contractId?: string;
  priority?: "low" | "normal" | "high";
  orderId?: number;
  stageSlug?: string;
  accepted?: string;
  pending?: string;
  reviewPath?: string;
  context?: string;
  urgency?: string;
  amount?: string;
  rail?: string;
  network?: string;
  payoutPointId?: number;
}

export type OutboundPart =
  | { kind: "text"; text: string; parseMode?: "markdown" | "html" }
  | { kind: "photo"; mediaRef: MediaRef; caption?: string }
  | { kind: "video"; mediaRef: MediaRef; caption?: string }
  | { kind: "document"; mediaRef: MediaRef; caption?: string };

export type WhatsAppTemplateCategory = "marketing" | "utility" | "authentication";

export type WhatsAppTemplateParameter =
  | { type: "text"; text: string }
  | { type: "currency"; currency: Record<string, unknown> }
  | { type: "date_time"; date_time: Record<string, unknown> }
  | { type: "image" | "video" | "document"; mediaRef: MediaRef };

export interface WhatsAppTemplateComponent {
  type: "header" | "body" | "footer" | "button";
  subType?: "quick_reply" | "url" | "copy_code";
  index?: string;
  parameters?: WhatsAppTemplateParameter[];
}

export interface WhatsAppTemplateMessage {
  /** Approved WhatsApp template name in Meta Business Manager. */
  name: string;
  /** BCP-47-ish Meta language code, e.g. "en_US". */
  languageCode: string;
  /** Category approved by Meta. Used by policy/ops checks. */
  category?: WhatsAppTemplateCategory;
  /** Worker must reject cold outbound unless this is true. */
  approved?: boolean;
  components?: WhatsAppTemplateComponent[];
}

export interface WhatsAppOptIn {
  source: string;
  acceptedAt: number;
  categories?: WhatsAppTemplateCategory[];
}

export interface WhatsAppOutboundMeta {
  /** True for cold/proactive WhatsApp sends where free-form is not allowed. */
  requiresTemplate?: boolean;
  /**
   * Unix timestamp until which free-form WhatsApp messages are allowed. Outside
   * this window, worker requires an approved template.
   */
  freeFormWindowUntil?: number;
  template?: WhatsAppTemplateMessage;
  optIn?: WhatsAppOptIn;
  providerRequestId?: number;
}

export interface OutboundTransportMeta {
  whatsapp?: WhatsAppOutboundMeta;
}

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
  /** Operator-facing action card emitted alongside the client reply. */
  operatorHandoff?: OperatorHandoffMeta;
  /** Channel-specific send policy/payload metadata. */
  transport?: OutboundTransportMeta;
  /**
   * #697 — задание на удаление ранее отправленного сообщения (вместо send).
   * Если задан, диспетчер зовёт adapter.delete (parts игнорируются). Каналы
   * без capabilities.delete (WhatsApp/web/…) — no-op.
   */
  deleteExternalMessageId?: string;
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
