import {
  canTransitionServiceOrder,
  CustomerOfferFlow,
  type Db,
  PROVIDER_RELAY_FEATURE_KEY,
  ProviderRelayOrchestrator,
  ProviderRelayRepo,
  type ProviderRequestStatus,
  type ServiceOrderStatus,
  TenantFeatureFlagRepo,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  contacts,
  messages,
  orderEvents,
  outboundQueue,
  providerProfiles,
  providerRequests,
  providerServices,
  serviceOrders,
  tenantFeatureFlags,
} from "@chatman-media/storage";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { type AuditEntry, recordAudit } from "../lib/audit.ts";

type ActionBody = {
  providerId?: unknown;
  providerRequestId?: unknown;
  messageText?: unknown;
  offerText?: unknown;
  paymentInstructions?: unknown;
  customerChannelId?: unknown;
  serviceArea?: unknown;
  reason?: unknown;
  enabled?: unknown;
};

type OrderListRow = {
  id: number;
  status: ServiceOrderStatus;
  requestType: string;
  summary: string | null;
  quotedAmount: number | null;
  customerAmount: number | null;
  commissionAmount: number | null;
  currency: string;
  paymentStatus: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  customer: { id: number; name: string | null };
  provider: { id: number; name: string } | null;
  latestProviderRequest: {
    id: number;
    status: ProviderRequestStatus;
    providerId: number | null;
    providerName: string | null;
    quoteExpiresAt: number | null;
    updatedAt: number;
  } | null;
  lastEvent: { eventType: string; createdAt: number } | null;
  sla: ReturnType<typeof buildSla>;
};

export function makeAdminProviderOrdersRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/provider-orders", async (c) => {
    const tenantId = c.var.tenantId;
    const status = cleanString(c.req.query("status"));
    const limit = clampInt(Number(c.req.query("limit") ?? 50), 1, 100);
    const now = epochNow();

    const items = await withTenant(opts.db, tenantId, async (tx) => {
      const orders = await tx
        .select({
          id: serviceOrders.id,
          status: serviceOrders.status,
          requestType: serviceOrders.requestType,
          summary: serviceOrders.summary,
          quotedAmount: serviceOrders.quotedAmount,
          customerAmount: serviceOrders.customerAmount,
          commissionAmount: serviceOrders.commissionAmount,
          currency: serviceOrders.currency,
          paymentStatus: serviceOrders.paymentStatus,
          expiresAt: serviceOrders.expiresAt,
          createdAt: serviceOrders.createdAt,
          updatedAt: serviceOrders.updatedAt,
          customerId: serviceOrders.customerContactId,
          customerName: contacts.displayName,
          providerId: serviceOrders.assignedProviderId,
          providerName: providerProfiles.name,
        })
        .from(serviceOrders)
        .leftJoin(
          contacts,
          and(eq(contacts.tenantId, tenantId), eq(contacts.id, serviceOrders.customerContactId)),
        )
        .leftJoin(
          providerProfiles,
          and(
            eq(providerProfiles.tenantId, tenantId),
            eq(providerProfiles.id, serviceOrders.assignedProviderId),
          ),
        )
        .where(
          and(
            eq(serviceOrders.tenantId, tenantId),
            ...(status ? [eq(serviceOrders.status, status)] : []),
          ),
        )
        .orderBy(desc(serviceOrders.updatedAt), desc(serviceOrders.id))
        .limit(limit);

      const orderIds = orders.map((order) => order.id);
      const latestRequests = await latestProviderRequests(tx, tenantId, orderIds);
      const latestEvents = await latestOrderEvents(tx, tenantId, orderIds);

      return orders.map(
        (order): OrderListRow => ({
          id: order.id,
          status: order.status as ServiceOrderStatus,
          requestType: order.requestType,
          summary: order.summary,
          quotedAmount: order.quotedAmount,
          customerAmount: order.customerAmount,
          commissionAmount: order.commissionAmount,
          currency: order.currency,
          paymentStatus: order.paymentStatus,
          expiresAt: order.expiresAt,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          customer: { id: order.customerId, name: order.customerName },
          provider:
            order.providerId && order.providerName
              ? { id: order.providerId, name: order.providerName }
              : null,
          latestProviderRequest: latestRequests.get(order.id) ?? null,
          lastEvent: latestEvents.get(order.id) ?? null,
          sla: buildSla({
            now,
            orderExpiresAt: order.expiresAt,
            quoteExpiresAt: latestRequests.get(order.id)?.quoteExpiresAt ?? null,
          }),
        }),
      );
    });

    return c.json({ items });
  });

  app.get("/api/admin/provider-orders/providers", async (c) => {
    const tenantId = c.var.tenantId;
    const requestType = cleanString(c.req.query("requestType"));
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: providerProfiles.id,
          name: providerProfiles.name,
          category: providerProfiles.category,
          status: providerProfiles.status,
          serviceArea: providerProfiles.serviceArea,
          defaultCommissionPct: providerProfiles.defaultCommissionPct,
          serviceId: providerServices.id,
          serviceType: providerServices.serviceType,
          serviceName: providerServices.name,
          serviceAreaOverride: providerServices.serviceArea,
          commissionPct: providerServices.commissionPct,
        })
        .from(providerProfiles)
        .leftJoin(
          providerServices,
          and(
            eq(providerServices.tenantId, tenantId),
            eq(providerServices.providerId, providerProfiles.id),
            eq(providerServices.isActive, true),
            ...(requestType ? [eq(providerServices.serviceType, requestType)] : []),
          ),
        )
        .where(and(eq(providerProfiles.tenantId, tenantId), eq(providerProfiles.status, "active")))
        .orderBy(asc(providerProfiles.name), asc(providerServices.serviceType)),
    );

    const byProvider = new Map<
      number,
      {
        id: number;
        name: string;
        category: string | null;
        status: string;
        serviceArea: string | null;
        defaultCommissionPct: number;
        services: Array<{
          id: number;
          serviceType: string;
          name: string;
          serviceArea: string | null;
          commissionPct: number | null;
        }>;
      }
    >();
    for (const row of rows) {
      const item = byProvider.get(row.id) ?? {
        id: row.id,
        name: row.name,
        category: row.category,
        status: row.status,
        serviceArea: row.serviceArea,
        defaultCommissionPct: row.defaultCommissionPct,
        services: [],
      };
      if (row.serviceId) {
        item.services.push({
          id: row.serviceId,
          serviceType: row.serviceType ?? "",
          name: row.serviceName ?? "",
          serviceArea: row.serviceAreaOverride,
          commissionPct: row.commissionPct,
        });
      }
      byProvider.set(row.id, item);
    }

    return c.json({ items: [...byProvider.values()] });
  });

  app.get("/api/admin/provider-orders/ops", async (c) => {
    const tenantId = c.var.tenantId;
    const [settings, metrics] = await Promise.all([
      loadProviderRelaySettings(opts.db, tenantId),
      loadProviderRelayMetrics(opts.db, tenantId, epochNow()),
    ]);
    return c.json({ settings, metrics });
  });

  app.put("/api/admin/provider-orders/ops/settings", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await readBody(c);
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled boolean required" }, 400);
    }

    const settings = await setProviderRelayEnabled(opts.db, tenantId, body.enabled, epochNow());
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_relay.settings_update",
      targetKind: "provider_relay",
      targetId: String(tenantId),
      details: settings,
    });
    return c.json({ ok: true, settings });
  });

  app.get("/api/admin/provider-orders/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);

    const detail = await withTenant(opts.db, tenantId, async (tx) =>
      loadOrderDetail(tx, tenantId, id),
    );
    if (!detail) return c.json({ error: "order not found" }, 404);
    return c.json(detail);
  });

  app.post("/api/admin/provider-orders/:id/assign-provider", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await readBody(c);
    const providerId = parsePositiveId(body.providerId);
    if (!providerId) return c.json({ error: "providerId required" }, 400);
    const disabled = await rejectIfProviderRelayDisabled(c, opts.db, tenantId);
    if (disabled) return disabled;
    const now = epochNow();

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const relay = new ProviderRelayRepo({ db: tx, tenantId });
      const order = await relay.orderById(id);
      if (!order) return { error: "order not found", status: 404 as const };
      const [provider] = await tx
        .select({ id: providerProfiles.id, name: providerProfiles.name })
        .from(providerProfiles)
        .where(
          and(
            eq(providerProfiles.tenantId, tenantId),
            eq(providerProfiles.id, providerId),
            eq(providerProfiles.status, "active"),
          ),
        )
        .limit(1);
      if (!provider) return { error: "provider not found", status: 404 as const };

      const [updated] = await tx
        .update(serviceOrders)
        .set({ assignedProviderId: providerId, updatedAt: now })
        .where(and(eq(serviceOrders.tenantId, tenantId), eq(serviceOrders.id, id)))
        .returning();
      await relay.appendEvent({
        orderId: id,
        actorType: "operator",
        eventType: "provider_assigned",
        data: { providerId, providerName: provider.name, adminId: adminId ?? null },
        nowEpoch: now,
      });
      return { order: updated };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_order.assign_provider",
      targetKind: "service_order",
      targetId: String(id),
      details: { providerId },
    });
    return c.json({ ok: true, order: result.order });
  });

  app.post("/api/admin/provider-orders/:id/send-provider-request", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await readBody(c);
    const providerId = parsePositiveId(body.providerId);
    const disabled = await rejectIfProviderRelayDisabled(c, opts.db, tenantId);
    if (disabled) return disabled;
    const now = epochNow();

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const orchestrator = new ProviderRelayOrchestrator({ db: tx, tenantId });
      return orchestrator.sendProviderRequestForOrder({
        orderId: id,
        nowEpoch: now,
        providerIdOverride: providerId,
        messageText: cleanString(body.messageText) || null,
        serviceArea: cleanString(body.serviceArea) || undefined,
        metadata: { requestedByAdminId: adminId ?? null },
      });
    });

    if (!result.ok) {
      return c.json(
        {
          error: result.reason,
          currentStatus: result.currentStatus,
          routingReason: result.routingReason,
          providerId: result.providerId,
        },
        result.reason === "order_not_found" ? 404 : 409,
      );
    }
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_order.send_provider_request",
      targetKind: "service_order",
      targetId: String(id),
      details: {
        providerId: result.providerRequest.providerId,
        providerRequestId: result.providerRequest.id,
        outboundQueueId: result.outbound.id,
      },
    });
    return c.json({
      ok: true,
      order: result.order,
      providerRequest: result.providerRequest,
      outbound: result.outbound,
    });
  });

  app.post("/api/admin/provider-orders/:id/approve-quote", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await readBody(c);
    const providerRequestId = parsePositiveId(body.providerRequestId);
    const disabled = await rejectIfProviderRelayDisabled(c, opts.db, tenantId);
    if (disabled) return disabled;
    const now = epochNow();

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const relay = new ProviderRelayRepo({ db: tx, tenantId });
      const order = await relay.orderById(id);
      if (!order) return { error: "order not found", status: 404 as const };
      const request = await selectQuoteRequest(tx, tenantId, id, providerRequestId);
      if (!request) return { error: "quote not found", status: 409 as const };
      const accepted = await relay.transitionProviderRequestStatus(request.id, "accepted", now);
      await relay.appendEvent({
        orderId: id,
        providerRequestId: accepted.id,
        actorType: "operator",
        eventType: "provider_quote_approved",
        data: { adminId: adminId ?? null },
        nowEpoch: now,
      });
      return { providerRequest: accepted };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_order.approve_quote",
      targetKind: "service_order",
      targetId: String(id),
      details: { providerRequestId: result.providerRequest.id },
    });
    return c.json({ ok: true, providerRequest: result.providerRequest });
  });

  app.post("/api/admin/provider-orders/:id/send-customer-offer", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await readBody(c);
    const disabled = await rejectIfProviderRelayDisabled(c, opts.db, tenantId);
    if (disabled) return disabled;
    const now = epochNow();
    const offerTextOverride = cleanString(body.offerText) || null;
    const paymentInstructions = cleanString(body.paymentInstructions) || null;

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const flow = new CustomerOfferFlow({ db: tx, tenantId });
      return flow.sendCustomerOffer({
        orderId: id,
        nowEpoch: now,
        customerChannelId: parsePositiveId(body.customerChannelId) ?? undefined,
        offerTextOverride,
        paymentInstructions,
        approvedByAdminId: adminId ?? null,
      });
    });

    if (!result.ok) {
      return c.json(
        { error: result.reason, order: result.order },
        result.reason === "order_not_found" ? 404 : 409,
      );
    }
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_order.send_customer_offer",
      targetKind: "service_order",
      targetId: String(id),
      details: {
        providerRequestId: result.providerRequest.id,
        outboundQueueId: result.outbound.id,
        customerChannelId: result.identity.channelDbId,
        manualOverride: Boolean(offerTextOverride),
        hasPaymentInstructions: Boolean(paymentInstructions),
      },
    });
    if (offerTextOverride) {
      await recordProviderOrderAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider_order.manual_offer_override",
        targetKind: "service_order",
        targetId: String(id),
        details: {
          providerRequestId: result.providerRequest.id,
          outboundQueueId: result.outbound.id,
          customerChannelId: result.identity.channelDbId,
        },
      });
    }
    return c.json({
      ok: true,
      order: result.order,
      providerRequest: result.providerRequest,
      outbound: result.outbound,
    });
  });

  app.post("/api/admin/provider-orders/:id/cancel", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await readBody(c);
    const disabled = await rejectIfProviderRelayDisabled(c, opts.db, tenantId);
    if (disabled) return disabled;
    const now = epochNow();

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const relay = new ProviderRelayRepo({ db: tx, tenantId });
      const order = await relay.orderById(id);
      if (!order) return { error: "order not found", status: 404 as const };
      if (!canTransitionServiceOrder(order.status, "cancelled")) {
        return {
          error: `cannot cancel order from ${order.status}`,
          status: 409 as const,
        };
      }
      const cancelled = await relay.transitionOrderStatus(id, "cancelled", now);
      await relay.appendEvent({
        orderId: id,
        actorType: "operator",
        eventType: "order_cancelled",
        data: {
          adminId: adminId ?? null,
          reason: cleanString(body.reason) || null,
        },
        nowEpoch: now,
      });
      return { order: cancelled };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_order.cancel",
      targetKind: "service_order",
      targetId: String(id),
      details: { reason: cleanString(body.reason) || null },
    });
    return c.json({ ok: true, order: result.order });
  });

  app.post("/api/admin/provider-orders/:id/mark-fulfilled", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const disabled = await rejectIfProviderRelayDisabled(c, opts.db, tenantId);
    if (disabled) return disabled;
    const now = epochNow();

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const relay = new ProviderRelayRepo({ db: tx, tenantId });
      const transitions: Array<{ from: string; to: string }> = [];
      let order = await relay.orderById(id);
      if (!order) return { error: "order not found", status: 404 as const };
      if (order.status === "fulfilled") return { order };
      if (order.status === "awaiting_customer_payment" && order.paymentStatus === "paid") {
        transitions.push({ from: order.status, to: "paid" });
        order = await relay.transitionOrderStatus(id, "paid", now);
      }
      if (order.status === "paid") {
        transitions.push({ from: order.status, to: "confirmed" });
        order = await relay.transitionOrderStatus(id, "confirmed", now);
      }
      if (order.status !== "confirmed") {
        return {
          error: `cannot fulfill order from ${order.status}`,
          status: 409 as const,
        };
      }
      transitions.push({ from: order.status, to: "fulfilled" });
      const fulfilled = await relay.transitionOrderStatus(id, "fulfilled", now);
      await relay.appendEvent({
        orderId: id,
        actorType: "operator",
        eventType: "order_fulfilled",
        data: { adminId: adminId ?? null, transitions },
        nowEpoch: now,
      });
      return { order: fulfilled, transitions };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    await recordProviderOrderAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_order.mark_fulfilled",
      targetKind: "service_order",
      targetId: String(id),
      details: { transitions: result.transitions ?? [] },
    });
    if (result.transitions && result.transitions.length > 0) {
      await recordProviderOrderAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider_order.payment_transition",
        targetKind: "service_order",
        targetId: String(id),
        details: { transitions: result.transitions },
      });
    }
    return c.json({ ok: true, order: result.order });
  });

  return app;
}

