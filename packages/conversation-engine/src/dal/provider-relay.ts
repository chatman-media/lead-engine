import {
	orderEvents,
	providerRequests,
	serviceOrders,
} from "@chatman-media/storage";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

function roundMoney(value: number): number {
	return Math.round(value * 100) / 100;
}

export const SERVICE_ORDER_STATUSES = [
	"intake",
	"matching",
	"awaiting_provider",
	"provider_declined",
	"offer_ready",
	"awaiting_customer_payment",
	"paid",
	"confirmed",
	"fulfilled",
	"cancelled",
	"failed",
] as const;

export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];

export const PROVIDER_REQUEST_STATUSES = [
	"draft",
	"sent",
	"seen",
	"quoted",
	"accepted",
	"declined",
	"expired",
	"cancelled",
] as const;

export type ProviderRequestStatus = (typeof PROVIDER_REQUEST_STATUSES)[number];

export type OrderEventActorType =
	| "system"
	| "customer"
	| "provider"
	| "operator"
	| "payment";

export const ACTIVE_SERVICE_ORDER_STATUSES: ServiceOrderStatus[] = [
	"intake",
	"matching",
	"awaiting_provider",
	"provider_declined",
	"offer_ready",
	"awaiting_customer_payment",
	"paid",
	"confirmed",
];

const serviceOrderTransitions: Record<
	ServiceOrderStatus,
	readonly ServiceOrderStatus[]
> = {
	intake: ["matching", "awaiting_provider", "cancelled", "failed"],
	matching: [
		"awaiting_provider",
		"provider_declined",
		"offer_ready",
		"cancelled",
		"failed",
	],
	awaiting_provider: [
		"provider_declined",
		"offer_ready",
		"cancelled",
		"failed",
	],
	provider_declined: ["matching", "cancelled", "failed"],
	offer_ready: ["awaiting_customer_payment", "cancelled", "failed"],
	awaiting_customer_payment: ["paid", "cancelled", "failed"],
	paid: ["confirmed", "cancelled", "failed"],
	confirmed: ["fulfilled", "cancelled", "failed"],
	fulfilled: [],
	cancelled: [],
	failed: [],
};

const providerRequestTransitions: Record<
	ProviderRequestStatus,
	readonly ProviderRequestStatus[]
> = {
	draft: ["sent", "cancelled"],
	sent: ["seen", "quoted", "accepted", "declined", "expired", "cancelled"],
	seen: ["quoted", "accepted", "declined", "expired", "cancelled"],
	quoted: ["accepted", "declined", "expired", "cancelled"],
	accepted: ["cancelled"],
	declined: [],
	expired: [],
	cancelled: [],
};

export function canTransitionServiceOrder(
	from: ServiceOrderStatus,
	to: ServiceOrderStatus,
): boolean {
	return from === to || serviceOrderTransitions[from].includes(to);
}

export function assertServiceOrderTransition(
	from: ServiceOrderStatus,
	to: ServiceOrderStatus,
): void {
	if (!canTransitionServiceOrder(from, to)) {
		throw new Error(`invalid service order transition: ${from} -> ${to}`);
	}
}

export function canTransitionProviderRequest(
	from: ProviderRequestStatus,
	to: ProviderRequestStatus,
): boolean {
	return from === to || providerRequestTransitions[from].includes(to);
}

export function assertProviderRequestTransition(
	from: ProviderRequestStatus,
	to: ProviderRequestStatus,
): void {
	if (!canTransitionProviderRequest(from, to)) {
		throw new Error(`invalid provider request transition: ${from} -> ${to}`);
	}
}

