import type { Inbound, InboundPart } from "@chatman-media/channel-core";
import {
	channelIdentities,
	providerProfiles,
	providerRequests,
	serviceOrders,
} from "@chatman-media/storage";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
	type OrderEventRow,
	ProviderRelayRepo,
	type ProviderRequestRow,
	type ServiceOrderRow,
} from "./dal/provider-relay.ts";
import type { RepoCtx } from "./dal/types.ts";

const openProviderRequestStatuses = ["sent", "seen"] as const;
const openServiceOrderStatuses = ["matching", "awaiting_provider"] as const;

export interface ProviderResponseHandlerInput {
	inbound: Inbound;
	channelDbId?: number;
	providerConversationId?: number | null;
	messageId?: number | null;
	nowEpoch?: number;
}

export type ProviderResponseParse =
	| {
			kind: "quote";
			quotedAmount: number;
			responseText: string;
			availabilityText: string | null;
	  }
	| {
			kind: "decline";
			responseText: string | null;
			availabilityText: string | null;
	  }
	| {
			kind: "ambiguous";
			responseText: string | null;
			availabilityText: string | null;
	  };

export type ProviderResponseHandleResult =
	| {
			ok: true;
			action: "quoted" | "declined" | "ambiguous";
			parse: ProviderResponseParse;
			order: ServiceOrderRow;
			providerRequest: ProviderRequestRow;
			event?: OrderEventRow;
	  }
	| {
			ok: false;
			reason: "invalid_channel_id" | "provider_request_not_found";
			parse: ProviderResponseParse;
	  };

export interface ProviderResponseMediaPart {
	kind: Exclude<InboundPart["kind"], "text" | "callback_query">;
	mediaRef: {
		channelId: string;
		externalRef: string;
	};
	caption?: string;
	durationSec?: number;
	mimeType?: string;
	fileName?: string;
}

interface MatchedProviderRequest {
	order: ServiceOrderRow;
	providerRequest: ProviderRequestRow;
}

export class ProviderResponseHandler {
	private readonly relay: ProviderRelayRepo;

	constructor(private readonly ctx: RepoCtx) {
		this.relay = new ProviderRelayRepo(ctx);
	}

	async handleProviderResponse(
		input: ProviderResponseHandlerInput,
	): Promise<ProviderResponseHandleResult> {
		const parse = parseProviderResponse(input.inbound.parts);
		const channelDbId =
			input.channelDbId ?? parsePositiveInt(input.inbound.channelId);
		if (!channelDbId) return { ok: false, reason: "invalid_channel_id", parse };

		const match = await this.findOpenProviderRequest({
			channelDbId,
			externalUserId: input.inbound.externalUserId,
		});
		if (!match) {
			return { ok: false, reason: "provider_request_not_found", parse };
		}

		const nowEpoch = input.nowEpoch ?? input.inbound.receivedAt;
		const providerRequest = await this.attachProviderConversationIfKnown({
			providerRequest: match.providerRequest,
			providerConversationId: input.providerConversationId,
			nowEpoch,
		});
		const responseData = buildProviderResponseEventData({
			inbound: input.inbound,
			channelDbId,
			parse,
		});

		if (parse.kind === "quote") {
			const updatedRequest = await this.relay.recordProviderQuote({
				providerRequestId: providerRequest.id,
				quotedAmount: parse.quotedAmount,
				responseText: parse.responseText,
				nowEpoch,
				data: responseData,
			});
			const order = await this.requireOrder(updatedRequest.orderId);
			return {
				ok: true,
				action: "quoted",
				parse,
				order,
				providerRequest: updatedRequest,
			};
		}

		if (parse.kind === "decline") {
			const updatedRequest = await this.relay.recordProviderDecline({
				providerRequestId: providerRequest.id,
				responseText: parse.responseText,
				nowEpoch,
				data: responseData,
			});
			const order = await this.requireOrder(updatedRequest.orderId);
			return {
				ok: true,
				action: "declined",
				parse,
				order,
				providerRequest: updatedRequest,
			};
		}

		const event = await this.relay.appendEvent({
			orderId: providerRequest.orderId,
			providerRequestId: providerRequest.id,
			conversationId: input.providerConversationId,
			messageId: input.messageId,
			actorType: "provider",
			eventType: "provider_response_ambiguous",
			data: {
				...responseData,
				operatorAction: "review_provider_response",
			},
			nowEpoch,
		});
		const order = await this.requireOrder(providerRequest.orderId);
		return {
			ok: true,
			action: "ambiguous",
			parse,
			order,
			providerRequest,
			event,
		};
	}

