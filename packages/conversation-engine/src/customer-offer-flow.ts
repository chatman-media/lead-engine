import type {
	ChannelKind,
	OutboundEnvelope,
} from "@chatman-media/channel-core";
import {
	channelIdentities,
	channels,
	orderEvents,
	providerProfiles,
	providerRequests,
	serviceOrders,
} from "@chatman-media/storage";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
	type OrderEventRow,
	OutboundQueueRepo,
	type OutboundQueueRow,
	ProviderRelayRepo,
	type ProviderRequestRow,
	type ServiceOrderRow,
} from "./dal/index.ts";
import type { RepoCtx } from "./dal/types.ts";
import { ProviderPaymentLedger } from "./provider-payment-ledger.ts";

const defaultCustomerChannelKinds: ChannelKind[] = [
	"telegram_bot",
	"telegram_userbot",
	"whatsapp",
	"web",
	"facebook",
	"vk",
];

const defaultProviderChannelKinds: ChannelKind[] = [
	"whatsapp",
	"telegram_bot",
	"telegram_userbot",
	"web",
	"facebook",
	"vk",
];

interface ChannelIdentity {
	channelDbId: number;
	channelKind: ChannelKind;
	channelExternalId: string;
	externalUserId: string;
}

export interface CustomerOfferDraft {
	order: ServiceOrderRow;
	providerRequest: ProviderRequestRow;
	text: string;
	availabilityText: string | null;
	serviceArea: string | null;
	customerAmount: number;
	currency: string;
}

export interface SendCustomerOfferInput {
	orderId: number;
	nowEpoch: number;
	customerChannelId?: number;
	preferredChannelKinds?: ChannelKind[];
	offerTextOverride?: string | null;
	approvedByAdminId?: number | null;
	idempotencyKey?: string | null;
	paymentInstructions?: string | null;
}

export type SendCustomerOfferResult =
	| {
			ok: true;
			order: ServiceOrderRow;
			providerRequest: ProviderRequestRow;
			identity: ChannelIdentity;
			outbound: OutboundQueueRow;
			envelope: OutboundEnvelope;
			event: OrderEventRow | null;
	  }
	| {
			ok: false;
			reason:
				| "order_not_found"
				| "order_not_ready"
				| "provider_quote_missing"
				| "customer_channel_missing";
			order?: ServiceOrderRow;
	  };

export interface AcceptCustomerOfferInput {
	orderId: number;
	nowEpoch: number;
	acceptedByContactId?: number | null;
	messageId?: number | null;
	data?: Record<string, unknown>;
}

export interface CustomerOfferAccepted {
	order: ServiceOrderRow;
	providerRequest: ProviderRequestRow;
	event: OrderEventRow | null;
}

export interface RecordPaymentSuccessInput {
	orderId: number;
	nowEpoch: number;
	paymentProvider?: string | null;
	paymentRef?: string | null;
	providerChannelId?: number;
	providerConfirmationTextOverride?: string | null;
	idempotencyKey?: string | null;
	data?: Record<string, unknown>;
}

export type RecordPaymentSuccessResult =
	| {
			ok: true;
			order: ServiceOrderRow;
			providerRequest: ProviderRequestRow;
			identity: ChannelIdentity | null;
			outbound: OutboundQueueRow | null;
			envelope: OutboundEnvelope | null;
	  }
	| {
			ok: false;
			reason:
				| "order_not_found"
				| "order_not_payable"
				| "provider_request_missing"
				| "provider_channel_missing";
			order?: ServiceOrderRow;
	  };

export class CustomerOfferFlow {
	private readonly relay: ProviderRelayRepo;
	private readonly outbound: OutboundQueueRepo;

	constructor(private readonly ctx: RepoCtx) {
		this.relay = new ProviderRelayRepo(ctx);
		this.outbound = new OutboundQueueRepo(ctx);
	}

	async buildCustomerOrderContext(contactId: number): Promise<string | null> {
		const orders = await this.relay.findActiveOrdersByCustomer(contactId, 5);
		return formatCustomerOrderContext(orders);
	}

