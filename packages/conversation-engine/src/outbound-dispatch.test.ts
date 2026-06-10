import { describe, expect, it } from "bun:test";
import type { OutboundEnvelope } from "@chatman-media/channel-core";
import type { OutboundQueueRepo } from "./dal/index.ts";
import {
	dispatchOutbound,
	withWhatsAppFreeFormWindow,
} from "./outbound-dispatch.ts";

describe("dispatchOutbound", () => {
	it("делегирует OutboundQueueRepo.enqueue с прокинутыми аргументами", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const outbound = {
			enqueue: async (a: Record<string, unknown>) => {
				calls.push(a);
				return { id: 7, ...a };
			},
		} as unknown as OutboundQueueRepo;

		const envelope = { idempotencyKey: "k" } as unknown as OutboundEnvelope;
		const row = await dispatchOutbound({
			channelDbId: 3,
			conversationId: 9,
			envelope,
			outbound,
			nowEpoch: 111,
		});

		expect(row.id).toBe(7);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			channelId: 3,
			conversationId: 9,
			envelope,
			nowEpoch: 111,
		});
	});

	it("проксирует conversationId=null", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const outbound = {
			enqueue: async (a: Record<string, unknown>) => {
				calls.push(a);
				return { id: 1, ...a };
			},
		} as unknown as OutboundQueueRepo;
		await dispatchOutbound({
			channelDbId: 1,
			conversationId: null,
			envelope: {} as unknown as OutboundEnvelope,
			outbound,
			nowEpoch: 0,
		});
		expect(calls[0]?.conversationId).toBeNull();
	});

	it("adds WhatsApp free-form window for inbound replies", () => {
		const envelope: OutboundEnvelope = {
			channelId: "10",
			externalUserId: "66999999999",
			parts: [{ kind: "text", text: "reply" }],
		};
		const result = withWhatsAppFreeFormWindow(envelope, {
			channelKind: "whatsapp",
			nowEpoch: 100,
		});
		expect(result.channelMeta?.whatsapp?.freeFormAllowedUntil).toBe(
			100 + 24 * 60 * 60,
		);
		expect(envelope.channelMeta).toBeUndefined();
	});

	it("does not mutate WhatsApp template envelopes", () => {
		const envelope: OutboundEnvelope = {
			channelId: "10",
			externalUserId: "66999999999",
			parts: [{ kind: "text", text: "fallback" }],
			channelMeta: {
				whatsapp: {
					template: {
						name: "provider_booking_request_v1",
						languageCode: "en_US",
					},
				},
			},
		};
		expect(
			withWhatsAppFreeFormWindow(envelope, {
				channelKind: "whatsapp",
				nowEpoch: 100,
			}),
		).toBe(envelope);
	});
});