	private async findOpenProviderRequest(opts: {
		channelDbId: number;
		externalUserId: string;
	}): Promise<MatchedProviderRequest | null> {
		const [row] = await this.ctx.db
			.select({
				order: serviceOrders,
				providerRequest: providerRequests,
			})
			.from(providerProfiles)
			.innerJoin(
				channelIdentities,
				and(
					eq(channelIdentities.contactId, providerProfiles.contactId),
					eq(channelIdentities.channelId, opts.channelDbId),
					eq(channelIdentities.externalUserId, opts.externalUserId),
				),
			)
			.innerJoin(
				providerRequests,
				and(
					eq(providerRequests.tenantId, this.ctx.tenantId),
					eq(providerRequests.providerId, providerProfiles.id),
					eq(providerRequests.channelId, opts.channelDbId),
					inArray(providerRequests.status, openProviderRequestStatuses),
				),
			)
			.innerJoin(
				serviceOrders,
				and(
					eq(serviceOrders.tenantId, this.ctx.tenantId),
					eq(serviceOrders.id, providerRequests.orderId),
					inArray(serviceOrders.status, openServiceOrderStatuses),
				),
			)
			.where(eq(providerProfiles.tenantId, this.ctx.tenantId))
			.orderBy(desc(providerRequests.createdAt), desc(providerRequests.id))
			.limit(1);

		if (!row) return null;
		return {
			order: row.order as ServiceOrderRow,
			providerRequest: row.providerRequest as ProviderRequestRow,
		};
	}

	private async attachProviderConversationIfKnown(opts: {
		providerRequest: ProviderRequestRow;
		providerConversationId?: number | null;
		nowEpoch: number;
	}): Promise<ProviderRequestRow> {
		if (
			opts.providerConversationId === undefined ||
			opts.providerConversationId === opts.providerRequest.providerConversationId
		) {
			return opts.providerRequest;
		}

		const [row] = await this.ctx.db
			.update(providerRequests)
			.set({
				providerConversationId: opts.providerConversationId,
				updatedAt: opts.nowEpoch,
			})
			.where(
				and(
					eq(providerRequests.id, opts.providerRequest.id),
					eq(providerRequests.tenantId, this.ctx.tenantId),
				),
			)
			.returning();
		if (!row) {
			throw new Error("provider_requests.attach_conversation returned no row");
		}
		return row as ProviderRequestRow;
	}

	private async requireOrder(orderId: number): Promise<ServiceOrderRow> {
		const order = await this.relay.orderById(orderId);
		if (!order) throw new Error(`service order not found: ${orderId}`);
		return order;
	}
}

export function parseProviderResponse(
	parts: InboundPart[],
): ProviderResponseParse {
	const text = extractProviderResponseText(parts);
	const availabilityText = extractAvailabilityText(text);
	const quotedAmount = extractQuotedAmount(text);
	if (quotedAmount !== null) {
		return {
			kind: "quote",
			quotedAmount,
			responseText: text,
			availabilityText,
		};
	}
	if (isDecline(text)) {
		return {
			kind: "decline",
			responseText: text || null,
			availabilityText,
		};
	}
	return {
		kind: "ambiguous",
		responseText: text || null,
		availabilityText,
	};
}

export function extractProviderResponseText(parts: InboundPart[]): string {
	const fragments: string[] = [];
	for (const part of parts) {
		if (part.kind === "text") fragments.push(part.text);
		if (
			(part.kind === "photo" || part.kind === "video") &&
			typeof part.caption === "string"
		) {
			fragments.push(part.caption);
		}
		if (part.kind === "callback_query") fragments.push(part.data);
	}
	return fragments.map((fragment) => fragment.trim()).filter(Boolean).join("\n");
}

