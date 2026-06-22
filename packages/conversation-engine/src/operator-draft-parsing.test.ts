import { describe, expect, it } from "bun:test";
import type { TgMessage } from "@chatman-media/channel-telegram";
import type { PendingOperatorDraft } from "./operator-bot-shared.ts";
import { extractConversationIdFromReply, previewOrderLine } from "./operator-draft-parsing.ts";

const draft = (metadata: Record<string, unknown> = {}): PendingOperatorDraft => ({
  draftId: "d1",
  tenantId: 1,
  adminId: 2,
  chatId: "100",
  conversationId: 5,
  text: "t",
  metadata,
  createdAt: 0,
  expiresAt: 0,
});

describe("previewOrderLine", () => {
  it("orderId число → 'Заявка: #N'", () => {
    expect(previewOrderLine(draft({ orderId: 77 }))).toBe("Заявка: #77\n\n");
  });
  it("orderId строка → парсится", () => {
    expect(previewOrderLine(draft({ orderId: "42" }))).toBe("Заявка: #42\n\n");
  });
  it("нет/невалидный orderId → пусто", () => {
    expect(previewOrderLine(draft())).toBe("");
    expect(previewOrderLine(draft({ orderId: 0 }))).toBe("");
    expect(previewOrderLine(draft({ orderId: "abc" }))).toBe("");
  });
});

describe("extractConversationIdFromReply", () => {
  it("undefined → null", () => {
    expect(extractConversationIdFromReply(undefined)).toBeNull();
  });

  it("из callback_data операторской кнопки", () => {
    const msg = {
      reply_markup: {
        inline_keyboard: [[{ text: "Взять", callback_data: "op:take:42" }]],
      },
    } as unknown as TgMessage;
    expect(extractConversationIdFromReply(msg)).toBe(42);
  });

  it("из url кнопки /conversations/<id>", () => {
    const msg = {
      reply_markup: {
        inline_keyboard: [[{ text: "Открыть", url: "https://app.test/conversations/13" }]],
      },
    } as unknown as TgMessage;
    expect(extractConversationIdFromReply(msg)).toBe(13);
  });

  it("из текста 'Диалог #N'", () => {
    const msg = { text: "Новая заявка. Диалог #88 ждёт" } as unknown as TgMessage;
    expect(extractConversationIdFromReply(msg)).toBe(88);
  });

  it("ничего не нашлось → null", () => {
    const msg = { text: "просто текст без id" } as unknown as TgMessage;
    expect(extractConversationIdFromReply(msg)).toBeNull();
  });

  it("кнопки без совпадений → fallthrough на текст", () => {
    const msg = {
      reply_markup: {
        inline_keyboard: [[{ text: "Сайт", callback_data: "noise", url: "https://x/other" }]],
      },
      text: "Диалог #5",
    } as unknown as TgMessage;
    expect(extractConversationIdFromReply(msg)).toBe(5);
  });
});
