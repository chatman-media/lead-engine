/**
 * DAL-хелперы для exchange_orders. Все запросы обёрнуты в withTenant
 * (RLS FORCE на таблице — без SET LOCAL app.tenant_id вернётся 0 строк / упадёт WITH CHECK).
 */

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { channelIdentities, conversations, exchangeOrders } from "@chatman-media/storage";
import { and, desc, eq, inArray } from "drizzle-orm";

const OPEN_STATUSES = ["quote", "awaiting_payment", "paid", "payout"] as const;

export interface OrderRow {
  id: number;
  status: string;
  direction: string;
  assetFrom: string;
  network: string;
  amountMode: string;
  requestedAmount: number | null;
  amountFrom: number;
  rate: number;
  amountToThb: number;
  paymentMethod: string | null;
  paymentRail: string | null;
  sourceBank: string | null;
  payerName: string | null;
  thirdPartyApproved: boolean;
  payoutMethod: string | null;
  payoutLocation: string | null;
  payoutDestinationJson: string | null;
  payoutCode: string | null;
  payoutCodeExpiresAt: number | null;
  requisitesJson: string | null;
  proofJson: string | null;
  verificationId: string | null;
  rateExpiresAt: number | null;
  idempotencyKey: string | null;
}

const ORDER_COLS = {
  id: exchangeOrders.id,
  status: exchangeOrders.status,
  direction: exchangeOrders.direction,
  assetFrom: exchangeOrders.assetFrom,
  network: exchangeOrders.network,
  amountMode: exchangeOrders.amountMode,
  requestedAmount: exchangeOrders.requestedAmount,
  amountFrom: exchangeOrders.amountFrom,
  rate: exchangeOrders.rate,
  amountToThb: exchangeOrders.amountToThb,
  paymentMethod: exchangeOrders.paymentMethod,
  paymentRail: exchangeOrders.paymentRail,
  sourceBank: exchangeOrders.sourceBank,
  payerName: exchangeOrders.payerName,
  thirdPartyApproved: exchangeOrders.thirdPartyApproved,
  payoutMethod: exchangeOrders.payoutMethod,
  payoutLocation: exchangeOrders.payoutLocation,
  payoutDestinationJson: exchangeOrders.payoutDestinationJson,
  payoutCode: exchangeOrders.payoutCode,
  payoutCodeExpiresAt: exchangeOrders.payoutCodeExpiresAt,
  requisitesJson: exchangeOrders.requisitesJson,
  proofJson: exchangeOrders.proofJson,
  verificationId: exchangeOrders.verificationId,
  rateExpiresAt: exchangeOrders.rateExpiresAt,
  idempotencyKey: exchangeOrders.idempotencyKey,
};

function coerce(row: Record<string, unknown>): OrderRow {
  return {
    id: row.id as number,
    status: row.status as string,
    direction: row.direction as string,
    assetFrom: row.assetFrom as string,
    network: row.network as string,
    amountMode: (row.amountMode as string | null) ?? "source_amount",
    requestedAmount: row.requestedAmount === null ? null : Number(row.requestedAmount),
    amountFrom: Number(row.amountFrom),
    rate: Number(row.rate),
    amountToThb: Number(row.amountToThb),
    paymentMethod: (row.paymentMethod as string | null) ?? null,
    paymentRail: (row.paymentRail as string | null) ?? null,
    sourceBank: (row.sourceBank as string | null) ?? null,
    payerName: (row.payerName as string | null) ?? null,
    thirdPartyApproved: Boolean(row.thirdPartyApproved),
    payoutMethod: (row.payoutMethod as string | null) ?? null,
    payoutLocation: (row.payoutLocation as string | null) ?? null,
    payoutDestinationJson: (row.payoutDestinationJson as string | null) ?? null,
    payoutCode: (row.payoutCode as string | null) ?? null,
    payoutCodeExpiresAt: (row.payoutCodeExpiresAt as number | null) ?? null,
    requisitesJson: (row.requisitesJson as string | null) ?? null,
    proofJson: (row.proofJson as string | null) ?? null,
    verificationId: (row.verificationId as string | null) ?? null,
    rateExpiresAt: (row.rateExpiresAt as number | null) ?? null,
    idempotencyKey: (row.idempotencyKey as string | null) ?? null,
  };
}

