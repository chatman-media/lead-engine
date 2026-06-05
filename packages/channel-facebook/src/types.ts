// Минимальный набор Facebook Messenger Platform (Meta Graph) webhook-типов,
// которыми мы пользуемся. Полная спецификация:
//   https://developers.facebook.com/docs/messenger-platform/reference/webhook-events

export interface FbAttachmentPayload {
  /** Прямой (подписанный) URL медиа на CDN Meta. */
  url?: string;
  sticker_id?: number;
  [k: string]: unknown;
}

export interface FbAttachment {
  type: "image" | "video" | "audio" | "file" | "fallback" | string;
  payload: FbAttachmentPayload;
}

export interface FbQuickReply {
  payload: string;
}

export interface FbMessage {
  mid: string;
  text?: string;
  attachments?: FbAttachment[];
  quick_reply?: FbQuickReply;
  /** Echo нашего же исходящего сообщения — игнорируем. */
  is_echo?: boolean;
}

export interface FbPostback {
  mid?: string;
  title?: string;
  payload: string;
}

/** Одно событие в `entry[].messaging[]`. */
export interface FbMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  /** Epoch в миллисекундах (в отличие от WhatsApp — там секунды-строкой). */
  timestamp: number;
  message?: FbMessage;
  postback?: FbPostback;
  /** delivery / read — статус-события, пропускаются. */
  delivery?: unknown;
  read?: unknown;
}

export interface FbEntry {
  /** Page ID. */
  id: string;
  time: number;
  messaging: FbMessagingEvent[];
}

export interface FbWebhookPayload {
  object: "page" | string;
  entry: FbEntry[];
}
