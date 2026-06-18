import { describe, expect, it } from "bun:test";
import { resolveConversation } from "./conversation-resolver.ts";
import type { ConversationsRepo } from "./dal/index.ts";

function repo(existing?: unknown | unknown[], assignAdminId?: number | null) {
	const created: Array<Record<string, unknown>> = [];
	const autoAssignCalls: number[] = [];
	const rows = Array.isArray(existing)
		? (existing as Record<string, unknown>[])
		: existing
			? [existing as Record<string, unknown>]
			: [];
	let nextId = 100;
	const conversations = {
		findByContactAndSource: async (contactId: number, source: string) =>
			rows.find(
				(row) =>
					row.userId === contactId &&
					row.source === source &&
					row.channelId === null,
			) ?? null,
		findByContactAndChannel: async (contactId: number, channelId: number) =>
			rows.find(
				(row) => row.userId === contactId && row.channelId === channelId,
			) ?? null,
		create: async (data: Record<string, unknown>) => {
			const c = { id: nextId++, ...data };
			created.push(c);
			rows.push({ userId: data.contactId, ...c });
			return c;
		},
		autoAssignLeastBusyOperator: async (conversationId: number) => {
			autoAssignCalls.push(conversationId);
			return assignAdminId ?? null;
		},
	} as unknown as ConversationsRepo;
	return { conversations, created, autoAssignCalls };
}

describe("resolveConversation", () => {
	it("существующий диалог → created:false, без создания", async () => {
		const { conversations, created } = repo({
			id: 7,
			userId: 1,
			channelId: 10,
			source: "bot",
		});
		const res = await resolveConversation({
			contactId: 1,
			channelId: 10,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 0,
		});
		expect(res.created).toBe(false);
		expect(res.conversation.id).toBe(7);
		expect(created).toHaveLength(0);
	});

	it("нет диалога → создаёт ai-mode, created:true", async () => {
		const { conversations, created } = repo(undefined);
		const res = await resolveConversation({
			contactId: 1,
			channelId: 10,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 111,
		});
		expect(res.created).toBe(true);
		expect(created[0]).toMatchObject({
			contactId: 1,
			channelId: 10,
			mode: "ai",
			source: "bot",
			nowEpoch: 111,
		});
	});

	it("маппинг kind → source", async () => {
		const cases: Array<[string, string]> = [
			["telegram_bot", "bot"],
			["telegram_userbot", "userbot"],
			["whatsapp", "bot"], // fallback
			["web", "bot"], // fallback
		];
		for (const [kind, source] of cases) {
			const { conversations, created } = repo(undefined);
			await resolveConversation({
				contactId: 1,
				channelId: 10,
				channelKind: kind,
				conversations,
				nowEpoch: 0,
			});
			expect(created[0]?.source).toBe(source);
		}
	});

	it("channelId separates non-telegram conversations even when legacy source is bot", async () => {
		const { conversations, created } = repo(undefined);
		const whatsapp = await resolveConversation({
			contactId: 1,
			channelId: 20,
			channelKind: "whatsapp",
			conversations,
			nowEpoch: 10,
		});
		const web = await resolveConversation({
			contactId: 1,
			channelId: 30,
			channelKind: "web",
			conversations,
			nowEpoch: 20,
		});
		const whatsappAgain = await resolveConversation({
			contactId: 1,
			channelId: 20,
			channelKind: "whatsapp",
			conversations,
			nowEpoch: 30,
		});

		expect(whatsapp.created).toBe(true);
		expect(web.created).toBe(true);
		expect(whatsappAgain.created).toBe(false);
		expect(whatsappAgain.conversation.id).toBe(whatsapp.conversation.id);
		expect(web.conversation.id).not.toBe(whatsapp.conversation.id);
		expect(created).toHaveLength(2);
		expect(created.map((row) => row.channelId)).toEqual([20, 30]);
		expect(created.every((row) => row.source === "bot")).toBe(true);
	});

	it("without channelId keeps legacy source lookup", async () => {
		const { conversations, created } = repo({
			id: 7,
			userId: 1,
			channelId: null,
			source: "bot",
		});
		const res = await resolveConversation({
			contactId: 1,
			channelKind: "whatsapp",
			conversations,
			nowEpoch: 0,
		});
		expect(res.created).toBe(false);
		expect(res.conversation.id).toBe(7);
		expect(created).toHaveLength(0);
	});

	it("legacy source lookup ignores channel-specific rows", async () => {
		const { conversations, created } = repo({
			id: 7,
			userId: 1,
			channelId: 20,
			source: "bot",
		});
		const res = await resolveConversation({
			contactId: 1,
			channelKind: "whatsapp",
			conversations,
			nowEpoch: 0,
		});

		expect(res.created).toBe(true);
		expect(res.conversation.id).not.toBe(7);
		expect(created[0]).toMatchObject({
			contactId: 1,
			channelId: null,
			source: "bot",
		});
	});
	it("новый диалог → авто-назначение наименее загруженного оператора (#694)", async () => {
		const { conversations, created } = repo(undefined, 42);
		const res = await resolveConversation({
			contactId: 1,
			channelId: 10,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 5,
		});
		expect(res.created).toBe(true);
		expect(res.conversation.assignedAdminId).toBe(42);
		expect(created).toHaveLength(1);
	});

	it("нет свободных операторов → диалог без назначения", async () => {
		const { conversations } = repo(undefined, null);
		const res = await resolveConversation({
			contactId: 1,
			channelId: 10,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 5,
		});
		expect(res.created).toBe(true);
		expect(res.conversation.assignedAdminId ?? null).toBeNull();
	});

	it("self_play (симуляция) не авто-назначается", async () => {
		const { conversations, autoAssignCalls } = repo(undefined, 42);
		const res = await resolveConversation({
			contactId: 1,
			channelKind: "self_play",
			conversations,
			nowEpoch: 5,
		});
		expect(res.created).toBe(true);
		expect(autoAssignCalls).toHaveLength(0);
		expect(res.conversation.assignedAdminId ?? null).toBeNull();
	});

	it("существующий диалог не триггерит авто-назначение", async () => {
		const { conversations, autoAssignCalls } = repo(
			{ id: 7, userId: 1, channelId: 10, source: "bot" },
			42,
		);
		const res = await resolveConversation({
			contactId: 1,
			channelId: 10,
			channelKind: "telegram_bot",
			conversations,
			nowEpoch: 0,
		});
		expect(res.created).toBe(false);
		expect(autoAssignCalls).toHaveLength(0);
	});

});
