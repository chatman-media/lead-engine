import {
  orderEvents,
  serviceOrderCommissions,
  serviceOrderPayments,
  serviceOrders,
} from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import {
  type OrderEventActorType,
  type OrderEventRow,
  ProviderRelayRepo,
  type ServiceOrderRow,
} from "./dal/index.ts";
import type { RepoCtx } from "./dal/types.ts";
import { type ProviderRelayMetrics, providerRelayTenantLabels } from "./provider-relay-metrics.ts";

export type ServiceOrderPaymentStatus =
  | "created"
  | "pending"
  | "paid"
  | "failed"
  | "cancelled"
  | "refunded";

export type ServiceOrderCommissionStatus = "pending" | "earned" | "void" | "refunded" | "paid_out";

export interface ServiceOrderPaymentRow {
  id: number;
  tenantId: number;
  orderId: number;
  provider: string;
  externalIntentId: string | null;
  externalSessionId: string | null;
  status: ServiceOrderPaymentStatus;
  amount: number;
  currency: string;
  idempotencyKey: string | null;
  metadataJson: string;
  createdAt: number;
  updatedAt: number;
  paidAt: number | null;
  failedAt: number | null;
  cancelledAt: number | null;
  refundedAt: number | null;
}

export interface ServiceOrderCommissionRow {
  id: number;
  tenantId: number;
  orderId: number;
  providerId: number | null;
  paymentId: number | null;
  status: ServiceOrderCommissionStatus;
  grossAmount: number;
  commissionPct: number;
  commissionAmount: number;
  currency: string;
  source: string;
  idempotencyKey: string | null;
  metadataJson: string;
  earnedAt: number | null;
  refundedAt: number | null;
  paidOutAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePaymentIntentInput {
  orderId: number;
  provider: string;
  nowEpoch: number;
  amount?: number | null;
  currency?: string | null;
  externalIntentId?: string | null;
  externalSessionId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecordPaymentWebhookInput {
  orderId?: number;
  paymentId?: number;
  provider: string;
  nowEpoch: number;
  amount?: number | null;
  currency?: string | null;
  externalIntentId?: string | null;
  externalSessionId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PaymentLedgerResult {
  order: ServiceOrderRow;
  payment: ServiceOrderPaymentRow;
  commission: ServiceOrderCommissionRow | null;
}

export class ProviderPaymentLedger {
  private readonly relay: ProviderRelayRepo;

  constructor(
    private readonly ctx: RepoCtx,
    private readonly opts: { metrics?: ProviderRelayMetrics } = {},
  ) {
    this.relay = new ProviderRelayRepo(ctx);
  }

  async paymentById(id: number): Promise<ServiceOrderPaymentRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(serviceOrderPayments)
      .where(
        and(eq(serviceOrderPayments.id, id), eq(serviceOrderPayments.tenantId, this.ctx.tenantId)),
      );
    return (row as ServiceOrderPaymentRow | undefined) ?? null;
  }

  async commissionByPayment(paymentId: number): Promise<ServiceOrderCommissionRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(serviceOrderCommissions)
      .where(
        and(
          eq(serviceOrderCommissions.tenantId, this.ctx.tenantId),
          eq(serviceOrderCommissions.paymentId, paymentId),
        ),
      )
      .orderBy(desc(serviceOrderCommissions.createdAt), desc(serviceOrderCommissions.id))
      .limit(1);
    return (row as ServiceOrderCommissionRow | undefined) ?? null;
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentLedgerResult> {
    const existing = await this.findPayment(input);
    if (existing) {
      return {
        order: await this.requireOrder(existing.orderId),
        payment: existing,
        commission: await this.commissionByPayment(existing.id),
      };
    }

    const order = await this.requireOrder(input.orderId);
    if (order.status !== "awaiting_customer_payment") {
      throw new Error(`service order is not awaiting payment: ${order.status}`);
    }
    const amounts = resolveOrderPaymentAmounts({
      order,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
    });
    const [payment] = await this.ctx.db
      .insert(serviceOrderPayments)
      .values({
        tenantId: this.ctx.tenantId,
        orderId: order.id,
        provider: input.provider,
        status: "pending",
        amount: amounts.customerAmount,
        currency: amounts.currency,
        createdAt: input.nowEpoch,
        updatedAt: input.nowEpoch,
        ...(input.externalIntentId ? { externalIntentId: input.externalIntentId } : {}),
        ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.metadata ? { metadataJson: JSON.stringify(input.metadata) } : {}),
      })
      .returning();
    if (!payment) throw new Error("service_order_payments.insert returned no row");

    const updatedOrder = await this.updateOrderPaymentSnapshot({
      order,
      status: order.status,
      paymentStatus: "pending",
      paymentProvider: input.provider,
      paymentRef:
        input.externalIntentId ??
        input.externalSessionId ??
        input.idempotencyKey ??
        `payment:${payment.id}`,
      amounts,
      nowEpoch: input.nowEpoch,
    });
    await this.appendEventOnce({
      orderId: order.id,
      eventType: "payment_intent_created",
      actorType: "payment",
      nowEpoch: input.nowEpoch,
      data: {
        paymentId: payment.id,
        provider: input.provider,
        externalIntentId: input.externalIntentId ?? null,
        externalSessionId: input.externalSessionId ?? null,
        amount: amounts.customerAmount,
        currency: amounts.currency,
      },
    });

    return {
      order: updatedOrder,
      payment: payment as ServiceOrderPaymentRow,
      commission: null,
    };
  }

  async recordPaymentSucceeded(input: RecordPaymentWebhookInput): Promise<PaymentLedgerResult> {
    const payment = await this.ensurePaymentForWebhook(input);
    const wasAlreadyPaid = payment.status === "paid";
    const order = await this.requireOrder(payment.orderId);
    if (payment.status !== "paid") {
      await this.updatePaymentStatus({
        paymentId: payment.id,
        status: "paid",
        nowEpoch: input.nowEpoch,
      });
    }

    const paidPayment = (await this.paymentById(payment.id)) ?? payment;
    let updatedOrder = order;
    if (updatedOrder.status === "awaiting_customer_payment") {
      updatedOrder = await this.relay.transitionOrderStatus(
        updatedOrder.id,
        "paid",
        input.nowEpoch,
      );
    }
    const amounts = resolveOrderPaymentAmounts({
      order: updatedOrder,
      amount: paidPayment.amount,
      currency: paidPayment.currency,
    });
    updatedOrder = await this.updateOrderPaymentSnapshot({
      order: updatedOrder,
      status: updatedOrder.status,
      paymentStatus: "paid",
      paymentProvider: paidPayment.provider,
      paymentRef:
        paidPayment.externalIntentId ??
        paidPayment.externalSessionId ??
        paidPayment.idempotencyKey ??
        `payment:${paidPayment.id}`,
      amounts,
      nowEpoch: input.nowEpoch,
    });
    const commission = await this.ensureEarnedCommission({
      order: updatedOrder,
      payment: paidPayment,
      amounts,
      nowEpoch: input.nowEpoch,
    });
    if (!wasAlreadyPaid) {
      this.opts.metrics?.providerPaidOrders.inc(1, {
        ...providerRelayTenantLabels(this.ctx.tenantId),
        currency: paidPayment.currency,
      });
      this.opts.metrics?.providerCommissionEarned.inc(commission.commissionAmount, {
        ...providerRelayTenantLabels(this.ctx.tenantId),
        currency: commission.currency,
      });
    }
    await this.appendEventOnce({
      orderId: updatedOrder.id,
      eventType: "customer_payment_succeeded",
      actorType: "payment",
      nowEpoch: input.nowEpoch,
      data: {
        paymentId: paidPayment.id,
        provider: paidPayment.provider,
        externalIntentId: paidPayment.externalIntentId,
        externalSessionId: paidPayment.externalSessionId,
        commissionId: commission.id,
        commissionAmount: commission.commissionAmount,
        ...(input.metadata ?? {}),
      },
    });

    return { order: updatedOrder, payment: paidPayment, commission };
  }

  async recordPaymentFailed(
    input: RecordPaymentWebhookInput & { error?: string | null },
  ): Promise<PaymentLedgerResult> {
    const payment = await this.ensurePaymentForWebhook(input);
    if (payment.status !== "failed") {
      await this.updatePaymentStatus({
        paymentId: payment.id,
        status: "failed",
        nowEpoch: input.nowEpoch,
        metadata: input.metadata,
      });
    }
    let order = await this.requireOrder(payment.orderId);
    if (order.status !== "failed" && order.status !== "cancelled" && order.status !== "fulfilled") {
      order = await this.relay.transitionOrderStatus(order.id, "failed", input.nowEpoch);
    }
    order = await this.updateOrderPaymentSnapshot({
      order,
      status: order.status,
      paymentStatus: "failed",
      paymentProvider: payment.provider,
      paymentRef:
        payment.externalIntentId ??
        payment.externalSessionId ??
        payment.idempotencyKey ??
        `payment:${payment.id}`,
      amounts: resolveOrderPaymentAmounts({
        order,
        amount: payment.amount,
        currency: payment.currency,
      }),
      nowEpoch: input.nowEpoch,
    });
    await this.voidCommissionForPayment(payment.id, input.nowEpoch, "failed");
    await this.appendEventOnce({
      orderId: order.id,
      eventType: "customer_payment_failed",
      actorType: "payment",
      nowEpoch: input.nowEpoch,
      data: {
        paymentId: payment.id,
        error: input.error ?? null,
        ...(input.metadata ?? {}),
      },
    });

    return {
      order,
      payment: (await this.paymentById(payment.id)) ?? payment,
      commission: await this.commissionByPayment(payment.id),
    };
  }

  async cancelPaymentIntent(input: {
    paymentId?: number;
    provider?: string;
    externalIntentId?: string | null;
    externalSessionId?: string | null;
    idempotencyKey?: string | null;
    nowEpoch: number;
    reason?: string | null;
  }): Promise<PaymentLedgerResult> {
    const payment = await this.requirePayment(input);
    if (payment.status !== "cancelled") {
      await this.updatePaymentStatus({
        paymentId: payment.id,
        status: "cancelled",
        nowEpoch: input.nowEpoch,
      });
    }
    let order = await this.requireOrder(payment.orderId);
    if (order.status !== "cancelled" && order.status !== "fulfilled" && order.status !== "failed") {
      order = await this.relay.transitionOrderStatus(order.id, "cancelled", input.nowEpoch);
    }
    order = await this.updateOrderPaymentSnapshot({
      order,
      status: order.status,
      paymentStatus: "unpaid",
      paymentProvider: payment.provider,
      paymentRef:
        payment.externalIntentId ??
        payment.externalSessionId ??
        payment.idempotencyKey ??
        `payment:${payment.id}`,
      amounts: resolveOrderPaymentAmounts({
        order,
        amount: payment.amount,
        currency: payment.currency,
      }),
      nowEpoch: input.nowEpoch,
    });
    await this.voidCommissionForPayment(payment.id, input.nowEpoch, "cancelled");
    await this.appendEventOnce({
      orderId: order.id,
      eventType: "customer_payment_cancelled",
      actorType: "payment",
      nowEpoch: input.nowEpoch,
      data: { paymentId: payment.id, reason: input.reason ?? null },
    });

    return {
      order,
      payment: (await this.paymentById(payment.id)) ?? payment,
      commission: await this.commissionByPayment(payment.id),
    };
  }

  async refundPayment(input: {
    paymentId?: number;
    provider?: string;
    externalIntentId?: string | null;
    externalSessionId?: string | null;
    idempotencyKey?: string | null;
    nowEpoch: number;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<PaymentLedgerResult> {
    const payment = await this.requirePayment(input);
    if (payment.status !== "refunded") {
      await this.updatePaymentStatus({
        paymentId: payment.id,
        status: "refunded",
        nowEpoch: input.nowEpoch,
      });
    }
    let order = await this.requireOrder(payment.orderId);
    if (order.status !== "cancelled" && order.status !== "fulfilled" && order.status !== "failed") {
      order = await this.relay.transitionOrderStatus(order.id, "cancelled", input.nowEpoch);
    }
    order = await this.updateOrderPaymentSnapshot({
      order,
      status: order.status,
      paymentStatus: "refunded",
      paymentProvider: payment.provider,
      paymentRef:
        payment.externalIntentId ??
        payment.externalSessionId ??
        payment.idempotencyKey ??
        `payment:${payment.id}`,
      amounts: resolveOrderPaymentAmounts({
        order,
        amount: payment.amount,
        currency: payment.currency,
      }),
      nowEpoch: input.nowEpoch,
    });
    const commission = await this.refundCommissionForPayment(payment.id, input.nowEpoch);
    await this.appendEventOnce({
      orderId: order.id,
      eventType: "customer_payment_refunded",
      actorType: "payment",
      nowEpoch: input.nowEpoch,
      data: {
        paymentId: payment.id,
        reason: input.reason ?? null,
        ...(input.metadata ?? {}),
      },
    });

    return {
      order,
      payment: (await this.paymentById(payment.id)) ?? payment,
      commission,
    };
  }

  private async ensurePaymentForWebhook(
    input: RecordPaymentWebhookInput,
  ): Promise<ServiceOrderPaymentRow> {
    const existing = await this.findPayment(input);
    if (existing) return existing;
    if (input.orderId === undefined) {
      throw new Error("payment not found and orderId was not provided");
    }
    const created = await this.createPaymentIntent({
      orderId: input.orderId,
      provider: input.provider,
      amount: input.amount,
      currency: input.currency,
      externalIntentId: input.externalIntentId,
      externalSessionId: input.externalSessionId,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
      nowEpoch: input.nowEpoch,
    });
    return created.payment;
  }

  private async findPayment(opts: {
    paymentId?: number;
    provider?: string;
    externalIntentId?: string | null;
    externalSessionId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ServiceOrderPaymentRow | null> {
    if (opts.paymentId !== undefined) return this.paymentById(opts.paymentId);
    if (opts.idempotencyKey) {
      const [row] = await this.ctx.db
        .select()
        .from(serviceOrderPayments)
        .where(
          and(
            eq(serviceOrderPayments.tenantId, this.ctx.tenantId),
            eq(serviceOrderPayments.idempotencyKey, opts.idempotencyKey),
          ),
        )
        .limit(1);
      if (row) return row as ServiceOrderPaymentRow;
    }
    if (opts.provider && opts.externalIntentId) {
      const [row] = await this.ctx.db
        .select()
        .from(serviceOrderPayments)
        .where(
          and(
            eq(serviceOrderPayments.tenantId, this.ctx.tenantId),
            eq(serviceOrderPayments.provider, opts.provider),
            eq(serviceOrderPayments.externalIntentId, opts.externalIntentId),
          ),
        )
        .limit(1);
      if (row) return row as ServiceOrderPaymentRow;
    }
    if (opts.provider && opts.externalSessionId) {
      const [row] = await this.ctx.db
        .select()
        .from(serviceOrderPayments)
        .where(
          and(
            eq(serviceOrderPayments.tenantId, this.ctx.tenantId),
            eq(serviceOrderPayments.provider, opts.provider),
            eq(serviceOrderPayments.externalSessionId, opts.externalSessionId),
          ),
        )
        .limit(1);
      if (row) return row as ServiceOrderPaymentRow;
    }
    return null;
  }

  private async requirePayment(opts: {
    paymentId?: number;
    provider?: string;
    externalIntentId?: string | null;
    externalSessionId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ServiceOrderPaymentRow> {
    const payment = await this.findPayment(opts);
    if (!payment) throw new Error("service order payment not found");
    return payment;
  }

  private async requireOrder(orderId: number): Promise<ServiceOrderRow> {
    const order = await this.relay.orderById(orderId);
    if (!order) throw new Error(`service order not found: ${orderId}`);
    return order;
  }

  private async updatePaymentStatus(opts: {
    paymentId: number;
    status: ServiceOrderPaymentStatus;
    nowEpoch: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.ctx.db
      .update(serviceOrderPayments)
      .set({
        status: opts.status,
        updatedAt: opts.nowEpoch,
        ...(opts.status === "paid" ? { paidAt: opts.nowEpoch } : {}),
        ...(opts.status === "failed" ? { failedAt: opts.nowEpoch } : {}),
        ...(opts.status === "cancelled" ? { cancelledAt: opts.nowEpoch } : {}),
        ...(opts.status === "refunded" ? { refundedAt: opts.nowEpoch } : {}),
        ...(opts.metadata ? { metadataJson: JSON.stringify(opts.metadata) } : {}),
      })
      .where(
        and(
          eq(serviceOrderPayments.id, opts.paymentId),
          eq(serviceOrderPayments.tenantId, this.ctx.tenantId),
        ),
      );
  }

  private async updateOrderPaymentSnapshot(opts: {
    order: ServiceOrderRow;
    status: ServiceOrderRow["status"];
    paymentStatus: ServiceOrderRow["paymentStatus"];
    paymentProvider: string;
    paymentRef: string;
    amounts: ResolvedPaymentAmounts;
    nowEpoch: number;
  }): Promise<ServiceOrderRow> {
    const [row] = await this.ctx.db
      .update(serviceOrders)
      .set({
        status: opts.status,
        paymentStatus: opts.paymentStatus,
        paymentProvider: opts.paymentProvider,
        paymentRef: opts.paymentRef,
        customerAmount: opts.amounts.customerAmount,
        commissionPct: opts.amounts.commissionPct,
        commissionAmount: opts.amounts.commissionAmount,
        currency: opts.amounts.currency,
        updatedAt: opts.nowEpoch,
      })
      .where(
        and(eq(serviceOrders.id, opts.order.id), eq(serviceOrders.tenantId, this.ctx.tenantId)),
      )
      .returning();
    if (!row) throw new Error("service_orders.payment_snapshot returned no row");
    return row as ServiceOrderRow;
  }

  private async ensureEarnedCommission(opts: {
    order: ServiceOrderRow;
    payment: ServiceOrderPaymentRow;
    amounts: ResolvedPaymentAmounts;
    nowEpoch: number;
  }): Promise<ServiceOrderCommissionRow> {
    const existing = await this.commissionByPayment(opts.payment.id);
    if (existing) {
      if (existing.status !== "earned") {
        await this.ctx.db
          .update(serviceOrderCommissions)
          .set({
            status: "earned",
            earnedAt: opts.nowEpoch,
            updatedAt: opts.nowEpoch,
          })
          .where(
            and(
              eq(serviceOrderCommissions.id, existing.id),
              eq(serviceOrderCommissions.tenantId, this.ctx.tenantId),
            ),
          );
        return (await this.commissionByPayment(opts.payment.id)) ?? existing;
      }
      return existing;
    }

    const [row] = await this.ctx.db
      .insert(serviceOrderCommissions)
      .values({
        tenantId: this.ctx.tenantId,
        orderId: opts.order.id,
        providerId: opts.order.assignedProviderId,
        paymentId: opts.payment.id,
        status: "earned",
        grossAmount: opts.amounts.customerAmount,
        commissionPct: opts.amounts.commissionPct,
        commissionAmount: opts.amounts.commissionAmount,
        currency: opts.amounts.currency,
        source: "payment",
        idempotencyKey: `commission:${opts.payment.id}`,
        metadataJson: JSON.stringify({
          providerAmount: opts.amounts.providerAmount,
        }),
        earnedAt: opts.nowEpoch,
        createdAt: opts.nowEpoch,
        updatedAt: opts.nowEpoch,
      })
      .returning();
    if (!row) throw new Error("service_order_commissions.insert returned no row");
    await this.appendEventOnce({
      orderId: opts.order.id,
      eventType: "commission_earned",
      actorType: "payment",
      nowEpoch: opts.nowEpoch,
      data: {
        paymentId: opts.payment.id,
        commissionId: row.id,
        commissionPct: opts.amounts.commissionPct,
        commissionAmount: opts.amounts.commissionAmount,
        currency: opts.amounts.currency,
      },
    });
    return row as ServiceOrderCommissionRow;
  }

  private async refundCommissionForPayment(
    paymentId: number,
    nowEpoch: number,
  ): Promise<ServiceOrderCommissionRow | null> {
    const commission = await this.commissionByPayment(paymentId);
    if (!commission) return null;
    if (commission.status === "refunded") return commission;
    const [row] = await this.ctx.db
      .update(serviceOrderCommissions)
      .set({
        status: "refunded",
        refundedAt: nowEpoch,
        updatedAt: nowEpoch,
      })
      .where(
        and(
          eq(serviceOrderCommissions.id, commission.id),
          eq(serviceOrderCommissions.tenantId, this.ctx.tenantId),
        ),
      )
      .returning();
    await this.appendEventOnce({
      orderId: commission.orderId,
      eventType: "commission_refunded",
      actorType: "payment",
      nowEpoch,
      data: { paymentId, commissionId: commission.id },
    });
    return (row as ServiceOrderCommissionRow | undefined) ?? commission;
  }

  private async voidCommissionForPayment(
    paymentId: number,
    nowEpoch: number,
    reason: string,
  ): Promise<ServiceOrderCommissionRow | null> {
    const commission = await this.commissionByPayment(paymentId);
    if (!commission || commission.status === "void") return commission;
    const [row] = await this.ctx.db
      .update(serviceOrderCommissions)
      .set({
        status: "void",
        updatedAt: nowEpoch,
      })
      .where(
        and(
          eq(serviceOrderCommissions.id, commission.id),
          eq(serviceOrderCommissions.tenantId, this.ctx.tenantId),
        ),
      )
      .returning();
    await this.appendEventOnce({
      orderId: commission.orderId,
      eventType: "commission_voided",
      actorType: "payment",
      nowEpoch,
      data: { paymentId, commissionId: commission.id, reason },
    });
    return (row as ServiceOrderCommissionRow | undefined) ?? commission;
  }

  private async appendEventOnce(opts: {
    orderId: number;
    eventType: string;
    nowEpoch: number;
    actorType?: OrderEventActorType;
    data?: Record<string, unknown>;
  }): Promise<OrderEventRow | null> {
    const paymentId = typeof opts.data?.paymentId === "number" ? opts.data.paymentId : null;
    const [existing] = await this.ctx.db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.tenantId, this.ctx.tenantId),
          eq(orderEvents.orderId, opts.orderId),
          eq(orderEvents.eventType, opts.eventType),
        ),
      )
      .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
      .limit(1);
    if (existing && paymentId === null) return null;
    if (existing && paymentId !== null) {
      const [event] = await this.ctx.db
        .select({ dataJson: orderEvents.dataJson })
        .from(orderEvents)
        .where(eq(orderEvents.id, existing.id))
        .limit(1);
      const data = parseJsonObject(event?.dataJson ?? "{}");
      if (data.paymentId === paymentId) return null;
    }
    return this.relay.appendEvent({
      orderId: opts.orderId,
      eventType: opts.eventType,
      actorType: opts.actorType,
      data: opts.data,
      nowEpoch: opts.nowEpoch,
    });
  }
}

interface ResolvedPaymentAmounts {
  providerAmount: number;
  customerAmount: number;
  commissionPct: number;
  commissionAmount: number;
  currency: string;
}

function resolveOrderPaymentAmounts(opts: {
  order: ServiceOrderRow;
  amount?: number | null;
  currency?: string | null;
}): ResolvedPaymentAmounts {
  const providerAmount = opts.order.quotedAmount ?? opts.order.customerAmount ?? opts.amount ?? 0;
  if (!(providerAmount > 0)) {
    throw new Error("service order has no payable amount");
  }
  const commissionAmount =
    opts.order.commissionAmount ??
    (opts.order.customerAmount !== null && opts.order.quotedAmount !== null
      ? roundMoney(opts.order.customerAmount - opts.order.quotedAmount)
      : opts.order.commissionPct !== null
        ? roundMoney((providerAmount * opts.order.commissionPct) / 100)
        : 0);
  const customerAmount =
    opts.amount ?? opts.order.customerAmount ?? roundMoney(providerAmount + commissionAmount);
  const commissionPct =
    opts.order.commissionPct ??
    (providerAmount > 0 ? roundMoney((commissionAmount / providerAmount) * 100) : 0);
  return {
    providerAmount,
    customerAmount,
    commissionPct,
    commissionAmount,
    currency: opts.currency ?? opts.order.currency,
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