async function recordProviderOrderAudit(db: Db, entry: AuditEntry): Promise<void> {
  await withTenant(db, entry.tenantId, async (tx) => {
    await recordAudit(tx as Db, entry);
  });
}

type ProviderRelaySettings = {
  enabled: boolean;
  source: "default" | "flag";
  updatedAt: number | null;
};

type ProviderRelayMetrics = {
  generatedAt: number;
  ordersCreated: number;
  ordersByStatus: Record<string, number>;
  providerRequestsSent: number;
  providerRequestsByStatus: Record<string, number>;
  providerResponseRatePct: number | null;
  avgTimeToQuoteSec: number | null;
  paidOrders: number;
  commissionAmountTotal: number;
  paidCommissionAmount: number;
  failuresByChannel: Record<string, number>;
  failedDispatches: number;
  stuckOrders: {
    count: number;
    items: Array<{
      id: number;
      status: string;
      requestType: string;
      reason: "order_expired" | "quote_expired";
      dueAt: number;
    }>;
  };
};

const PROVIDER_RELAY_FLAG_DEFAULT = false;

const activeOrderStatuses = new Set([
  "intake",
  "matching",
  "awaiting_provider",
  "provider_declined",
  "offer_ready",
  "awaiting_customer_payment",
  "paid",
  "confirmed",
]);