function buildProviderResponseEventData(opts: {
	inbound: Inbound;
	channelDbId: number;
	parse: ProviderResponseParse;
}): Record<string, unknown> {
	const mediaParts = extractProviderResponseMediaParts(opts.inbound.parts);
	return {
		source: "provider_inbound",
		parseKind: opts.parse.kind,
		externalMessageId: opts.inbound.externalMessageId,
		channelId: opts.channelDbId,
		externalUserId: opts.inbound.externalUserId,
		receivedAt: opts.inbound.receivedAt,
		responseText: opts.parse.responseText,
		availabilityText: opts.parse.availabilityText,
		...(mediaParts.length > 0 ? { mediaParts } : {}),
	};
}

export function extractProviderResponseMediaParts(
	parts: InboundPart[],
): ProviderResponseMediaPart[] {
	const media: ProviderResponseMediaPart[] = [];
	for (const part of parts) {
		switch (part.kind) {
			case "photo":
			case "video":
				media.push({
					kind: part.kind,
					mediaRef: part.mediaRef,
					...(part.caption ? { caption: part.caption } : {}),
				});
				break;
			case "voice":
			case "video_note":
				media.push({
					kind: part.kind,
					mediaRef: part.mediaRef,
					...(part.durationSec !== undefined
						? { durationSec: part.durationSec }
						: {}),
				});
				break;
			case "document":
				media.push({
					kind: "document",
					mediaRef: part.mediaRef,
					...(part.mimeType ? { mimeType: part.mimeType } : {}),
					...(part.fileName ? { fileName: part.fileName } : {}),
				});
				break;
			case "callback_query":
			case "text":
				break;
		}
	}
	return media;
}

function parsePositiveInt(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractQuotedAmount(text: string): number | null {
	const patterns = [
		/(?:฿|\$|thb|baht|บาท|usd)\s*([0-9][0-9\s,.]{0,12})/i,
		/([0-9][0-9\s,.]{0,12})\s*(?:฿|\$|thb|baht|บาท|usd|b\b)/i,
		/(?:price|cost|rate|quote|цена|стоимость|прайс)\D{0,16}([0-9][0-9\s,.]{0,12})/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const rawAmount = match?.[1];
		if (!rawAmount) continue;
		const amount = parseAmount(rawAmount);
		if (amount !== null) return amount;
	}
	return null;
}

function parseAmount(rawAmount: string): number | null {
	const compact = rawAmount.trim().replace(/\s+/g, "");
	if (!compact || compact.includes(":")) return null;

	let normalized = compact;
	if (compact.includes(",") && compact.includes(".")) {
		normalized = compact.replace(/,/g, "");
	} else if (/,\d{1,2}$/.test(compact)) {
		normalized = compact.replace(",", ".");
	} else if (/\.\d{3}$/.test(compact)) {
		normalized = compact.replace(/\./g, "");
	} else {
		normalized = compact.replace(/,/g, "");
	}
	if ((normalized.match(/\./g) ?? []).length > 1) {
		normalized = normalized.replace(/\./g, "");
	}

	const amount = Number(normalized);
	if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
		return null;
	}
	return Math.round(amount * 100) / 100;
}

function extractAvailabilityText(text: string): string | null {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return null;

	const time = normalized.match(/\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/)?.[0];
	const day = normalized.match(
		/\b(today|tomorrow|tonight|сегодня|завтра|вечером)\b/i,
	)?.[0];
	if (day && time) return `${day} ${time}`;
	if (time) return time;
	if (day) return day;

	const availability = normalized.match(
		/\b(available|can do|slot|free|доступн\w*|свободн\w*)\b[^.!?\n]{0,80}/i,
	)?.[0];
	return availability?.trim() ?? null;
}

function isDecline(text: string): boolean {
	if (!text.trim()) return false;
	return [
		/\b(no|not available|unavailable|fully booked|booked out|sold out)\b/i,
		/\b(can't|cannot|cant|decline|pass|no slots?)\b/i,
		/(нет мест|мест нет|не можем|не могу|занят[аы]?|заняты|не получится|отказ)/i,
		/(ไม่ว่าง|ไม่ได้|เต็ม)/i,
	].some((pattern) => pattern.test(text));
}
