// Чистые парсеры/форматтеры draft-flow оператор-бота, вынесенные из
// operator-bot-handler: строка превью заявки и извлечение conversationId из
// сообщения-реплая (по inline-кнопкам / тексту). Без сети/БД.

import type { TgMessage } from "@chatman-media/channel-telegram";
import { parseOperatorActionCallbackData } from "./operator-bot-actions.ts";
import type { PendingOperatorDraft } from "./operator-bot-shared.ts";

/** Строка «Заявка: #N» для превью черновика (пусто, если orderId нет). */
export function previewOrderLine(draft: PendingOperatorDraft): string {
  const rawOrderId = draft.metadata?.orderId;
  const orderId =
    typeof rawOrderId === "number" && Number.isInteger(rawOrderId)
      ? rawOrderId
      : typeof rawOrderId === "string"
        ? Number.parseInt(rawOrderId, 10)
        : null;
  return orderId && orderId > 0 ? `Заявка: #${orderId}\n\n` : "";
}

/**
 * conversationId из сообщения, на которое отвечает оператор: сперва из
 * callback_data / url инлайн-кнопок карточки, потом из текста (Диалог #N).
 */
export function extractConversationIdFromReply(message: TgMessage | undefined): number | null {
  if (!message) return null;
  const rows = message.reply_markup?.inline_keyboard ?? [];
  for (const row of rows) {
    for (const button of row) {
      const action = parseOperatorActionCallbackData(button.callback_data);
      if (action.ok) return action.payload.conversationId;
      const urlMatch = button.url?.match(/\/conversations\/(\d+)(?:\D|$)/);
      if (urlMatch?.[1]) return Number.parseInt(urlMatch[1], 10);
    }
  }
  const textMatch = message.text?.match(/(?:Диалог|чат)\s*#?(\d+)/i);
  return textMatch?.[1] ? Number.parseInt(textMatch[1], 10) : null;
}