const responseProviderRequestStatuses = new Set(["quoted", "accepted", "declined"]);

const openProviderRequestStatuses = new Set(["sent", "seen", "quoted"]);

async function loadProviderRelaySettings(db: Db, tenantId: number): Promise<ProviderRelaySettings> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        enabled: tenantFeatureFlags.enabled,
        updatedAt: tenantFeatureFlags.updatedAt,
      })
      .from(tenantFeatureFlags)
      .where(
        and(
          eq(tenantFeatureFlags.tenantId, tenantId),
          eq(tenantFeatureFlags.featureKey, PROVIDER_RELAY_FEATURE_KEY),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) {
    return {
      enabled: PROVIDER_RELAY_FLAG_DEFAULT,
      source: "default",
      updatedAt: null,
    };
  }
  return {
    enabled: row.enabled,
    source: "flag",
    updatedAt: row.updatedAt,
  };
}

async function setProviderRelayEnabled(
  db: Db,
  tenantId: number,
  enabled: boolean,
  now: number,
): Promise<ProviderRelaySettings> {
  const row = await withTenant(db, tenantId, (tx) =>
    new TenantFeatureFlagRepo({ db: tx, tenantId }).setEnabled({
      featureKey: PROVIDER_RELAY_FEATURE_KEY,
      enabled,
      nowEpoch: now,
      metadata: { source: "provider_order_console" },
    }),
  );
  return { enabled: row.enabled, source: "flag", updatedAt: row.updatedAt };
}