	async draftCustomerOffer(opts: {
		orderId: number;
		paymentInstructions?: string | null;
	}): Promise<CustomerOfferDraft | null> {
		const order = await this.relay.orderById(opts.orderId);
		if (!order || order.status !== "offer_ready") return null;
		const providerRequest = await this.latestProviderRequestForOrder(order.id, [
			"quoted",
			"accepted",
		]);
		if (!providerRequest) return null;

		const quoteEventData = await this.latestEventData(
			providerRequest.id,
			"provider_quoted",
		);
		const serviceArea = readString(order.metadataJson, [
			"serviceArea",
			"service_area",
			"area",
			"location",
		]);
		const availabilityText =
			typeof quoteEventData.availabilityText === "string" &&
			quoteEventData.availabilityText.trim()
				? quoteEventData.availabilityText.trim()
				: null;
		const customerAmount =
			order.customerAmount ??
			providerRequest.customerAmount ??
			order.quotedAmount ??
			providerRequest.quotedAmount;
		if (customerAmount === null) return null;

		return {
			order,
			providerRequest,
			text: renderCustomerOffer({
				order,
				providerRequest,
				serviceArea,
				availabilityText,
				customerAmount,
				currency: order.currency,
				paymentInstructions: opts.paymentInstructions,
			}),
			availabilityText,
			serviceArea,
			customerAmount,
			currency: order.currency,
		};
	}

	async sendCustomerOffer(
		input: SendCustomerOfferInput,
	): Promise<SendCustomerOfferResult> {
		const draft = await this.draftCustomerOffer({
			orderId: input.orderId,
			paymentInstructions: input.paymentInstructions,
		});
		const order = draft?.order ?? (await this.relay.orderById(input.orderId));
		if (!order) return { ok: false, reason: "order_not_found" };
		if (order.status !== "offer_ready") {
			return { ok: false, reason: "order_not_ready", order };
		}
		if (!draft) return { ok: false, reason: "provider_quote_missing", order };

		const identity = await this.resolveContactChannelIdentity({
			contactId: order.customerContactId,
			channelId: input.customerChannelId,
			preferredKinds: input.preferredChannelKinds ?? defaultCustomerChannelKinds,
		});
		if (!identity) return { ok: false, reason: "customer_channel_missing", order };

		const text = input.offerTextOverride?.trim() || draft.text;
		const idempotencyKey =
			input.idempotencyKey ?? `customer-offer:${order.id}:${identity.channelDbId}`;
		const envelope: OutboundEnvelope = {
			channelId: String(identity.channelDbId),
			externalUserId: identity.externalUserId,
			parts: [{ kind: "text", text }],
			idempotencyKey,
		};
		const outbound = await this.outbound.enqueue({
			channelId: identity.channelDbId,
			conversationId: order.customerConversationId,
			envelope,
			nowEpoch: input.nowEpoch,
		});
		const event = await this.appendOrderEventOnce({
			orderId: order.id,
			providerRequestId: draft.providerRequest.id,
			eventType: "customer_offer_sent",
			actorType: input.approvedByAdminId ? "operator" : "system",
			nowEpoch: input.nowEpoch,
			data: {
				outboundQueueId: outbound.id,
				channelId: identity.channelDbId,
				channelKind: identity.channelKind,
				offerText: text,
				manualOverride: !!input.offerTextOverride?.trim(),
				approvedByAdminId: input.approvedByAdminId ?? null,
				customerAmount: draft.customerAmount,
				currency: draft.currency,
				serviceArea: draft.serviceArea,
				availabilityText: draft.availabilityText,
			},
		});

		return {
			ok: true,
			order,
			providerRequest: draft.providerRequest,
			identity,
			outbound,
			envelope,
			event,
		};
	}

	async acceptCustomerOffer(
		input: AcceptCustomerOfferInput,
	): Promise<CustomerOfferAccepted> {
		const order = await this.requireOrder(input.orderId);
		if (
			order.status !== "offer_ready" &&
			order.status !== "awaiting_customer_payment"
		) {
			throw new Error(`service order is not offer-ready: ${order.status}`);
		}
		const providerRequest = await this.requireProviderRequest(order.id, [
			"quoted",
			"accepted",
		]);
		const acceptedRequest = await this.relay.transitionProviderRequestStatus(
			providerRequest.id,
			"accepted",
			input.nowEpoch,
		);
		const awaiting =
			order.status === "awaiting_customer_payment"
				? order
				: await this.relay.transitionOrderStatus(
						order.id,
						"awaiting_customer_payment",
						input.nowEpoch,
					);
		const updatedOrder = await this.updateOrderPaymentState({
			orderId: awaiting.id,
			status: "awaiting_customer_payment",
			paymentStatus: "pending",
			nowEpoch: input.nowEpoch,
		});
		const event = await this.appendOrderEventOnce({
			orderId: order.id,
			providerRequestId: acceptedRequest.id,
			messageId: input.messageId,
			eventType: "customer_offer_accepted",
			actorType: "customer",
			nowEpoch: input.nowEpoch,
			data: {
				acceptedByContactId: input.acceptedByContactId ?? order.customerContactId,
				...(input.data ?? {}),
			},
		});

		return { order: updatedOrder, providerRequest: acceptedRequest, event };
	}

