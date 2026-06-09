import { describe, expect, it } from "bun:test";
import { parseCallbackPayload } from "./parser.ts";
import type { VkCallbackPayload } from "./types.ts";

const CH = "vk-1";

describe("parseCallbackPayload (VK)", () => {
	it("parses message_new text", () => {
		const out = parseCallbackPayload(CH, {
			type: "message_new",
			group_id: 123,
			object: {
				message: {
					id: 10,
					date: 1_700_000_000,
					peer_id: 555,
					from_id: 555,
					text: "Привет",
				},
			},
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			channelId: CH,
			externalMessageId: "10",
			externalUserId: "555",
			parts: [{ kind: "text", text: "Привет" }],
			receivedAt: 1_700_000_000,
		});
	});

	it("falls back to conversation_message_id when id is absent", () => {
		const out = parseCallbackPayload(CH, {
			type: "message_new",
			object: {
				message: {
					conversation_message_id: 7,
					date: 1,
					peer_id: 2000000001,
					text: "chat",
				},
			},
		});
		expect(out[0]?.externalMessageId).toBe("cmid:2000000001:7");
		expect(out[0]?.externalUserId).toBe("2000000001");
	});

	it("skips confirmation and non-message events", () => {
		expect(
			parseCallbackPayload(CH, { type: "confirmation", group_id: 1 }),
		).toEqual([]);
		expect(
			parseCallbackPayload(CH, { type: "message_reply", group_id: 1 }),
		).toEqual([]);
	});

	it("skips outbound echo and empty text", () => {
		const echo: VkCallbackPayload = {
			type: "message_new",
			object: { message: { id: 1, peer_id: 1, out: 1, text: "echo" } },
		};
		const empty: VkCallbackPayload = {
			type: "message_new",
			object: { message: { id: 2, peer_id: 1, text: "" } },
		};
		expect(parseCallbackPayload(CH, echo)).toEqual([]);
		expect(parseCallbackPayload(CH, empty)).toEqual([]);
	});

	it("invalid object returns empty", () => {
		expect(
			parseCallbackPayload(CH, { type: "message_new", object: {} }),
		).toEqual([]);
	});
});