async function rejectIfProviderRelayDisabled(
  c: Context,
  db: Db,
  tenantId: number,
): Promise<Response | null> {
  const settings = await loadProviderRelaySettings(db, tenantId);
  if (settings.enabled) return null;
  return c.json({ error: "provider_relay_disabled", settings }, 403);
}

async function loadProviderRelayMetrics(
  db: Db,
  tenantId: number,
  now: number,
): Promise<ProviderRelayMetrics> {
  return withTenant(db, tenantId, async (tx) => {
    const orders = await tx
      .select({
        id: serviceOrders.id,
        status: serviceOrders.status,
        requestType: serviceOrders.requestType,
        paymentStatus: serviceOrders.paymentStatus,
        commissionAmount: serviceOrders.commissionAmount,
        expiresAt: serviceOrders.expiresAt,
        createdAt: serviceOrders.createdAt,
      })
      .from(serviceOrders)
      .where(eq(serviceOrders.tenantId, tenantId));

    const requests = await tx
      .select({
        id: providerRequests.id,
        orderId: providerRequests.orderId,
        status: providerRequests.status,
        channelKind: channels.kind,
        sentAt: providerRequests.sentAt,
        respondedAt: providerRequests.respondedAt,
        quoteExpiresAt: providerRequests.quoteExpiresAt,
        createdAt: providerRequests.createdAt,
      })
      .from(providerRequests)
      .leftJoin(
        channels,
        and(eq(channels.tenantId, tenantId), eq(channels.id, providerRequests.channelId)),
      )
      .where(eq(providerRequests.tenantId, tenantId));

    const failureEvents = await tx
      .select({
        providerRequestId: orderEvents.providerRequestId,
        dataJson: orderEvents.dataJson,
      })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.tenantId, tenantId),
          eq(orderEvents.eventType, "provider_request_send_failed"),
        ),
      );

    const ordersByStatus: Record<string, number> = {};
    let paidOrders = 0;
    let commissionAmountTotal = 0;
    let paidCommissionAmount = 0;
    for (const order of orders) {
      increment(ordersByStatus, order.status);
      if (order.paymentStatus === "paid") paidOrders += 1;
      commissionAmountTotal += order.commissionAmount ?? 0;
      if (order.paymentStatus === "paid") {
        paidCommissionAmount += order.commissionAmount ?? 0;
      }
    }

    const providerRequestsByStatus: Record<string, number> = {};
    const sentRequests = [];
    const respondedRequests = [];
    const quoteLatencies: number[] = [];
    const requestsById = new Map<number, (typeof requests)[number]>();
    const requestsByOrder = new Map<number, Array<(typeof requests)[number]>>();
    for (const request of requests) {
      increment(providerRequestsByStatus, request.status);
      requestsById.set(request.id, request);
      const list = requestsByOrder.get(request.orderId) ?? [];
      list.push(request);
      requestsByOrder.set(request.orderId, list);
      if (request.sentAt !== null || request.status !== "draft") {
        sentRequests.push(request);
      }
      if (request.respondedAt !== null || responseProviderRequestStatuses.has(request.status)) {
        respondedRequests.push(request);
      }
      if (
        request.sentAt !== null &&
        request.respondedAt !== null &&
        (request.status === "quoted" || request.status === "accepted")
      ) {
        quoteLatencies.push(Math.max(0, request.respondedAt - request.sentAt));
      }
    }

    const failuresByChannel: Record<string, number> = {};
    const failureEventRequestIds = new Set<number>();
    for (const event of failureEvents) {
      if (event.providerRequestId) {
        failureEventRequestIds.add(event.providerRequestId);
      }
      const request = event.providerRequestId ? requestsById.get(event.providerRequestId) : null;
      const eventData = parseJsonObject(event.dataJson);
      const channelKind =
        request?.channelKind ??
        (typeof eventData.channelKind === "string" ? eventData.channelKind : "unknown");
      increment(failuresByChannel, channelKind);
    }
    for (const request of requests) {
      if (request.status !== "failed" || failureEventRequestIds.has(request.id)) {
        continue;
      }
      increment(failuresByChannel, request.channelKind ?? "unknown");
    }

    const stuckItems: ProviderRelayMetrics["stuckOrders"]["items"] = [];
    for (const order of orders) {
      if (!activeOrderStatuses.has(order.status)) continue;
      if (order.expiresAt !== null && order.expiresAt < now) {
        stuckItems.push({
          id: order.id,
          status: order.status,
          requestType: order.requestType,
          reason: "order_expired",
          dueAt: order.expiresAt,
        });
        continue;
      }
      const expiredQuote = (requestsByOrder.get(order.id) ?? []).find(
        (request) =>
          openProviderRequestStatuses.has(request.status) &&
          request.quoteExpiresAt !== null &&
          request.quoteExpiresAt < now,
      );
      if (expiredQuote) {
        stuckItems.push({
          id: order.id,
          status: order.status,
          requestType: order.requestType,
          reason: "quote_expired",
          dueAt: expiredQuote.quoteExpiresAt ?? now,
        });
      }
    }

    return {
      generatedAt: now,
      ordersCreated: orders.length,
      ordersByStatus,
      providerRequestsSent: sentRequests.length,
      providerRequestsByStatus,
      providerResponseRatePct:
        sentRequests.length > 0
          ? roundOneDecimal((respondedRequests.length / sentRequests.length) * 100)
          : null,
      avgTimeToQuoteSec:
        quoteLatencies.length > 0
          ? Math.round(
              quoteLatencies.reduce((sum, seconds) => sum + seconds, 0) / quoteLatencies.length,
            )
          : null,
      paidOrders,
      commissionAmountTotal: roundMoney(commissionAmountTotal),
      paidCommissionAmount: roundMoney(paidCommissionAmount),
      failuresByChannel,
      failedDispatches: failureEvents.length,
      stuckOrders: {
        count: stuckItems.length,
        items: stuckItems.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id).slice(0, 20),
      },
    };
  });
}

