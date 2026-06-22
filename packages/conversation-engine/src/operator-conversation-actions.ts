// Действия оператора над режимом диалога (взять в работу / вернуть AI),
// вынесенные из operator-bot-handler. Коллабораторы — TelegramClient + actions
// (db/appUrl/nowEpoch). client читается лениво.

import type { TelegramClient, TgCallbackQuery } from "@chatman-media/channel-telegram";
import { auditLog, conversations } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { Db } from "./dal/types.ts";
import type { OperatorActionPayload, OperatorBotActionKind } from "./operator-bot-actions.ts";
import { conversationUrl } from "./operator-bot-shared.ts";
import { withTenant } from "./with-tenant.ts";

export interface OperatorActionDeps {
  db?: Db;
  appUrl?: string;
  nowEpoch?: () => number;
}

export class OperatorActionHandler {
  constructor(
    private readonly getClient: () => TelegramClient | null,
    private readonly actions: OperatorActionDeps,
  ) {}

  private get client(): TelegramClient | null {
    return this.getClient();
  }

  async handleOperatorAction(
    cq: TgCallbackQuery,
    settings: { adminId: number; tenantId: number },
    input: OperatorActionPayload,
  ): Promise<void> {
    if (!this.client) return;
    if (input.tenantId > 0 && input.tenantId !== settings.tenantId) {
      await this.client.answerCallbackQuery({
        callbackQueryId: cq.id,
        text: "Нет доступа к этому чату",
        showAlert: true,
      });
      return;
    }
    if (input.action === "open_chat") {
      const appUrl = this.actions.appUrl?.replace(/\/+$/, "");
      await this.client.answerCallbackQuery(
        appUrl
          ? {
              callbackQueryId: cq.id,
              url: `${appUrl}/conversations/${input.conversationId}`,
            }
          : {
              callbackQueryId: cq.id,
              text: `Откройте чат #${input.conversationId} в админке`,
              showAlert: true,
            },
      );
      return;
    }
    if (!this.actions.db) {
      await this.client.answerCallbackQuery({
        callbackQueryId: cq.id,
        text: "Действия оператора ещё не настроены",
        showAlert: true,
      });
      return;
    }

    const result = await this.applyConversationModeAction({
      tenantId: settings.tenantId,
      adminId: settings.adminId,
      conversationId: input.conversationId,
      action: input.action,
    });

    await this.client.answerCallbackQuery({
      callbackQueryId: cq.id,
      text: result.toast,
      showAlert: result.kind === "not_found" || result.kind === "error",
    });
    await this.client.sendMessage({
      chatId: String(cq.message?.chat.id ?? cq.from.id),
      parseMode: "HTML",
      text: result.messageHtml,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "👁 Открыть чат",
              url: conversationUrl(this.actions.appUrl, input.conversationId),
            },
          ],
        ],
      },
    });
  }

  async applyConversationModeAction(input: {
    tenantId: number;
    adminId: number;
    conversationId: number;
    action: OperatorBotActionKind;
  }): Promise<{
    kind: "changed" | "noop" | "not_found" | "error";
    toast: string;
    messageHtml: string;
  }> {
    const db = this.actions.db;
    if (!db) {
      return {
        kind: "error",
        toast: "Действия не настроены",
        messageHtml: "⚠️ Действия оператора ещё не настроены.",
      };
    }
    const now = this.actions.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
    const nextMode = input.action === "takeover" ? "human" : "ai";
    const actionName =
      input.action === "takeover"
        ? "conversation.mode.takeover.operator_bot"
        : "conversation.mode.return_to_ai.operator_bot";

    const outcome = await withTenant(db, input.tenantId, async (tx) => {
      const [existing] = await tx
        .select({ mode: conversations.mode })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, input.tenantId),
            eq(conversations.id, input.conversationId),
          ),
        )
        .limit(1);
      if (!existing) return { kind: "not_found" } as const;
      if (existing.mode === nextMode) {
        return { kind: "noop", from: existing.mode, to: nextMode } as const;
      }

      await tx
        .update(conversations)
        .set({
          mode: nextMode,
          lastMessageAt: now,
          ...(nextMode === "human" ? { assignedAdminId: input.adminId, unreadCount: 0 } : {}),
        })
        .where(eq(conversations.id, input.conversationId));

      await tx.insert(auditLog).values({
        tenantId: input.tenantId,
        adminId: input.adminId,
        action: actionName,
        targetKind: "conversation",
        targetId: String(input.conversationId),
        detailsJson: JSON.stringify({
          from: existing.mode,
          to: nextMode,
          source: "operator_bot",
        }),
        createdAt: now,
      });

      return { kind: "changed", from: existing.mode, to: nextMode } as const;
    });

    if (outcome.kind === "not_found") {
      return {
        kind: "not_found",
        toast: "Диалог не найден",
        messageHtml: `⚠️ Диалог #${input.conversationId} не найден или недоступен вашему tenant.`,
      };
    }
    if (outcome.kind === "noop") {
      const label = nextMode === "human" ? "уже в работе оператора" : "уже под управлением AI";
      return {
        kind: "noop",
        toast: "Уже актуально",
        messageHtml: `ℹ️ Диалог #${input.conversationId} ${label}.`,
      };
    }

    const text =
      nextMode === "human"
        ? `✅ <b>Взято в работу</b>\n\nДиалог #${input.conversationId} переведён в human mode. AI больше не отвечает, пока оператор не вернёт управление.`
        : `🤖 <b>AI снова активен</b>\n\nДиалог #${input.conversationId} возвращён под управление AI.`;
    return {
      kind: "changed",
      toast: nextMode === "human" ? "Взято в работу" : "AI включён",
      messageHtml: text,
    };
  }
}
