import type {
	ChannelKind,
	OutboundEnvelope,
	WhatsAppProviderOptInMeta,
	WhatsAppTemplatePayload,
} from "@chatman-media/channel-core";
import {
	channelIdentities,
	channels,
	orderEvents,
	providerProfiles,
} from "@chatman-media/storage";
import { and, eq, inArray } from "drizzle-orm";
import {
	type OrderEventRow,
	OutboundQueueRepo,
	type OutboundQueueRow,
	ProviderRelayRepo,
	type ProviderRequestRow,
	type ServiceOrderRow,
} from "./dal/index.ts";
import type { RepoCtx } from "./dal/types.ts";
import {
	type ProviderRouteCandidate,
	ProviderRouter,
	type ProviderRoutingFailureReason,
} from "./provider-routing.ts";

const defaultProviderChannelKinds: ChannelKind[] = [
	"whatsapp",
	"telegram_bot",
	"telegram_userbot",
	"web",
	"facebook",
	"vk",
];
const providerOutreachOptInCategory = "provider_outreach";
const defaultWhatsAppProviderTemplateName = "provider_booking_request_v1";
const defaultWhatsAppProviderTemplateLanguage = "en_US";

export type ProviderRelayStartFailureReason =
	| "routing_failed"
	| "provider_channel_missing"
	| "provider_opt_in_missing";

export interface ProviderChannelIdentity {
	channelDbId: number;
	channelKind: ChannelKind;
	channelExternalId: string;
	externalUserId: string;
	providerOptIn: WhatsAppProviderOptInMeta | null;
}

export interface ProviderRelayStartInput {
	customerContactId: number;
	requestType: string;
	nowEpoch: number;
	serviceArea?: string | null;
	summary?: string | null;
	customerConversationId?: number | null;
	leadId?: number | null;
	providerIdOverride?: number | null;
	preferredChannelKinds?: ChannelKind[];
	orderIdempotencyKey?: string | null;
	providerRequestIdempotencyKey?: string | null;
	outboundIdempotencyKey?: string | null;
	messageText?: string | null;
	whatsAppTemplateName?: string | null;
	whatsAppTemplateLanguageCode?: string | null;
	metadata?: Record<string, unknown>;
}

export type ProviderRelayStartResult =
	| {
			ok: true;
			order: ServiceOrderRow;
			providerRequest: ProviderRequestRow;
			outbound: OutboundQueueRow;
			envelope: OutboundEnvelope;
			candidate: ProviderRouteCandidate;
			identity: ProviderChannelIdentity;
	  }
	| {
			ok: false;
			reason: ProviderRelayStartFailureReason;
			order: ServiceOrderRow;
			routingReason?: ProviderRoutingFailureReason;
			providerId?: number;
	  };

export class ProviderRelayOrchestrator {
	private readonly relay: ProviderRelayRepo;
	private readonly router: ProviderRouter;
	private readonly outbound: OutboundQueueRepo;

	constructor(private readonly ctx: RepoCtx) {
		this.relay = new ProviderRelayRepo(ctx);
		this.router = new ProviderRouter(ctx);
		this.outbound = new OutboundQueueRepo(ctx);
	}

