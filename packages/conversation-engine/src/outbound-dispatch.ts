import type { OutboundEnvelope } from "@chatman-media/channel-core";
import type { OutboundQueueRepo, OutboundQueueRow } from "./dal/index.ts";

export const WHATSAPP_FREE_FORM_WINDOW_SEC = 24 * 60 * 60;

export function withWhatsAppFreeFormWindow(
	envelope: OutboundEnvelope,
	opts: {
		channelKind: string;
		nowEpoch: number;
		windowSec?: number;
	},
): OutboundEnvelope {
	if (opts.channelKind !== "whatsapp") return envelope;
	if (envelope.channelMeta?.whatsapp?.template) return envelope;

	const freeFormAllowedUntil =
		opts.nowEpoch + (opts.windowSec ?? WHATSAPP_FREE_FORM_WINDOW_SEC);
	const existingUntil = envelope.channelMeta?.whatsapp?.freeFormAllowedUntil;
	return {
		...envelope,
		channelMeta: {
			...envelope.channelMeta,
			whatsapp: {
				...envelope.channelMeta?.whatsapp,
				freeFormAllowedUntil:
					existingUntil !== undefined
						? Math.max(existingUntil, freeFormAllowedUntil)
						: freeFormAllowedUntil,
			},
		},
	};
}

/**
 * Поставить envelope в outbound_queue. Worker'у дальше pop'ить
 * pending записи и слать через ChannelAdapter.send().
 *
 * `idempotencyKey` на envelope защищает от дублей при retry processInbound'а.
 * Рекомендованный формат ключа — `${channelId}:${externalUserId}:${reasonHash}`.
 */
export async function dispatchOutbound(opts: {
	channelDbId: number;
	conversationId: number | null;
	envelope: OutboundEnvelope;
	outbound: OutboundQueueRepo;
	nowEpoch: number;
}): Promise<OutboundQueueRow> {
	return opts.outbound.enqueue({
		channelId: opts.channelDbId,
		conversationId: opts.conversationId,
		envelope: opts.envelope,
		nowEpoch: opts.nowEpoch,
	});
}