/** Контекст беседы: contactId (= conversations.user_id) + telegram external id. */
export async function resolveConversationParties(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<{ contactId: number | null; telegramId: string | null }> {
  return withTenant(db, tenantId, async (tx) => {
    const [conv] = await tx
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
    if (!conv) return { contactId: null, telegramId: null };
    const [ci] = await tx
      .select({ ext: channelIdentities.externalUserId })
      .from(channelIdentities)
      .where(eq(channelIdentities.contactId, conv.userId))
      .orderBy(desc(channelIdentities.id))
      .limit(1);
    return { contactId: conv.userId, telegramId: ci?.ext ?? null };
  });
}

/** Активная (незавершённая) заявка беседы, если есть. */
export async function findActiveOrder(
  db: Db,
  tenantId: number,
  conversationId: number,
): Promise<OrderRow | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select(ORDER_COLS)
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.tenantId, tenantId),
          eq(exchangeOrders.conversationId, conversationId),
          inArray(exchangeOrders.status, OPEN_STATUSES as unknown as string[]),
        ),
      )
      .orderBy(desc(exchangeOrders.id))
      .limit(1);
    return row ? coerce(row) : null;
  });
}

export async function getOrderByIdempotencyKey(
  db: Db,
  tenantId: number,
  key: string,
): Promise<OrderRow | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select(ORDER_COLS)
      .from(exchangeOrders)
      .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.idempotencyKey, key)))
      .limit(1);
    return row ? coerce(row) : null;
  });
}

export async function getOrderById(
  db: Db,
  tenantId: number,
  orderId: number,
): Promise<OrderRow | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select(ORDER_COLS)
      .from(exchangeOrders)
      .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, orderId)))
      .limit(1);
    return row ? coerce(row) : null;
  });
}

export interface CreateOrderInput {
  conversationId: number;
  contactId: number | null;
  telegramId: string | null;
  verificationId?: string | null;
  direction: string;
  assetFrom: string;
  network: string;
  amountMode?: string;
  requestedAmount?: number | null;
  amountFrom: number;
  rate: number;
  amountToThb: number;
  paymentMethod?: string | null;
  paymentRail?: string | null;
  sourceBank?: string | null;
  payerName?: string | null;
  thirdPartyApproved?: boolean;
  payoutMethod?: string | null;
  payoutLocation?: string | null;
  payoutDestinationJson?: string | null;
  riskJson?: string | null;
  rateExpiresAt: number;
  idempotencyKey: string;
}

/**
 * Идемпотентно создаёт заявку (status='awaiting_payment'). Повторный вызов с тем
 * же idempotencyKey не создаёт дубль, а возвращает существующую заявку.
 */
export async function createOrderIdempotent(
  db: Db,
  tenantId: number,
  input: CreateOrderInput,
): Promise<OrderRow> {
  const now = Math.floor(Date.now() / 1000);
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(exchangeOrders)
      .values({
        tenantId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        telegramId: input.telegramId,
        verificationId: input.verificationId ?? null,
        direction: input.direction,
        assetFrom: input.assetFrom,
        network: input.network,
        amountMode: input.amountMode ?? "source_amount",
        requestedAmount: input.requestedAmount ?? input.amountFrom,
        amountFrom: input.amountFrom,
        rate: input.rate,
        amountToThb: input.amountToThb,
        paymentMethod: input.paymentMethod ?? null,
        paymentRail: input.paymentRail ?? null,
        sourceBank: input.sourceBank ?? null,
        payerName: input.payerName ?? null,
        thirdPartyApproved: input.thirdPartyApproved ?? false,
        payoutMethod: input.payoutMethod ?? null,
        payoutLocation: input.payoutLocation ?? null,
        payoutDestinationJson: input.payoutDestinationJson ?? null,
        status: "awaiting_payment",
        riskJson: input.riskJson ?? null,
        rateExpiresAt: input.rateExpiresAt,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: exchangeOrders.idempotencyKey })
      .returning(ORDER_COLS);
    if (inserted[0]) return coerce(inserted[0]);

    // Конфликт по idempotencyKey → вернуть существующую.
    const [existing] = await tx
      .select(ORDER_COLS)
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.tenantId, tenantId),
          eq(exchangeOrders.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("createOrderIdempotent: insert conflicted but no existing row");
    return coerce(existing);
  });
}

/** Частичное обновление заявки (только переданные поля). */
export async function updateOrder(
  db: Db,
  tenantId: number,
  orderId: number,
  patch: Partial<{
    status: string;
    requisitesJson: string | null;
    proofJson: string | null;
    riskJson: string | null;
    payoutMethod: string | null;
    payoutLocation: string | null;
    payoutDestinationJson: string | null;
    payoutCode: string | null;
    payoutCodeExpiresAt: number | null;
    verificationId: string | null;
    paymentMethod: string | null;
    paymentRail: string | null;
    sourceBank: string | null;
    payerName: string | null;
    thirdPartyApproved: boolean;
    rateExpiresAt: number | null;
    completedAt: number | null;
    lastReminderAt: number | null;
  }>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .update(exchangeOrders)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(exchangeOrders.tenantId, tenantId), eq(exchangeOrders.id, orderId)));
  });
}