	async startProviderOutreach(
		input: ProviderRelayStartInput,
	): Promise<ProviderRelayStartResult> {
		const order = await this.relay.createServiceOrder({
			customerContactId: input.customerContactId,
			customerConversationId: input.customerConversationId,
			leadId: input.leadId,
			requestType: input.requestType,
			status: "matching",
			summary: input.summary ?? null,
			idempotencyKey: input.orderIdempotencyKey ?? null,
			metadata:
				input.metadata || input.serviceArea
					? {
							...(input.metadata ?? {}),
							...(input.serviceArea ? { serviceArea: input.serviceArea } : {}),
						}
					: undefined,
			nowEpoch: input.nowEpoch,
		});

		const route = await this.router.selectProvider({
			serviceType: input.requestType,
			serviceArea: input.serviceArea,
			providerIdOverride: input.providerIdOverride,
		});
		if (!route.ok) {
			await this.relay.appendEvent({
				orderId: order.id,
				actorType: "system",
				eventType: "provider_route_failed",
				data: {
					reason: route.reason,
					...(route.details ? { details: route.details } : {}),
				},
				nowEpoch: input.nowEpoch,
			});
			return {
				ok: false,
				reason: "routing_failed",
				routingReason: route.reason,
				order,
			};
		}

		const identity = await this.resolveProviderChannelIdentity({
			providerId: route.candidate.providerId,
			preferredKinds:
				input.preferredChannelKinds && input.preferredChannelKinds.length > 0
					? input.preferredChannelKinds
					: defaultProviderChannelKinds,
		});
		if (!identity) {
			await this.relay.appendEvent({
				orderId: order.id,
				actorType: "system",
				eventType: "provider_request_failed",
				data: {
					reason: "provider_channel_missing",
					providerId: route.candidate.providerId,
				},
				nowEpoch: input.nowEpoch,
			});
			return {
				ok: false,
				reason: "provider_channel_missing",
				order,
				providerId: route.candidate.providerId,
			};
		}
		if (
			identity.channelKind === "whatsapp" &&
			!hasProviderOutreachOptIn(identity.providerOptIn)
		) {
			await this.relay.appendEvent({
				orderId: order.id,
				actorType: "system",
				eventType: "provider_request_failed",
				data: {
					reason: "provider_opt_in_missing",
					providerId: route.candidate.providerId,
					channelId: identity.channelDbId,
				},
				nowEpoch: input.nowEpoch,
			});
			return {
				ok: false,
				reason: "provider_opt_in_missing",
				order,
				providerId: route.candidate.providerId,
			};
		}

		const outboundKey =
			input.outboundIdempotencyKey ??
			`provider-relay:${order.id}:${route.candidate.providerId}:${identity.channelDbId}:initial`;
		const providerMessage =
			input.messageText ??
			this.defaultProviderMessage({
				requestType: input.requestType,
				serviceArea: input.serviceArea,
				summary: input.summary,
			});
		const whatsappTemplate =
			identity.channelKind === "whatsapp"
				? this.defaultProviderWhatsAppTemplate({
						requestType: input.requestType,
						serviceArea: input.serviceArea,
						summary: input.summary,
						templateName:
							input.whatsAppTemplateName ?? defaultWhatsAppProviderTemplateName,
						languageCode:
							input.whatsAppTemplateLanguageCode ??
							defaultWhatsAppProviderTemplateLanguage,
					})
				: null;
		const envelope: OutboundEnvelope = {
			channelId: String(identity.channelDbId),
			externalUserId: identity.externalUserId,
			parts: [
				{
					kind: "text",
					text: providerMessage,
				},
			],
			...(whatsappTemplate
				? {
						channelMeta: {
							whatsapp: {
								template: whatsappTemplate,
								orderId: order.id,
								providerOptIn: identity.providerOptIn ?? undefined,
							},
						},
					}
				: {}),
			idempotencyKey: outboundKey,
		};

		const outbound = await this.outbound.enqueue({
			channelId: identity.channelDbId,
			conversationId: null,
			envelope,
			nowEpoch: input.nowEpoch,
		});
		const providerRequest = await this.relay.addProviderRequest({
			orderId: order.id,
			providerId: route.candidate.providerId,
			channelId: identity.channelDbId,
			outboundQueueId: outbound.id,
			status: "sent",
			commissionPct: route.candidate.commissionPct,
			idempotencyKey:
				input.providerRequestIdempotencyKey ??
				`provider-request:${order.id}:${route.candidate.providerId}`,
			metadata: {
				providerServiceId: route.candidate.providerServiceId,
				override: route.override,
				...(whatsappTemplate
					? {
							whatsappTemplate: {
								name: whatsappTemplate.name,
								languageCode: whatsappTemplate.languageCode,
								category: whatsappTemplate.category,
							},
						}
					: {}),
			},
			nowEpoch: input.nowEpoch,
		});

		await this.appendProviderRequestEventOnce({
			orderId: order.id,
			providerRequestId: providerRequest.id,
			eventType: "provider_request_sent",
			data: {
				outboundQueueId: outbound.id,
				channelId: identity.channelDbId,
				channelKind: identity.channelKind,
			},
			nowEpoch: input.nowEpoch,
		});

		const updatedOrder = await this.relay.orderById(order.id);
		return {
			ok: true,
			order: updatedOrder ?? order,
			providerRequest,
			outbound,
			envelope,
			candidate: route.candidate,
			identity,
		};
	}

	async recordDispatchRetry(opts: {
		providerRequestId: number;
		nowEpoch: number;
		error?: string | null;
		outboundQueueId?: number | null;
	}): Promise<OrderEventRow> {
		const request = await this.requireProviderRequest(opts.providerRequestId);
		if (request.status !== "failed") {
			await this.relay.transitionProviderRequestStatus(
				request.id,
				"failed",
				opts.nowEpoch,
			);
		}
		return this.relay.appendEvent({
			orderId: request.orderId,
			providerRequestId: request.id,
			actorType: "system",
			eventType: "provider_request_retry",
			data: {
				error: opts.error ?? null,
				outboundQueueId: opts.outboundQueueId ?? request.outboundQueueId,
			},
			nowEpoch: opts.nowEpoch,
		});
	}

	async recordDispatchFailed(opts: {
		providerRequestId: number;
		error: string;
		nowEpoch: number;
		outboundQueueId?: number | null;
	}): Promise<OrderEventRow> {
		const request = await this.requireProviderRequest(opts.providerRequestId);
		return this.relay.appendEvent({
			orderId: request.orderId,
			providerRequestId: request.id,
			actorType: "system",
			eventType: "provider_request_send_failed",
			data: {
				error: opts.error,
				outboundQueueId: opts.outboundQueueId ?? request.outboundQueueId,
			},
			nowEpoch: opts.nowEpoch,
		});
	}

