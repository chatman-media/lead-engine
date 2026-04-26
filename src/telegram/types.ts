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

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
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
