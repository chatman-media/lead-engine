import { describe, expect, it } from "bun:test";
import { parseUpdatePayload } from "./parser.ts";
import type { MaxUpdate } from "./types.ts";

const CH = "max-1";

describe("parseUpdatePayload (MAX)", () => {
	it("parses dialog message_created text as user recipient", () => {
		const out = parseUpdatePayload(CH, {
			update_type: "message_created",
			timestamp: 1_700_000_000_000,
			message: {
				sender: { user_id: 555, username: "ivan", is_bot: false },
				recipient: { chat_id: 777, chat_type: "dialog" },
				timestamp: 1_700_000_000_111,
				body: { mid: "mid-1", text: "Привет" },
			},
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			channelId: CH,
			externalMessageId: "mid-1",
			externalUserId: "user:555",
			externalUsername: "ivan",
			parts: [{ kind: "text", text: "Привет" }],
			receivedAt: 1_700_000_000,
		});
	});

	it("parses group chat message_created as chat recipient", () => {
		const out = parseUpdatePayload(CH, {
			update_type: "message_created",
			timestamp: 1,
			message: {
				sender: { user_id: 555, is_bot: false },
				recipient: { chat_id: 999, chat_type: "chat" },
				timestamp: 2,
				body: { mid: "mid-2", text: "chat" },
			},
		});
		expect(out[0]?.externalUserId).toBe("chat:999");
	});

	it("skips non-message, bot echo and empty text", () => {
		expect(
			parseUpdatePayload(CH, {
				update_type: "bot_started",
				timestamp: 1,
			} as MaxUpdate),
		).toEqual([]);
		expect(
			parseUpdatePayload(CH, {
				update_type: "message_created",
				timestamp: 1,
				message: {
					sender: { user_id: 1, is_bot: true },
					recipient: { chat_id: 1, chat_type: "dialog" },
					timestamp: 1,
					body: { mid: "m", text: "echo" },
				},
			}),
		).toEqual([]);
		expect(
			parseUpdatePayload(CH, {
				update_type: "message_created",
				timestamp: 1,
				message: {
					sender: { user_id: 1, is_bot: false },
					recipient: { chat_id: 1, chat_type: "dialog" },
					timestamp: 1,
					body: { mid: "m", text: "" },
				},
			}),
		).toEqual([]);
	});
});
