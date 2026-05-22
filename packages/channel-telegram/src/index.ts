export {
  TelegramBotAdapter,
  type TelegramBotAdapterOptions,
} from "./bot-api/adapter.ts";
export type { FetchLike, TelegramClientOptions } from "./bot-api/client.ts";
export { TelegramApiError, TelegramClient } from "./bot-api/client.ts";
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
export {
  TelegramUserbotAdapter,
  type TelegramUserbotAdapterOptions,
  type UserbotHealthEvent,
  type UserbotHealthStatus,
} from "./userbot/adapter.ts";
export {
  type FinishedUserbotLogin,
  finishUserbotLogin,
  type StartedUserbotLogin,
  startUserbotLogin,
  submitUserbot2fa,
  submitUserbotCode,
  UserbotLoginError,
  type UserbotLoginErrorCode,
} from "./userbot/login.ts";