	async recordPaymentSuccess(
		input: RecordPaymentSuccessInput,
	): Promise<RecordPaymentSuccessResult> {
		const initialOrder = await this.relay.orderById(input.orderId);
		if (!initialOrder) return { ok: false, reason: "order_not_found" };
		if (
			!["awaiting_customer_payment", "paid", "confirmed"].includes(
				initialOrder.status,
			)
		) {
			return {
				ok: false,
				reason: "order_not_payable",
				order: initialOrder,
			};
		}

		const providerRequest = await this.latestProviderRequestForOrder(
			initialOrder.id,
			["accepted", "quoted"],
		);
		if (!providerRequest) {
			return {
				ok: false,
				reason: "provider_request_missing",
				order: initialOrder,
			};
		}

		const paymentProvider = input.paymentProvider ?? "manual";
		const paymentRef = input.paymentRef ?? `manual:${initialOrder.id}`;
		const ledger = await new ProviderPaymentLedger(this.ctx).recordPaymentSucceeded({
			orderId: initialOrder.id,
			provider: paymentProvider,
			externalIntentId: paymentRef,
			idempotencyKey: `payment-success:${initialOrder.id}:${paymentProvider}:${paymentRef}`,
			nowEpoch: input.nowEpoch,
			metadata: input.data,
		});
		let order = ledger.order;

		if (order.status === "paid") {
			order = await this.relay.transitionOrderStatus(
				order.id,
				"confirmed",
				input.nowEpoch,
			);
			await this.appendOrderEventOnce({
				orderId: order.id,
				providerRequestId: providerRequest.id,
				eventType: "service_order_confirmed",
				actorType: "system",
				nowEpoch: input.nowEpoch,
				data: {
					paymentId: ledger.payment.id,
					commissionId: ledger.commission?.id ?? null,
					paymentRef,
				},
			});
		}

		const identity = await this.resolveProviderChannelIdentity({
			providerRequest,
			channelId: input.providerChannelId,
		});
		if (!identity) {
			return {
				ok: false,
				reason: "provider_channel_missing",
				order,
			};
		}

		const text =
			input.providerConfirmationTextOverride?.trim() ||
			renderProviderConfirmation({ order, providerRequest });
		const envelope: OutboundEnvelope = {
			channelId: String(identity.channelDbId),
			externalUserId: identity.externalUserId,
			parts: [{ kind: "text", text }],
			idempotencyKey:
				input.idempotencyKey ??
				`provider-confirmation:${order.id}:${providerRequest.id}:${identity.channelDbId}`,
		};
		const outbound = await this.outbound.enqueue({
			channelId: identity.channelDbId,
			conversationId: providerRequest.providerConversationId,
			envelope,
			nowEpoch: input.nowEpoch,
		});
		await this.appendOrderEventOnce({
			orderId: order.id,
			providerRequestId: providerRequest.id,
			eventType: "provider_confirmation_sent",
			actorType: "system",
			nowEpoch: input.nowEpoch,
			data: {
				outboundQueueId: outbound.id,
				channelId: identity.channelDbId,
				channelKind: identity.channelKind,
			},
		});

		return {
			ok: true,
			order,
			providerRequest,
			identity,
			outbound,
			envelope,
		};
	}

	private async latestProviderRequestForOrder(
		orderId: number,
		statuses: Array<ProviderRequestRow["status"]>,
	): Promise<ProviderRequestRow | null> {
		const rows = await this.ctx.db
			.select()
			.from(providerRequests)
			.where(
				and(
					eq(providerRequests.tenantId, this.ctx.tenantId),
					eq(providerRequests.orderId, orderId),
					inArray(providerRequests.status, statuses),
				),
			)
			.orderBy(desc(providerRequests.updatedAt), desc(providerRequests.id))
			.limit(1);
		return (rows[0] as ProviderRequestRow | undefined) ?? null;
	}

	private async requireProviderRequest(
		orderId: number,
		statuses: Array<ProviderRequestRow["status"]>,
	): Promise<ProviderRequestRow> {
		const request = await this.latestProviderRequestForOrder(orderId, statuses);
		if (!request) throw new Error(`provider request not found for order: ${orderId}`);
		return request;
	}

	private async requireOrder(orderId: number): Promise<ServiceOrderRow> {
		const order = await this.relay.orderById(orderId);
		if (!order) throw new Error(`service order not found: ${orderId}`);
		return order;
	}