async function latestProviderRequests(
  tx: Db,
  tenantId: number,
  orderIds: number[],
): Promise<Map<number, OrderListRow["latestProviderRequest"]>> {
  const byOrder = new Map<number, OrderListRow["latestProviderRequest"]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await tx
    .select({
      id: providerRequests.id,
      orderId: providerRequests.orderId,
      status: providerRequests.status,
      providerId: providerRequests.providerId,
      providerName: providerProfiles.name,
      quoteExpiresAt: providerRequests.quoteExpiresAt,
      updatedAt: providerRequests.updatedAt,
    })
    .from(providerRequests)
    .leftJoin(
      providerProfiles,
      and(
        eq(providerProfiles.tenantId, tenantId),
        eq(providerProfiles.id, providerRequests.providerId),
      ),
    )
    .where(
      and(eq(providerRequests.tenantId, tenantId), inArray(providerRequests.orderId, orderIds)),
    )
    .orderBy(desc(providerRequests.updatedAt), desc(providerRequests.id));
  for (const row of rows) {
    if (byOrder.has(row.orderId)) continue;
    byOrder.set(row.orderId, {
      id: row.id,
      status: row.status as ProviderRequestStatus,
      providerId: row.providerId,
      providerName: row.providerName,
      quoteExpiresAt: row.quoteExpiresAt,
      updatedAt: row.updatedAt,
    });
  }
  return byOrder;
}

async function latestOrderEvents(
  tx: Db,
  tenantId: number,
  orderIds: number[],
): Promise<Map<number, OrderListRow["lastEvent"]>> {
  const byOrder = new Map<number, OrderListRow["lastEvent"]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await tx
    .select({
      orderId: orderEvents.orderId,
      eventType: orderEvents.eventType,
      createdAt: orderEvents.createdAt,
    })
    .from(orderEvents)
    .where(and(eq(orderEvents.tenantId, tenantId), inArray(orderEvents.orderId, orderIds)))
    .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id));
  for (const row of rows) {
    if (!byOrder.has(row.orderId)) {
      byOrder.set(row.orderId, {
        eventType: row.eventType,
        createdAt: row.createdAt,
      });
    }
  }
  return byOrder;
}

