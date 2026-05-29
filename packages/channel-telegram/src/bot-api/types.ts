// Minimal subset of Telegram Bot API types we use.

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

/**
 * One frame of a Telegram photo upload. Telegram delivers an array of
 * sizes per photo (thumbnail / medium / original) — we record the
 * largest for diagnostic purposes; counting is by message, not by size.
 */
/**
 * Result of `getFile`. `file_path` is a relative path the Bot File API
 * appends to `https://api.telegram.org/file/bot<TOKEN>/...` to download
 * the bytes. The path is short-lived (~1 hour) and tied to the token.
 */
export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  /** Relative path. Undefined when the file is too large (Telegram caps
   *  download API at ~20 MB). */
  file_path?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** «Кружок» — видео-сообщение Telegram (квадратное короткое видео). */
export interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  /** Caption that can accompany media uploads (photo / video / document /
   *  voice). Treated as the message's "text" by the persistence layer
   *  so RAG / extractors see the candidate's words. */
  caption?: string;
  /** Photo upload — present on photo messages, includes all delivered sizes. */
  photo?: TgPhotoSize[];
  video?: TgVideo;
  voice?: TgVoice;
  /** «Кружок» — видео-сообщение (video note). Для видео-верификации. */
  video_note?: TgVideoNote;
  document?: TgDocument;
  /** When this message is a reply to another, Telegram inlines the
   *  parent message here. We use it to detect operator replies to lead
   *  cards (matched by the parent's `message_id` against
   *  `leads.ops_message_id`). */
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgSendMessageResult {
  message_id: number;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface TgReplyMarkup {
  inline_keyboard?: TgInlineKeyboardButton[][];
}