	private async updateOrderPaymentState(opts: {
		orderId: number;
		status: ServiceOrderRow["status"];
		paymentStatus: ServiceOrderRow["paymentStatus"];
		nowEpoch: number;
		paymentProvider?: string | null;
		paymentRef?: string | null;
	}): Promise<ServiceOrderRow> {
		const [row] = await this.ctx.db
			.update(serviceOrders)
			.set({
				status: opts.status,
				paymentStatus: opts.paymentStatus,
				updatedAt: opts.nowEpoch,
				...(opts.paymentProvider !== undefined
					? { paymentProvider: opts.paymentProvider }
					: {}),
				...(opts.paymentRef !== undefined ? { paymentRef: opts.paymentRef } : {}),
			})
			.where(
				and(
					eq(serviceOrders.id, opts.orderId),
					eq(serviceOrders.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!row) throw new Error("service_orders.payment_state returned no row");
		return row as ServiceOrderRow;
	}

	private async latestEventData(
		providerRequestId: number,
		eventType: string,
	): Promise<Record<string, unknown>> {
		const [event] = await this.ctx.db
			.select({ dataJson: orderEvents.dataJson })
			.from(orderEvents)
			.where(
				and(
					eq(orderEvents.tenantId, this.ctx.tenantId),
					eq(orderEvents.providerRequestId, providerRequestId),
					eq(orderEvents.eventType, eventType),
				),
			)
			.orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
			.limit(1);
		return parseJsonObject(event?.dataJson ?? "{}");
	}

	private async appendOrderEventOnce(opts: {
		orderId: number;
		eventType: string;
		nowEpoch: number;
		actorType?: "system" | "customer" | "provider" | "operator" | "payment";
		providerRequestId?: number | null;
		conversationId?: number | null;
		messageId?: number | null;
		data?: Record<string, unknown>;
	}): Promise<OrderEventRow | null> {
		const providerRequestId = opts.providerRequestId;
		const providerRequestFilter =
			providerRequestId === undefined
				? []
				: providerRequestId === null
					? [isNull(orderEvents.providerRequestId)]
					: [eq(orderEvents.providerRequestId, providerRequestId)];
		const [existing] = await this.ctx.db
			.select({ id: orderEvents.id })
			.from(orderEvents)
			.where(
				and(
					eq(orderEvents.tenantId, this.ctx.tenantId),
					eq(orderEvents.orderId, opts.orderId),
					eq(orderEvents.eventType, opts.eventType),
					...providerRequestFilter,
				),
			)
			.limit(1);
		if (existing) return null;
		return this.relay.appendEvent(opts);
	}

	private async resolveContactChannelIdentity(opts: {
		contactId: number;
		channelId?: number;
		preferredKinds: ChannelKind[];
	}): Promise<ChannelIdentity | null> {
		const rows = await this.ctx.db
			.select({
				channelDbId: channelIdentities.channelId,
				channelKind: channels.kind,
				channelExternalId: channels.externalId,
				externalUserId: channelIdentities.externalUserId,
			})
			.from(channelIdentities)
			.innerJoin(
				channels,
				and(
					eq(channels.id, channelIdentities.channelId),
					eq(channels.tenantId, this.ctx.tenantId),
					eq(channels.status, "active"),
				),
			)
			.where(
				and(
					eq(channelIdentities.contactId, opts.contactId),
					...(opts.channelId ? [eq(channelIdentities.channelId, opts.channelId)] : []),
					inArray(channels.kind, opts.preferredKinds),
				),
			);
		if (rows.length === 0) return null;

		const sorted = rows.sort(
			(a, b) =>
				opts.preferredKinds.indexOf(a.channelKind as ChannelKind) -
				opts.preferredKinds.indexOf(b.channelKind as ChannelKind),
		);
		const identity = sorted[0];
		if (!identity) return null;
		return {
			channelDbId: identity.channelDbId,
			channelKind: identity.channelKind as ChannelKind,
			channelExternalId: identity.channelExternalId,
			externalUserId: identity.externalUserId,
		};
	}

	private async resolveProviderChannelIdentity(opts: {
		providerRequest: ProviderRequestRow;
		channelId?: number;
	}): Promise<ChannelIdentity | null> {
		if (!opts.providerRequest.providerId) return null;
		const rows = await this.ctx.db
			.select({
				channelDbId: channelIdentities.channelId,
				channelKind: channels.kind,
				channelExternalId: channels.externalId,
				externalUserId: channelIdentities.externalUserId,
			})
			.from(providerProfiles)
			.innerJoin(
				channelIdentities,
				eq(channelIdentities.contactId, providerProfiles.contactId),
			)
			.innerJoin(
				channels,
				and(
					eq(channels.id, channelIdentities.channelId),
					eq(channels.tenantId, this.ctx.tenantId),
					eq(channels.status, "active"),
				),
			)
			.where(
				and(
					eq(providerProfiles.tenantId, this.ctx.tenantId),
					eq(providerProfiles.id, opts.providerRequest.providerId),
					...(opts.channelId
						? [eq(channelIdentities.channelId, opts.channelId)]
						: opts.providerRequest.channelId
							? [eq(channelIdentities.channelId, opts.providerRequest.channelId)]
							: []),
					inArray(channels.kind, defaultProviderChannelKinds),
				),
			);
		if (rows.length === 0) return null;

		const sorted = rows.sort(
			(a, b) =>
				defaultProviderChannelKinds.indexOf(a.channelKind as ChannelKind) -
				defaultProviderChannelKinds.indexOf(b.channelKind as ChannelKind),
		);
		const identity = sorted[0];
		if (!identity) return null;
		return {
			channelDbId: identity.channelDbId,
			channelKind: identity.channelKind as ChannelKind,
			channelExternalId: identity.channelExternalId,
			externalUserId: identity.externalUserId,
		};
	}
}

export function renderCustomerOffer(input: {
	order: ServiceOrderRow;
	providerRequest: ProviderRequestRow;
	serviceArea?: string | null;
	availabilityText?: string | null;
	customerAmount: number;
	currency: string;
	paymentInstructions?: string | null;
}): string {
	return [
		"Провайдер подтвердил вариант по вашему запросу.",
		`Услуга: ${humanize(input.order.requestType)}`,
		input.serviceArea ? `Район: ${input.serviceArea}` : null,
		input.availabilityText ? `Время: ${input.availabilityText}` : null,
		input.order.summary ? `Детали: ${input.order.summary}` : null,
		`Стоимость: ${formatMoney(input.customerAmount, input.currency)}`,
		input.paymentInstructions ? `Оплата: ${input.paymentInstructions}` : null,
		"Если подходит, ответьте «подтверждаю», и я подготовлю оплату.",
	]
		.filter(Boolean)
		.join("\n");
}

export function renderProviderConfirmation(input: {
	order: ServiceOrderRow;
	providerRequest: ProviderRequestRow;
}): string {
	const amount = input.providerRequest.quotedAmount ?? input.order.quotedAmount;
	return [
		`Customer confirmed and paid for order #${input.order.id}.`,
		`Service: ${humanize(input.order.requestType)}`,
		input.order.summary ? `Details: ${input.order.summary}` : null,
		amount !== null
			? `Provider amount: ${formatMoney(amount, input.providerRequest.currency)}`
			: null,
		"Please confirm the booking details and fulfillment time.",
	]
		.filter(Boolean)
		.join("\n");
}

export function formatCustomerOrderContext(
	orders: ServiceOrderRow[],
): string | null {
	if (orders.length === 0) return null;
	return [
		"BROKERED ORDER CONTEXT",
		"Use this as factual order state. Do not invent provider availability, payment references, or confirmations.",
		...orders.map((order) => {
			const metadata = parseJsonObject(order.metadataJson);
			const area = readStringFromObject(metadata, [
				"serviceArea",
				"service_area",
				"area",
				"location",
			]);
			const amount = order.customerAmount ?? order.quotedAmount;
			return [
				`- order #${order.id}`,
				`service=${order.requestType}`,
				`status=${order.status}`,
				area ? `area=${area}` : null,
				amount !== null ? `amount=${formatMoney(amount, order.currency)}` : null,
				`payment=${order.paymentStatus}`,
				order.summary ? `summary=${JSON.stringify(order.summary)}` : null,
			]
				.filter(Boolean)
				.join(" ");
		}),
	].join("\n");
}

function humanize(value: string): string {
	return value.replace(/[_-]+/g, " ").trim();
}

function formatMoney(amount: number, currency: string): string {
	const formatted = amount.toLocaleString("en-US", {
		maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
		minimumFractionDigits: 0,
	});
	return `${formatted} ${currency}`;
}

function readString(metadataJson: string, keys: string[]): string | null {
	return readStringFromObject(parseJsonObject(metadataJson), keys);
}

function readStringFromObject(
	value: Record<string, unknown>,
	keys: string[],
): string | null {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return null;
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