async function loadOrderDetail(tx: Db, tenantId: number, orderId: number) {
  const [order] = await tx
    .select({
      id: serviceOrders.id,
      customerContactId: serviceOrders.customerContactId,
      customerConversationId: serviceOrders.customerConversationId,
      leadId: serviceOrders.leadId,
      assignedProviderId: serviceOrders.assignedProviderId,
      requestType: serviceOrders.requestType,
      status: serviceOrders.status,
      summary: serviceOrders.summary,
      quotedAmount: serviceOrders.quotedAmount,
      customerAmount: serviceOrders.customerAmount,
      commissionPct: serviceOrders.commissionPct,
      commissionAmount: serviceOrders.commissionAmount,
      currency: serviceOrders.currency,
      paymentStatus: serviceOrders.paymentStatus,
      paymentProvider: serviceOrders.paymentProvider,
      paymentRef: serviceOrders.paymentRef,
      metadataJson: serviceOrders.metadataJson,
      expiresAt: serviceOrders.expiresAt,
      confirmedAt: serviceOrders.confirmedAt,
      completedAt: serviceOrders.completedAt,
      cancelledAt: serviceOrders.cancelledAt,
      createdAt: serviceOrders.createdAt,
      updatedAt: serviceOrders.updatedAt,
      customerName: contacts.displayName,
      providerName: providerProfiles.name,
    })
    .from(serviceOrders)
    .leftJoin(
      contacts,
      and(eq(contacts.tenantId, tenantId), eq(contacts.id, serviceOrders.customerContactId)),
    )
    .leftJoin(
      providerProfiles,
      and(
        eq(providerProfiles.tenantId, tenantId),
        eq(providerProfiles.id, serviceOrders.assignedProviderId),
      ),
    )
    .where(and(eq(serviceOrders.tenantId, tenantId), eq(serviceOrders.id, orderId)))
    .limit(1);
  if (!order) return null;

  const requestRows = await tx
    .select({
      id: providerRequests.id,
      orderId: providerRequests.orderId,
      providerId: providerRequests.providerId,
      providerName: providerProfiles.name,
      providerConversationId: providerRequests.providerConversationId,
      channelId: providerRequests.channelId,
      channelKind: channels.kind,
      outboundQueueId: providerRequests.outboundQueueId,
      outboundStatus: outboundQueue.status,
      outboundLastError: outboundQueue.lastError,
      outboundSentAt: outboundQueue.sentAt,
      outboundPayloadJson: outboundQueue.payloadJson,
      status: providerRequests.status,
      quotedAmount: providerRequests.quotedAmount,
      customerAmount: providerRequests.customerAmount,
      commissionAmount: providerRequests.commissionAmount,
      currency: providerRequests.currency,
      availableAt: providerRequests.availableAt,
      quoteExpiresAt: providerRequests.quoteExpiresAt,
      responseText: providerRequests.responseText,
      sentAt: providerRequests.sentAt,
      respondedAt: providerRequests.respondedAt,
      expiredAt: providerRequests.expiredAt,
      cancelledAt: providerRequests.cancelledAt,
      metadataJson: providerRequests.metadataJson,
      createdAt: providerRequests.createdAt,
      updatedAt: providerRequests.updatedAt,
    })
    .from(providerRequests)
    .leftJoin(
      providerProfiles,
      and(
        eq(providerProfiles.tenantId, tenantId),
        eq(providerProfiles.id, providerRequests.providerId),
      ),
    )
    .leftJoin(
      channels,
      and(eq(channels.tenantId, tenantId), eq(channels.id, providerRequests.channelId)),
    )
    .leftJoin(
      outboundQueue,
      and(
        eq(outboundQueue.tenantId, tenantId),
        eq(outboundQueue.id, providerRequests.outboundQueueId),
      ),
    )
    .where(and(eq(providerRequests.tenantId, tenantId), eq(providerRequests.orderId, orderId)))
    .orderBy(desc(providerRequests.createdAt), desc(providerRequests.id));

  const events = await tx
    .select({
      id: orderEvents.id,
      providerRequestId: orderEvents.providerRequestId,
      conversationId: orderEvents.conversationId,
      messageId: orderEvents.messageId,
      actorType: orderEvents.actorType,
      eventType: orderEvents.eventType,
      dataJson: orderEvents.dataJson,
      createdAt: orderEvents.createdAt,
    })
    .from(orderEvents)
    .where(and(eq(orderEvents.tenantId, tenantId), eq(orderEvents.orderId, orderId)))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));

  const conversationIds = [
    order.customerConversationId,
    ...requestRows.map((request) => request.providerConversationId),
  ].filter((id): id is number => typeof id === "number");
  const messageRows =
    conversationIds.length > 0
      ? await tx
          .select({
            id: messages.id,
            conversationId: messages.conversationId,
            role: messages.role,
            text: messages.text,
            metaJson: messages.metaJson,
            createdAt: messages.createdAt,
            stage: messages.stage,
            deletedAt: messages.deletedAt,
          })
          .from(messages)
          .where(
            and(eq(messages.tenantId, tenantId), inArray(messages.conversationId, conversationIds)),
          )
          .orderBy(asc(messages.createdAt), asc(messages.id))
      : [];

  const messagesByConversation = new Map<number, typeof messageRows>();
  for (const message of messageRows) {
    const list = messagesByConversation.get(message.conversationId) ?? [];
    list.push(message);
    messagesByConversation.set(message.conversationId, list);
  }

  const customerChannels = await tx
    .select({
      channelId: channelIdentities.channelId,
      channelKind: channels.kind,
      externalUserId: channelIdentities.externalUserId,
    })
    .from(channelIdentities)
    .innerJoin(
      channels,
      and(
        eq(channels.id, channelIdentities.channelId),
        eq(channels.tenantId, tenantId),
        eq(channels.status, "active"),
      ),
    )
    .where(eq(channelIdentities.contactId, order.customerContactId))
    .orderBy(asc(channels.kind), asc(channelIdentities.channelId));

  return {
    order: {
      id: order.id,
      status: order.status,
      requestType: order.requestType,
      summary: order.summary,
      leadId: order.leadId,
      amounts: {
        quotedAmount: order.quotedAmount,
        customerAmount: order.customerAmount,
        commissionPct: order.commissionPct,
        commissionAmount: order.commissionAmount,
        currency: order.currency,
      },
      payment: {
        status: order.paymentStatus,
        provider: order.paymentProvider,
        ref: order.paymentRef,
      },
      metadata: parseJsonObject(order.metadataJson),
      expiresAt: order.expiresAt,
      confirmedAt: order.confirmedAt,
      completedAt: order.completedAt,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    },
    customer: {
      id: order.customerContactId,
      name: order.customerName,
      conversationId: order.customerConversationId,
      channels: customerChannels,
      messages: order.customerConversationId
        ? (messagesByConversation.get(order.customerConversationId) ?? [])
        : [],
    },
    provider: order.assignedProviderId
      ? { id: order.assignedProviderId, name: order.providerName }
      : null,
    providerRequests: requestRows.map((request) => ({
      id: request.id,
      orderId: request.orderId,
      providerId: request.providerId,
      providerName: request.providerName,
      providerConversationId: request.providerConversationId,
      channelId: request.channelId,
      channelKind: request.channelKind,
      outboundQueueId: request.outboundQueueId,
      outboundStatus: request.outboundStatus,
      outboundLastError: request.outboundLastError,
      outboundSentAt: request.outboundSentAt,
      outboundText: outboundText(request.outboundPayloadJson),
      status: request.status,
      quotedAmount: request.quotedAmount,
      customerAmount: request.customerAmount,
      commissionAmount: request.commissionAmount,
      currency: request.currency,
      availableAt: request.availableAt,
      quoteExpiresAt: request.quoteExpiresAt,
      responseText: request.responseText,
      sentAt: request.sentAt,
      respondedAt: request.respondedAt,
      expiredAt: request.expiredAt,
      cancelledAt: request.cancelledAt,
      metadata: parseJsonObject(request.metadataJson),
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      messages: request.providerConversationId
        ? (messagesByConversation.get(request.providerConversationId) ?? [])
        : [],
    })),
    events: events.map((event) => ({
      ...event,
      data: parseJsonObject(event.dataJson),
    })),
    sla: buildSla({
      now: epochNow(),
      orderExpiresAt: order.expiresAt,
      quoteExpiresAt: requestRows[0]?.quoteExpiresAt ?? null,
    }),
  };
}

