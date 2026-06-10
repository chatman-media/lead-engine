import {
	canTransitionServiceOrder,
	CustomerOfferFlow,
	type Db,
	ProviderRelayOrchestrator,
	ProviderRelayRepo,
	type ProviderRequestStatus,
	type ServiceOrderStatus,
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
} from "@chatman-media/storage";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

type ActionBody = {
	providerId?: unknown;
	providerRequestId?: unknown;
	messageText?: unknown;
	offerText?: unknown;
	paymentInstructions?: unknown;
	customerChannelId?: unknown;
	serviceArea?: unknown;
	reason?: unknown;
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
					and(
						eq(contacts.tenantId, tenantId),
						eq(contacts.id, serviceOrders.customerContactId),
					),
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
						quoteExpiresAt:
							latestRequests.get(order.id)?.quoteExpiresAt ?? null,
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
						...(requestType
							? [eq(providerServices.serviceType, requestType)]
							: []),
					),
				)
				.where(
					and(
						eq(providerProfiles.tenantId, tenantId),
						eq(providerProfiles.status, "active"),
					),
				)
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
			const item =
				byProvider.get(row.id) ??
				{
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
				.where(
					and(
						eq(serviceOrders.tenantId, tenantId),
						eq(serviceOrders.id, id),
					),
				)
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
		await recordAudit(opts.db, {
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
		await recordAudit(opts.db, {
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
		const now = epochNow();

		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const relay = new ProviderRelayRepo({ db: tx, tenantId });
			const order = await relay.orderById(id);
			if (!order) return { error: "order not found", status: 404 as const };
			const request = await selectQuoteRequest(tx, tenantId, id, providerRequestId);
			if (!request) return { error: "quote not found", status: 409 as const };
			const accepted = await relay.transitionProviderRequestStatus(
				request.id,
				"accepted",
				now,
			);
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
		await recordAudit(opts.db, {
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
		const now = epochNow();

		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const flow = new CustomerOfferFlow({ db: tx, tenantId });
			return flow.sendCustomerOffer({
				orderId: id,
				nowEpoch: now,
				customerChannelId: parsePositiveId(body.customerChannelId) ?? undefined,
				offerTextOverride: cleanString(body.offerText) || null,
				paymentInstructions: cleanString(body.paymentInstructions) || null,
				approvedByAdminId: adminId ?? null,
			});
		});

		if (!result.ok) {
			return c.json(
				{ error: result.reason, order: result.order },
				result.reason === "order_not_found" ? 404 : 409,
			);
		}
		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "provider_order.send_customer_offer",
			targetKind: "service_order",
			targetId: String(id),
			details: {
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

	app.post("/api/admin/provider-orders/:id/cancel", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = c.var.adminId as number | undefined;
		const id = parsePositiveId(c.req.param("id"));
		if (!id) return c.json({ error: "bad id" }, 400);
		const body = await readBody(c);
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
		await recordAudit(opts.db, {
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
		const now = epochNow();

		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const relay = new ProviderRelayRepo({ db: tx, tenantId });
			let order = await relay.orderById(id);
			if (!order) return { error: "order not found", status: 404 as const };
			if (order.status === "fulfilled") return { order };
			if (
				order.status === "awaiting_customer_payment" &&
				order.paymentStatus === "paid"
			) {
				order = await relay.transitionOrderStatus(id, "paid", now);
			}
			if (order.status === "paid") {
				order = await relay.transitionOrderStatus(id, "confirmed", now);
			}
			if (order.status !== "confirmed") {
				return {
					error: `cannot fulfill order from ${order.status}`,
					status: 409 as const,
				};
			}
			const fulfilled = await relay.transitionOrderStatus(id, "fulfilled", now);
			await relay.appendEvent({
				orderId: id,
				actorType: "operator",
				eventType: "order_fulfilled",
				data: { adminId: adminId ?? null },
				nowEpoch: now,
			});
			return { order: fulfilled };
		});
		if ("error" in result) return c.json({ error: result.error }, result.status);
		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "provider_order.mark_fulfilled",
			targetKind: "service_order",
			targetId: String(id),
			details: {},
		});
		return c.json({ ok: true, order: result.order });
	});

	return app;
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
			and(
				eq(providerRequests.tenantId, tenantId),
				inArray(providerRequests.orderId, orderIds),
			),
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
		.where(
			and(
				eq(orderEvents.tenantId, tenantId),
				inArray(orderEvents.orderId, orderIds),
			),
		)
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
			and(
				eq(contacts.tenantId, tenantId),
				eq(contacts.id, serviceOrders.customerContactId),
			),
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
			failedAt: providerRequests.failedAt,
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
			and(
				eq(channels.tenantId, tenantId),
				eq(channels.id, providerRequests.channelId),
			),
		)
		.leftJoin(
			outboundQueue,
			and(
				eq(outboundQueue.tenantId, tenantId),
				eq(outboundQueue.id, providerRequests.outboundQueueId),
			),
		)
		.where(
			and(
				eq(providerRequests.tenantId, tenantId),
				eq(providerRequests.orderId, orderId),
			),
		)
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
						and(
							eq(messages.tenantId, tenantId),
							inArray(messages.conversationId, conversationIds),
						),
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
			failedAt: request.failedAt,
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
			part && typeof part === "object" && typeof part.text === "string"
				? part.text
				: null,
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
	return c.req.json<ActionBody>().catch(() => ({} as ActionBody));
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

function epochNow(): number {
	return Math.floor(Date.now() / 1000);
}
