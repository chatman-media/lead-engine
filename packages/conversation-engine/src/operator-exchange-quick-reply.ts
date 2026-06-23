// Резолверы exchange-quick-reply оператор-бота, вынесенные из
// operator-bot-handler. Читают заявку/диалог из БД и собирают текст быстрого
// ответа (код выдачи / офис) либо блокируют действие. Зависят только от db.

import { conversations, exchangeOrders } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { Db } from "./dal/types.ts";
import { QUOTE_CURRENCY } from "./exchange-quote-currency.ts";
import { createPayoutCode } from "./exchange-side-effects.ts";
import type { OperatorBotExchangeAction } from "./operator-bot-actions.ts";
import { PAYOUT_CODE_TTL_SEC, pickupWindowFromDestination } from "./operator-bot-shared.ts";
import { withTenant } from "./with-tenant.ts";

export interface ExchangeQuickReplyDraft {
  title: string;
  text: string;
  metadata: Record<string, unknown>;
}

export async function resolveExchangeActionScope(
  db: Db | undefined,
  input: {
    tenantId: number;
    conversationId: number;
    orderId?: number;
  },
): Promise<{ kind: "ready" } | { kind: "blocked"; toast: string }> {
  if (!db) return { kind: "ready" };
  return withTenant(db, input.tenantId, async (tx) => {
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.tenantId, input.tenantId), eq(conversations.id, input.conversationId)),
      )
      .limit(1);
    if (!conversation) {
      return { kind: "blocked", toast: "Диалог не найден" } as const;
    }
    if (!input.orderId) return { kind: "ready" } as const;

    const [order] = await tx
      .select({ id: exchangeOrders.id })
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.tenantId, input.tenantId),
          eq(exchangeOrders.conversationId, input.conversationId),
          eq(exchangeOrders.id, input.orderId),
        ),
      )
      .limit(1);
    if (!order) {
      return { kind: "blocked", toast: "Заявка не найдена" } as const;
    }
    return { kind: "ready" } as const;
  });
}

export async function resolveExchangeQuickReply(
  db: Db | undefined,
  input: {
    tenantId: number;
    conversationId: number;
    orderId?: number;
    action: OperatorBotExchangeAction;
    quickReply: ExchangeQuickReplyDraft;
    now: number;
  },
): Promise<
  { kind: "ready"; quickReply: ExchangeQuickReplyDraft } | { kind: "blocked"; toast: string }
> {
  if (!input.orderId || !db) {
    return { kind: "ready", quickReply: input.quickReply };
  }
  const orderId = input.orderId;

  if (input.action === "office_details") {
    const [order] = await withTenant(db, input.tenantId, async (tx) =>
      tx
        .select({
          id: exchangeOrders.id,
          payoutMethod: exchangeOrders.payoutMethod,
          payoutLocation: exchangeOrders.payoutLocation,
          payoutDestinationJson: exchangeOrders.payoutDestinationJson,
        })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.tenantId, input.tenantId),
            eq(exchangeOrders.conversationId, input.conversationId),
            eq(exchangeOrders.id, orderId),
          ),
        )
        .limit(1),
    );
    if (!order) return { kind: "blocked", toast: "Заявка не найдена" };
    const location = order.payoutLocation?.trim() || "выбранный офис";
    const pickupWindow = pickupWindowFromDestination(order.payoutDestinationJson);
    return {
      kind: "ready",
      quickReply: {
        title: "Офис и время",
        text:
          `🏢 Получение в офисе: ${location}. ` +
          (pickupWindow
            ? `Окно получения: ${pickupWindow}. `
            : "Окно получения подтвердит оператор. ") +
          "Оператор фиксирует готовность и отправит финальные инструкции здесь.",
        metadata: {
          ...input.quickReply.metadata,
          orderId: order.id,
          payoutMethod: order.payoutMethod,
          payoutLocation: order.payoutLocation,
          ...(pickupWindow ? { pickupWindow } : {}),
        },
      },
    };
  }

  if (input.action !== "payout_ready") {
    return { kind: "ready", quickReply: input.quickReply };
  }

  const [order] = await withTenant(db, input.tenantId, async (tx) =>
    tx
      .select({
        id: exchangeOrders.id,
        status: exchangeOrders.status,
        payoutCode: exchangeOrders.payoutCode,
        payoutCodeExpiresAt: exchangeOrders.payoutCodeExpiresAt,
        payoutLocation: exchangeOrders.payoutLocation,
        payoutMethod: exchangeOrders.payoutMethod,
      })
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.tenantId, input.tenantId),
          eq(exchangeOrders.conversationId, input.conversationId),
          eq(exchangeOrders.id, orderId),
        ),
      )
      .limit(1),
  );
  if (!order) return { kind: "blocked", toast: "Заявка не найдена" };
  if (order.status !== "paid" && order.status !== "payout") {
    return {
      kind: "blocked",
      toast: `Выдача недоступна: статус ${order.status}`,
    };
  }

  const code = order.payoutCode ?? createPayoutCode(order.id);
  const expiresAt =
    order.payoutCodeExpiresAt && order.payoutCodeExpiresAt > input.now
      ? order.payoutCodeExpiresAt
      : input.now + PAYOUT_CODE_TTL_SEC;
  const minutes = Math.max(1, Math.round((expiresAt - input.now) / 60));
  const location = order.payoutLocation ? ` Место: ${order.payoutLocation}.` : "";
  const method = order.payoutMethod ? ` Способ: ${order.payoutMethod}.` : "";
  return {
    kind: "ready",
    quickReply: {
      title: `Код выдачи ${QUOTE_CURRENCY.code}`,
      text: `🔐 Код выдачи: ${code}.${location}${method} Код действует ${minutes} мин.`,
      metadata: {
        ...input.quickReply.metadata,
        orderId: order.id,
        payoutCode: code,
        payoutCodeExpiresAt: expiresAt,
        payoutCodeGenerated: !order.payoutCode,
      },
    },
  };
}