export interface ServiceOrderRow {
	id: number;
	tenantId: number;
	customerContactId: number;
	customerConversationId: number | null;
	leadId: number | null;
	assignedProviderId: number | null;
	requestType: string;
	status: ServiceOrderStatus;
	summary: string | null;
	quotedAmount: number | null;
	customerAmount: number | null;
	commissionPct: number | null;
	commissionAmount: number | null;
	currency: string;
	paymentStatus: "unpaid" | "pending" | "paid" | "refunded" | "failed";
	paymentProvider: string | null;
	paymentRef: string | null;
	idempotencyKey: string | null;
	metadataJson: string;
	expiresAt: number | null;
	confirmedAt: number | null;
	completedAt: number | null;
	cancelledAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ProviderRequestRow {
	id: number;
	tenantId: number;
	orderId: number;
	providerId: number | null;
	providerConversationId: number | null;
	channelId: number | null;
	outboundQueueId: number | null;
	status: ProviderRequestStatus;
	quotedAmount: number | null;
	customerAmount: number | null;
	commissionAmount: number | null;
	currency: string;
	availableAt: number | null;
	quoteExpiresAt: number | null;
	responseText: string | null;
	idempotencyKey: string | null;
	metadataJson: string;
	sentAt: number | null;
	respondedAt: number | null;
	expiredAt: number | null;
	cancelledAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface OrderEventRow {
	id: number;
	tenantId: number;
	orderId: number;
	providerRequestId: number | null;
	conversationId: number | null;
	messageId: number | null;
	actorType: OrderEventActorType;
	eventType: string;
	dataJson: string;
	createdAt: number;
}

export class ProviderRelayRepo {
	constructor(private readonly ctx: RepoCtx) {}

	async orderById(orderId: number): Promise<ServiceOrderRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(serviceOrders)
			.where(
				and(
					eq(serviceOrders.id, orderId),
					eq(serviceOrders.tenantId, this.ctx.tenantId),
				),
			);
		return (row as ServiceOrderRow) ?? null;
	}

	async providerRequestById(
		requestId: number,
	): Promise<ProviderRequestRow | null> {
		const [row] = await this.ctx.db
			.select()
			.from(providerRequests)
			.where(
				and(
					eq(providerRequests.id, requestId),
					eq(providerRequests.tenantId, this.ctx.tenantId),
				),
			);
		return (row as ProviderRequestRow) ?? null;
	}

	async createServiceOrder(opts: {
		customerContactId: number;
		requestType: string;
		nowEpoch: number;
		customerConversationId?: number | null;
		leadId?: number | null;
		assignedProviderId?: number | null;
		status?: ServiceOrderStatus;
		summary?: string | null;
		quotedAmount?: number | null;
		customerAmount?: number | null;
		commissionPct?: number | null;
		commissionAmount?: number | null;
		currency?: string;
		paymentStatus?: ServiceOrderRow["paymentStatus"];
		paymentProvider?: string | null;
		paymentRef?: string | null;
		idempotencyKey?: string | null;
		metadata?: Record<string, unknown>;
		expiresAt?: number | null;
	}): Promise<ServiceOrderRow> {
		if (opts.idempotencyKey) {
			const [existing] = await this.ctx.db
				.select()
				.from(serviceOrders)
				.where(
					and(
						eq(serviceOrders.tenantId, this.ctx.tenantId),
						eq(serviceOrders.idempotencyKey, opts.idempotencyKey),
					),
				);
			if (existing) return existing as ServiceOrderRow;
		}

		const [row] = await this.ctx.db
			.insert(serviceOrders)
			.values({
				tenantId: this.ctx.tenantId,
				customerContactId: opts.customerContactId,
				requestType: opts.requestType,
				status: opts.status ?? "intake",
				createdAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
				...(opts.customerConversationId !== undefined
					? { customerConversationId: opts.customerConversationId }
					: {}),
				...(opts.leadId !== undefined ? { leadId: opts.leadId } : {}),
				...(opts.assignedProviderId !== undefined
					? { assignedProviderId: opts.assignedProviderId }
					: {}),
				...(opts.summary !== undefined ? { summary: opts.summary } : {}),
				...(opts.quotedAmount !== undefined
					? { quotedAmount: opts.quotedAmount }
					: {}),
				...(opts.customerAmount !== undefined
					? { customerAmount: opts.customerAmount }
					: {}),
				...(opts.commissionPct !== undefined
					? { commissionPct: opts.commissionPct }
					: {}),
				...(opts.commissionAmount !== undefined
					? { commissionAmount: opts.commissionAmount }
					: {}),
				...(opts.currency ? { currency: opts.currency } : {}),
				...(opts.paymentStatus ? { paymentStatus: opts.paymentStatus } : {}),
				...(opts.paymentProvider !== undefined
					? { paymentProvider: opts.paymentProvider }
					: {}),
				...(opts.paymentRef !== undefined
					? { paymentRef: opts.paymentRef }
					: {}),
				...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
				...(opts.metadata
					? { metadataJson: JSON.stringify(opts.metadata) }
					: {}),
				...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
			})
			.returning();
		if (!row) throw new Error("service_orders.create: insert returned no row");
		return row as ServiceOrderRow;
	}

	async findActiveOrdersByCustomer(
		customerContactId: number,
		limit = 20,
	): Promise<ServiceOrderRow[]> {
		const rows = await this.ctx.db
			.select()
			.from(serviceOrders)
			.where(
				and(
					eq(serviceOrders.tenantId, this.ctx.tenantId),
					eq(serviceOrders.customerContactId, customerContactId),
					inArray(serviceOrders.status, ACTIVE_SERVICE_ORDER_STATUSES),
				),
			)
			.orderBy(desc(serviceOrders.updatedAt))
			.limit(limit);
		return rows as ServiceOrderRow[];
	}

	async transitionOrderStatus(
		orderId: number,
		nextStatus: ServiceOrderStatus,
		nowEpoch: number,
	): Promise<ServiceOrderRow> {
		const current = await this.orderById(orderId);
		if (!current) throw new Error(`service order not found: ${orderId}`);
		assertServiceOrderTransition(current.status, nextStatus);

		const [row] = await this.ctx.db
			.update(serviceOrders)
			.set({
				status: nextStatus,
				updatedAt: nowEpoch,
				...(nextStatus === "confirmed" ? { confirmedAt: nowEpoch } : {}),
				...(nextStatus === "fulfilled" ? { completedAt: nowEpoch } : {}),
				...(nextStatus === "cancelled" ? { cancelledAt: nowEpoch } : {}),
			})
			.where(
				and(
					eq(serviceOrders.id, orderId),
					eq(serviceOrders.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!row)
			throw new Error("service_orders.transition: update returned no row");
		return row as ServiceOrderRow;
	}

	async addProviderRequest(opts: {
		orderId: number;
		nowEpoch: number;
		providerId?: number | null;
		providerConversationId?: number | null;
		channelId?: number | null;
		outboundQueueId?: number | null;
		status?: ProviderRequestStatus;
		commissionPct?: number | null;
		currency?: string;
		quoteExpiresAt?: number | null;
		idempotencyKey?: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<ProviderRequestRow> {
		if (opts.idempotencyKey) {
			const [existing] = await this.ctx.db
				.select()
				.from(providerRequests)
				.where(
					and(
						eq(providerRequests.tenantId, this.ctx.tenantId),
						eq(providerRequests.idempotencyKey, opts.idempotencyKey),
					),
				);
			if (existing) return existing as ProviderRequestRow;
		}

		const order = await this.orderById(opts.orderId);
		if (!order) throw new Error(`service order not found: ${opts.orderId}`);
		assertServiceOrderTransition(order.status, "awaiting_provider");

		const [row] = await this.ctx.db
			.insert(providerRequests)
			.values({
				tenantId: this.ctx.tenantId,
				orderId: opts.orderId,
				status: opts.status ?? "draft",
				createdAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
				...(opts.status === "sent" ? { sentAt: opts.nowEpoch } : {}),
				...(opts.providerId !== undefined
					? { providerId: opts.providerId }
					: {}),
				...(opts.providerConversationId !== undefined
					? { providerConversationId: opts.providerConversationId }
					: {}),
				...(opts.channelId !== undefined ? { channelId: opts.channelId } : {}),
				...(opts.outboundQueueId !== undefined
					? { outboundQueueId: opts.outboundQueueId }
					: {}),
				...(opts.currency ? { currency: opts.currency } : {}),
				...(opts.quoteExpiresAt !== undefined
					? { quoteExpiresAt: opts.quoteExpiresAt }
					: {}),
				...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
				...(opts.metadata
					? { metadataJson: JSON.stringify(opts.metadata) }
					: {}),
			})
			.returning();
		if (!row)
			throw new Error("provider_requests.create: insert returned no row");

		await this.transitionOrderStatus(
			opts.orderId,
			"awaiting_provider",
			opts.nowEpoch,
		);
		if (
			(opts.providerId !== undefined && opts.providerId !== null) ||
			opts.commissionPct !== undefined
		) {
			await this.ctx.db
				.update(serviceOrders)
				.set({
					...(opts.providerId !== undefined && opts.providerId !== null
						? { assignedProviderId: opts.providerId }
						: {}),
					...(opts.commissionPct !== undefined
						? { commissionPct: opts.commissionPct }
						: {}),
					updatedAt: opts.nowEpoch,
				})
				.where(
					and(
						eq(serviceOrders.id, opts.orderId),
						eq(serviceOrders.tenantId, this.ctx.tenantId),
					),
				);
		}
		await this.appendEvent({
			orderId: opts.orderId,
			providerRequestId: row.id,
			actorType: "system",
			eventType: "provider_request_created",
			data: { providerId: opts.providerId ?? null },
			nowEpoch: opts.nowEpoch,
		});

		return row as ProviderRequestRow;
	}

	async transitionProviderRequestStatus(
		requestId: number,
		nextStatus: ProviderRequestStatus,
		nowEpoch: number,
	): Promise<ProviderRequestRow> {
		const current = await this.providerRequestById(requestId);
		if (!current) throw new Error(`provider request not found: ${requestId}`);
		assertProviderRequestTransition(current.status, nextStatus);

		const [row] = await this.ctx.db
			.update(providerRequests)
			.set({
				status: nextStatus,
				updatedAt: nowEpoch,
				...(nextStatus === "sent" ? { sentAt: nowEpoch } : {}),
				...(nextStatus === "expired" ? { expiredAt: nowEpoch } : {}),
				...(nextStatus === "cancelled" ? { cancelledAt: nowEpoch } : {}),
			})
			.where(
				and(
					eq(providerRequests.id, requestId),
					eq(providerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!row) {
			throw new Error("provider_requests.transition: update returned no row");
		}
		return row as ProviderRequestRow;
	}

	async recordProviderQuote(opts: {
		providerRequestId: number;
		quotedAmount: number;
		customerAmount?: number | null;
		commissionAmount?: number | null;
		currency?: string;
		availableAt?: number | null;
		quoteExpiresAt?: number | null;
		responseText?: string | null;
		nowEpoch: number;
		data?: Record<string, unknown>;
	}): Promise<ProviderRequestRow> {
		const current = await this.providerRequestById(opts.providerRequestId);
		if (!current) {
			throw new Error(`provider request not found: ${opts.providerRequestId}`);
		}
		assertProviderRequestTransition(current.status, "quoted");

		const order = await this.orderById(current.orderId);
		if (!order) throw new Error(`service order not found: ${current.orderId}`);
		assertServiceOrderTransition(order.status, "offer_ready");

		const commissionPct = order.commissionPct ?? null;
		const commissionAmount =
			opts.commissionAmount ??
			(commissionPct !== null
				? roundMoney((opts.quotedAmount * commissionPct) / 100)
				: null);
		const customerAmount =
			opts.customerAmount ??
			(commissionAmount !== null
				? roundMoney(opts.quotedAmount + commissionAmount)
				: opts.quotedAmount);
		const [request] = await this.ctx.db
			.update(providerRequests)
			.set({
				status: "quoted",
				quotedAmount: opts.quotedAmount,
				customerAmount,
				commissionAmount,
				currency: opts.currency ?? current.currency,
				availableAt: opts.availableAt ?? null,
				quoteExpiresAt: opts.quoteExpiresAt ?? current.quoteExpiresAt,
				responseText: opts.responseText ?? null,
				respondedAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
			})
			.where(
				and(
					eq(providerRequests.id, opts.providerRequestId),
					eq(providerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!request) {
			throw new Error("provider_requests.quote: update returned no row");
		}

		const [updatedOrder] = await this.ctx.db
			.update(serviceOrders)
			.set({
				status: "offer_ready",
				assignedProviderId: current.providerId,
				quotedAmount: opts.quotedAmount,
				customerAmount,
				commissionAmount,
				currency: opts.currency ?? order.currency,
				updatedAt: opts.nowEpoch,
			})
			.where(
				and(
					eq(serviceOrders.id, current.orderId),
					eq(serviceOrders.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!updatedOrder) {
			throw new Error("service_orders.quote: update returned no row");
		}

		await this.appendEvent({
			orderId: current.orderId,
			providerRequestId: opts.providerRequestId,
			actorType: "provider",
			eventType: "provider_quoted",
			data: {
				quotedAmount: opts.quotedAmount,
				customerAmount,
				commissionPct,
				commissionAmount,
				...(opts.data ?? {}),
			},
			nowEpoch: opts.nowEpoch,
		});

		return request as ProviderRequestRow;
	}

	async recordProviderDecline(opts: {
		providerRequestId: number;
		responseText?: string | null;
		nowEpoch: number;
		data?: Record<string, unknown>;
	}): Promise<ProviderRequestRow> {
		const current = await this.providerRequestById(opts.providerRequestId);
		if (!current) {
			throw new Error(`provider request not found: ${opts.providerRequestId}`);
		}
		assertProviderRequestTransition(current.status, "declined");

		const order = await this.orderById(current.orderId);
		if (!order) throw new Error(`service order not found: ${current.orderId}`);
		assertServiceOrderTransition(order.status, "provider_declined");

		const [request] = await this.ctx.db
			.update(providerRequests)
			.set({
				status: "declined",
				responseText: opts.responseText ?? null,
				respondedAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
			})
			.where(
				and(
					eq(providerRequests.id, opts.providerRequestId),
					eq(providerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!request) {
			throw new Error("provider_requests.decline: update returned no row");
		}

		await this.transitionOrderStatus(
			current.orderId,
			"provider_declined",
			opts.nowEpoch,
		);
		await this.appendEvent({
			orderId: current.orderId,
			providerRequestId: opts.providerRequestId,
			actorType: "provider",
			eventType: "provider_declined",
			data: {
				responseText: opts.responseText ?? null,
				...(opts.data ?? {}),
			},
			nowEpoch: opts.nowEpoch,
		});

		return request as ProviderRequestRow;
	}

	async expireProviderRequest(opts: {
		providerRequestId: number;
		nowEpoch: number;
		data?: Record<string, unknown>;
	}): Promise<ProviderRequestRow> {
		const current = await this.providerRequestById(opts.providerRequestId);
		if (!current) {
			throw new Error(`provider request not found: ${opts.providerRequestId}`);
		}
		assertProviderRequestTransition(current.status, "expired");

		const order = await this.orderById(current.orderId);
		if (!order) throw new Error(`service order not found: ${current.orderId}`);
		assertServiceOrderTransition(order.status, "provider_declined");

		const [request] = await this.ctx.db
			.update(providerRequests)
			.set({
				status: "expired",
				expiredAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
			})
			.where(
				and(
					eq(providerRequests.id, opts.providerRequestId),
					eq(providerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!request) {
			throw new Error("provider_requests.expire: update returned no row");
		}

		await this.transitionOrderStatus(
			current.orderId,
			"provider_declined",
			opts.nowEpoch,
		);
		await this.appendEvent({
			orderId: current.orderId,
			providerRequestId: opts.providerRequestId,
			actorType: "system",
			eventType: "provider_request_expired",
			data: opts.data,
			nowEpoch: opts.nowEpoch,
		});

		return request as ProviderRequestRow;
	}

	async appendEvent(opts: {
		orderId: number;
		eventType: string;
		nowEpoch: number;
		actorType?: OrderEventActorType;
		providerRequestId?: number | null;
		conversationId?: number | null;
		messageId?: number | null;
		data?: Record<string, unknown>;
	}): Promise<OrderEventRow> {
		const [row] = await this.ctx.db
			.insert(orderEvents)
			.values({
				tenantId: this.ctx.tenantId,
				orderId: opts.orderId,
				eventType: opts.eventType,
				actorType: opts.actorType ?? "system",
				dataJson: JSON.stringify(opts.data ?? {}),
				createdAt: opts.nowEpoch,
				...(opts.providerRequestId !== undefined
					? { providerRequestId: opts.providerRequestId }
					: {}),
				...(opts.conversationId !== undefined
					? { conversationId: opts.conversationId }
					: {}),
				...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
			})
			.returning();
		if (!row) throw new Error("order_events.insert: insert returned no row");
		return row as OrderEventRow;
	}

	async eventsForOrder(orderId: number, limit = 50): Promise<OrderEventRow[]> {
		const rows = await this.ctx.db
			.select()
			.from(orderEvents)
			.where(
				and(
					eq(orderEvents.tenantId, this.ctx.tenantId),
					eq(orderEvents.orderId, orderId),
				),
			)
			.orderBy(desc(orderEvents.createdAt))
			.limit(limit);
		return rows as OrderEventRow[];
	}
}