async function selectQuoteRequest(
  tx: Db,
  tenantId: number,
  orderId: number,
  providerRequestId: number | null,
) {
  const rows = await tx
    .select()
    .from(providerRequests)
    .where(
      and(
        eq(providerRequests.tenantId, tenantId),
        eq(providerRequests.orderId, orderId),
        providerRequestId
          ? eq(providerRequests.id, providerRequestId)
          : inArray(providerRequests.status, ["quoted", "accepted"]),
      ),
    )
    .orderBy(desc(providerRequests.respondedAt), desc(providerRequests.id))
    .limit(1);
  return rows[0] ?? null;
}

function buildSla(input: {
  now: number;
  orderExpiresAt: number | null;
  quoteExpiresAt: number | null;
}) {
  const dueAt = input.quoteExpiresAt ?? input.orderExpiresAt;
  if (!dueAt) return { state: "none" as const, dueAt: null, secondsLeft: null };
  const secondsLeft = dueAt - input.now;
  if (secondsLeft < 0) {
    return { state: "breached" as const, dueAt, secondsLeft };
  }
  if (secondsLeft <= 3600) {
    return { state: "risk" as const, dueAt, secondsLeft };
  }
  return { state: "ok" as const, dueAt, secondsLeft };
}

function outboundText(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  const payload = parseJsonObject(payloadJson);
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const textParts = parts
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string" ? part.text : null,
    )
    .filter((part): part is string => Boolean(part));
  return textParts.length > 0 ? textParts.join("\n") : null;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readBody(c: Context) {
  return c.req.json<ActionBody>().catch(() => ({}) as ActionBody);
}

function parsePositiveId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}
