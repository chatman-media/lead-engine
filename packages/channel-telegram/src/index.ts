export { TelegramBotAdapter, type TelegramBotAdapterOptions } from "./bot-api/adapter.ts";
export { TelegramApiError, TelegramClient } from "./bot-api/client.ts";
export type { FetchLike, TelegramClientOptions } from "./bot-api/client.ts";
export type {
  TgCallbackQuery,
  TgChat,
  TgDocument,
  TgFile,
  TgInlineKeyboardButton,
  TgMessage,
  TgPhotoSize,
  TgReplyMarkup,
  TgSendMessageResult,
  TgUpdate,
  TgUser,
  TgVideo,
  TgVoice,
} from "./bot-api/types.ts";
export { parseUpdate } from "./bot-api/update-parser.ts";
export { TelegramUserbotAdapter } from "./userbot/adapter.ts";
