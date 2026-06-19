import type {
	Inbound,
	InboundPart,
	OperatorHandoffMeta,
	OutboundEnvelope,
} from "@chatman-media/channel-core";
import type { NotificationService } from "./notifications.ts";
import type { PipelineSink } from "./types.ts";

export interface OperatorHandoffMediaRef {
	kind: Exclude<InboundPart["kind"], "text" | "callback_query">;
	channelId: string;
	externalRef: string;
	caption?: string;
	mimeType?: string;
	fileName?: string;
	durationSec?: number;
}

export interface EmitOperatorHandoffInput {
	tenantId: number;
	conversationId: number;
	contactId: number;
	contactDisplayName?: string | null;
	userMessageText?: string | null;
	inbound?: Pick<Inbound, "parts"> | null;
	envelopes: readonly OutboundEnvelope[];
	operatorHandoffs?: readonly OperatorHandoffMeta[];
	notifications?: NotificationService | null;
	sink?: PipelineSink;
}

function uniqueHandoffs(
	envelopes: readonly OutboundEnvelope[],
	extra: readonly OperatorHandoffMeta[] = [],
): OperatorHandoffMeta[] {
	const seen = new Set<string>();
	const handoffs: OperatorHandoffMeta[] = [];
	for (const handoff of [
		...extra,
		...envelopes
			.map((envelope) => envelope.operatorHandoff)
			.filter((item): item is OperatorHandoffMeta => Boolean(item)),
	]) {
		if (!handoff) continue;
		const key = `${handoff.reason}:${handoff.contractId ?? ""}:${handoff.orderId ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		handoffs.push(handoff);
	}
	return handoffs;
}

export function primaryOperatorHandoff(
	handoffs: readonly OperatorHandoffMeta[] | null | undefined,
): OperatorHandoffMeta | null {
	return uniqueHandoffs([], handoffs ?? [])[0] ?? null;
}

export function collectOperatorHandoffMediaRefs(
	inbound: Pick<Inbound, "parts"> | null | undefined,
): OperatorHandoffMediaRef[] {
	if (!inbound) return [];
	const refs: OperatorHandoffMediaRef[] = [];
	for (const part of inbound.parts) {
		if (part.kind === "text" || part.kind === "callback_query") continue;
		refs.push({
			kind: part.kind,
			channelId: part.mediaRef.channelId,
			externalRef: part.mediaRef.externalRef,
			...("caption" in part && part.caption ? { caption: part.caption } : {}),
			...("mimeType" in part && part.mimeType ? { mimeType: part.mimeType } : {}),
			...("fileName" in part && part.fileName ? { fileName: part.fileName } : {}),
			...("durationSec" in part && part.durationSec ? { durationSec: part.durationSec } : {}),
		});
	}
	return refs;
}

export function formatOperatorHandoffMediaSummary(
	refs: readonly OperatorHandoffMediaRef[],
): string {
	if (refs.length === 0) return "";
	return refs
		.map((ref, index) => {
			const details = [ref.fileName, ref.mimeType, ref.durationSec ? `${ref.durationSec}s` : null]
				.filter(Boolean)
				.join(", ");
			// file_id (channelId:externalRef) — внутренний, оператору не показываем.
			return `${index + 1}. ${ref.kind}${details ? ` (${details})` : ""}`;
		})
		.join("\n");
}

export function operatorMediaNotificationData(
	inbound: Pick<Inbound, "parts"> | null | undefined,
): Record<string, unknown> {
	const refs = collectOperatorHandoffMediaRefs(inbound);
	if (refs.length === 0) return {};
	return {
		mediaCount: refs.length,
		mediaSummary: formatOperatorHandoffMediaSummary(refs),
		mediaRefsJson: JSON.stringify(refs),
	};
}

export async function emitOperatorHandoffNotifications(
	input: EmitOperatorHandoffInput,
): Promise<void> {
	const handoffs = uniqueHandoffs(input.envelopes, input.operatorHandoffs ?? []);
	if (handoffs.length === 0) return;
	const mediaData = operatorMediaNotificationData(input.inbound);

	for (const handoff of handoffs) {
		input.sink?.emit?.({
			type: "conversation-escalated",
			tenantId: input.tenantId,
			conversationId: input.conversationId,
			reason: handoff.reason,
		});

		if (!input.notifications) continue;
		await input.notifications
			.notify({
				tenantId: input.tenantId,
				eventType: "operator_handoff_required",
				conversationId: input.conversationId,
				contactId: input.contactId,
				data: {
					displayName:
						input.contactDisplayName || `Контакт #${input.contactId}`,
					reason: handoff.reason,
					title: handoff.title,
					action: handoff.action,
					contractId: handoff.contractId ?? "",
					orderId: handoff.orderId ?? "",
					stageSlug: handoff.stageSlug ?? "",
					priority: handoff.priority ?? "normal",
					accepted: handoff.accepted ?? "",
					pending: handoff.pending ?? "",
					reviewPath: handoff.reviewPath ?? "",
					context: handoff.context ?? "",
					urgency: handoff.urgency ?? "",
					amount: handoff.amount ?? "",
					rail: handoff.rail ?? "",
					network: handoff.network ?? "",
					...(handoff.payoutPointId != null ? { payoutPointId: handoff.payoutPointId } : {}),
					text: input.userMessageText || "",
					...mediaData,
				},
			})
			.catch((err) => {
				input.sink?.log?.("warn", "operator handoff notification failed", {
					tenantId: input.tenantId,
					conversationId: input.conversationId,
					reason: handoff.reason,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}
}