	async cancelProviderOutreach(opts: {
		providerRequestId: number;
		reason?: string | null;
		nowEpoch: number;
	}): Promise<ProviderRequestRow> {
		const request = await this.relay.transitionProviderRequestStatus(
			opts.providerRequestId,
			"cancelled",
			opts.nowEpoch,
		);
		await this.relay.appendEvent({
			orderId: request.orderId,
			providerRequestId: request.id,
			actorType: "system",
			eventType: "provider_request_cancelled",
			data: { reason: opts.reason ?? null },
			nowEpoch: opts.nowEpoch,
		});
		return request;
	}

	private async requireProviderRequest(
		providerRequestId: number,
	): Promise<ProviderRequestRow> {
		const request = await this.relay.providerRequestById(providerRequestId);
		if (!request) {
			throw new Error(`provider request not found: ${providerRequestId}`);
		}
		return request;
	}

	private async appendProviderRequestEventOnce(opts: {
		orderId: number;
		providerRequestId: number;
		eventType: string;
		nowEpoch: number;
		data?: Record<string, unknown>;
	}): Promise<OrderEventRow | null> {
		const [existing] = await this.ctx.db
			.select({ id: orderEvents.id })
			.from(orderEvents)
			.where(
				and(
					eq(orderEvents.tenantId, this.ctx.tenantId),
					eq(orderEvents.providerRequestId, opts.providerRequestId),
					eq(orderEvents.eventType, opts.eventType),
				),
			)
			.limit(1);
		if (existing) return null;
		return this.relay.appendEvent({
			orderId: opts.orderId,
			providerRequestId: opts.providerRequestId,
			actorType: "system",
			eventType: opts.eventType,
			data: opts.data,
			nowEpoch: opts.nowEpoch,
		});
	}

	private async resolveProviderChannelIdentity(opts: {
		providerId: number;
		preferredKinds: ChannelKind[];
	}): Promise<ProviderChannelIdentity | null> {
		const rows = await this.ctx.db
			.select({
				channelDbId: channelIdentities.channelId,
				channelKind: channels.kind,
				channelExternalId: channels.externalId,
				externalUserId: channelIdentities.externalUserId,
				optInSource: providerProfiles.optInSource,
				optInAt: providerProfiles.optInAt,
				optInCategoriesJson: providerProfiles.optInCategoriesJson,
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
					eq(providerProfiles.id, opts.providerId),
					inArray(channels.kind, opts.preferredKinds),
				),
			);

		const sorted = rows.sort(
			(a, b) =>
				opts.preferredKinds.indexOf(a.channelKind as ChannelKind) -
				opts.preferredKinds.indexOf(b.channelKind as ChannelKind),
		);
		const row = sorted[0];
		if (!row) return null;
		return {
			channelDbId: row.channelDbId,
			channelKind: row.channelKind as ChannelKind,
			channelExternalId: row.channelExternalId,
			externalUserId: row.externalUserId,
			providerOptIn: parseProviderOptIn({
				source: row.optInSource,
				timestamp: row.optInAt,
				categoriesJson: row.optInCategoriesJson,
			}),
		};
	}

	private defaultProviderWhatsAppTemplate(input: {
		requestType: string;
		serviceArea?: string | null;
		summary?: string | null;
		templateName: string;
		languageCode: string;
	}): WhatsAppTemplatePayload {
		return {
			name: input.templateName,
			languageCode: input.languageCode,
			category: "utility",
			components: [
				{
					type: "body",
					parameters: [
						{ type: "text", text: input.requestType },
						{ type: "text", text: input.serviceArea?.trim() || "any area" },
						{ type: "text", text: input.summary?.trim() || "No extra notes" },
					],
				},
			],
		};
	}

	private defaultProviderMessage(input: {
		requestType: string;
		serviceArea?: string | null;
		summary?: string | null;
	}): string {
		const lines = [
			`New ${input.requestType} request.`,
			input.serviceArea ? `Area: ${input.serviceArea}` : null,
			input.summary ? `Details: ${input.summary}` : null,
			"Please reply with availability, price, and any constraints.",
		].filter((line): line is string => Boolean(line));
		return lines.join("\n");
	}
}

function parseProviderOptIn(input: {
	source: string | null;
	timestamp: number | null;
	categoriesJson: string;
}): WhatsAppProviderOptInMeta | null {
	if (!input.source || input.timestamp === null) return null;
	let categories: string[];
	try {
		const parsed = JSON.parse(input.categoriesJson);
		categories = Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		categories = [];
	}
	return {
		source: input.source,
		timestamp: input.timestamp,
		categories,
	};
}

function hasProviderOutreachOptIn(
	optIn: WhatsAppProviderOptInMeta | null,
): boolean {
	return (
		optIn !== null &&
		optIn.timestamp > 0 &&
		optIn.categories.includes(providerOutreachOptInCategory)
	);
}
