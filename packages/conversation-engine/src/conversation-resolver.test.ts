import { describe, expect, it } from "bun:test";
import { resolveConversation } from "./conversation-resolver.ts";
import type { ConversationsRepo } from "./dal/index.ts";

function repo(existing?: unknown) {
	const created: Array<Record<string, unknown>> = [];
	const conversations = {
		findByContactAndSource: async () => existing,
		findByContactAndChannel: async () => existing,
		create: async (data: Record<string, unknown>) => {
			const c = { id: 100, ...data };
			created.push(c);
			return c;
		},
	} as unknown as ConversationsRepo;
	return { conversations, created };
}

describe("resolveConversation", () => {
	it("существующий диалог → created:false, без создания", async () => {
		const { conversations, created } = repo({ id: 7, source: "bot" });
		const res = await resolveConversation({
			contactId: 1,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 0,
		});
		expect(res.created).toBe(false);
		expect(res.conversation.id).toBe(7);
		expect(created).toHaveLength(0);
	});

	it("нет диалога → создаёт ai-mode с channelId, created:true", async () => {
		const { conversations, created } = repo(undefined);
		const res = await resolveConversation({
			contactId: 1,
			channelId: 11,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 111,
		});
		expect(res.created).toBe(true);
		expect(created[0]).toMatchObject({
			contactId: 1,
			mode: "ai",
			source: "bot",
			channelId: 11,
			nowEpoch: 111,
		});
	});

	it("маппинг kind → source keeps real channel ids distinct", async () => {
		const cases: Array<[string, number, string]> = [
			["telegram_bot", 11, "bot"],
			["telegram_userbot", 12, "userbot"],
			["whatsapp", 13, "bot"],
			["web", 14, "bot"],
			["facebook", 15, "bot"],
			["vk", 16, "bot"],
		];
		for (const [kind, channelId, source] of cases) {
			const { conversations, created } = repo(undefined);
			await resolveConversation({
				contactId: 1,
				channelId,
				channelKind: kind,
				conversations,
				nowEpoch: 0,
			});
			expect(created[0]?.source).toBe(source);
			expect(created[0]?.channelId).toBe(channelId);
		}
	});
});
