import { beforeEach, describe, expect, it } from "bun:test";
import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import type { ContactsRepo } from "./dal/index.ts";
import { processInbound, type ReplyStrategy } from "./process-inbound.ts";
import {
	FakeChannelIdentitiesRepo,
	FakeContactsRepo,
	FakeConversationsRepo,
	FakeMessagesRepo,
	FakeOutboundQueueRepo,
} from "./testkit.ts";
import type { ChannelContext, Clock, TenantContext } from "./types.ts";

const TENANT: TenantContext = {
	tenantId: 1,
	slug: "legacy",
	llmBillingMode: "byok",
};
const CHANNEL: ChannelContext = {
	channelId: 10,
	kind: "telegram_bot",
	externalId: "test_bot",
};

function fixedClock(epoch: number): Clock {
	return { nowEpoch: () => epoch };
}

function textInbound(opts: {
	extUserId: string;
	extMessageId: string;
	text: string;
}): Inbound {
	return {
		channelId: "tg-1",
		externalMessageId: opts.extMessageId,
		externalUserId: opts.extUserId,
		parts: [{ kind: "text", text: opts.text }],
		receivedAt: 1700000000,
		raw: {},
	};
}

function makeDeps(reply: ReplyStrategy | null = null) {
	const contacts = new FakeContactsRepo(TENANT.tenantId);
	const identities = new FakeChannelIdentitiesRepo();
	const conversations = new FakeConversationsRepo(TENANT.tenantId);
	const messages = new FakeMessagesRepo(TENANT.tenantId);
	const outbound = new FakeOutboundQueueRepo(TENANT.tenantId);
	return {
		tenant: TENANT,
		channel: CHANNEL,
		channelDbId: 10,
		contacts: contacts as unknown as ContactsRepo,
		identities: identities as unknown as Parameters<
			typeof processInbound
		>[1]["identities"],
		conversations: conversations as unknown as Parameters<
			typeof processInbound
		>[1]["conversations"],
		messages: messages as unknown as Parameters<
			typeof processInbound
		>[1]["messages"],
		outbound: outbound as unknown as Parameters<
			typeof processInbound
		>[1]["outbound"],
		reply,
		clock: fixedClock(1700000000),
		// Expose fakes back для assertions.
		_fakes: { contacts, identities, conversations, messages, outbound },
	};
}

describe("processInbound", () => {
	let deps: ReturnType<typeof makeDeps>;
	beforeEach(() => {
		deps = makeDeps();
	});

	it("создаёт Contact + ChannelIdentity + Conversation на новый external_user_id", async () => {
		const inbound = textInbound({
			extUserId: "u1",
			extMessageId: "100",
			text: "hi",
		});
		const result = await processInbound(inbound, deps);

		expect(result.persisted).toBe(true);
		expect(deps._fakes.contacts.all()).toHaveLength(1);
		expect(deps._fakes.identities.all()).toHaveLength(1);
		expect(deps._fakes.conversations.all()).toHaveLength(1);
		expect(deps._fakes.messages.all()).toHaveLength(1);
		expect(deps._fakes.messages.all()[0]).toMatchObject({
			role: "user",
			text: "hi",
			tgMessageId: 100,
		});
	});

	it("второй inbound от того же external_user_id переиспользует Contact и Conversation", async () => {
		await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "first" }),
			deps,
		);
		await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "101", text: "second" }),
			deps,
		);
		expect(deps._fakes.contacts.all()).toHaveLength(1);
		expect(deps._fakes.conversations.all()).toHaveLength(1);
		expect(deps._fakes.messages.all()).toHaveLength(2);
	});

	it("дедупает повторный inbound с тем же external_message_id (Telegram retry webhook)", async () => {
		const inbound = textInbound({
			extUserId: "u1",
			extMessageId: "100",
			text: "hi",
		});
		const first = await processInbound(inbound, deps);
		const second = await processInbound(inbound, deps);
		expect(first.persisted).toBe(true);
		expect(second.persisted).toBe(false);
		expect(deps._fakes.messages.all()).toHaveLength(1);
	});

	it("в conversation.mode='queued' / 'human' не зовёт reply-strategy", async () => {
		const reply: ReplyStrategy = {
			generate: async () => {
				throw new Error("reply.generate must not be called in non-ai mode");
			},
		};
		deps = makeDeps(reply);
		// Создаём Conversation вручную с mode='queued'.
		await deps._fakes.conversations.create({
			contactId: 1,
			source: "bot",
			mode: "queued",
			nowEpoch: 1700000000,
		});
		await deps._fakes.contacts.create({});
		await deps._fakes.identities.create({
			contactId: 1,
			channelId: 10,
			externalUserId: "u1",
		});

		const result = await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "ping" }),
			deps,
		);
		expect(result.outboundEnqueued).toBe(0);
		expect(deps._fakes.outbound.all()).toHaveLength(0);
	});

	it("human/queued conversation → notifications human_takeover", async () => {
		const events: Array<{ eventType: string; data?: { text?: string } }> = [];
		const d = {
			...makeDeps(),
			notifications: {
				notify: async (e: { eventType: string; data?: { text?: string } }) => {
					events.push(e);
				},
			} as unknown as Parameters<typeof processInbound>[1]["notifications"],
		};
		await d._fakes.conversations.create({
			contactId: 1,
			source: "bot",
			mode: "human",
			nowEpoch: 1700000000,
		});
		await d._fakes.contacts.create({ displayName: "Operator user" });
		await d._fakes.identities.create({
			contactId: 1,
			channelId: 10,
			externalUserId: "u-human",
		});

		await processInbound(
			textInbound({
				extUserId: "u-human",
				extMessageId: "102",
				text: "operator please",
			}),
			d,
		);

		expect(events).toContainEqual(
			expect.objectContaining({
				eventType: "human_takeover",
				data: expect.objectContaining({ text: "operator please" }),
			}),
		);
	});

	it("в mode='ai' зовёт reply-strategy и кладёт envelopes в outbound_queue", async () => {
		const envelope: OutboundEnvelope = {
			channelId: "tg-1",
			externalUserId: "u1",
			parts: [{ kind: "text", text: "pong" }],
		};
		const reply: ReplyStrategy = { generate: async () => [envelope] };
		deps = makeDeps(reply);

		const result = await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "ping" }),
			deps,
		);
		expect(result.outboundEnqueued).toBe(1);
		expect(deps._fakes.outbound.all()).toHaveLength(1);
		expect(deps._fakes.outbound.all()[0]?.payloadJson).toContain("pong");
	});

	it("media-only inbound (photo без caption) персистит message, но reply не вызывается", async () => {
		const reply: ReplyStrategy = { generate: async () => [] };
		deps = makeDeps(reply);
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "100",
			externalUserId: "u1",
			parts: [
				{
					kind: "photo",
					mediaRef: { channelId: "tg-1", externalRef: "file123" },
				},
			],
			receivedAt: 1700000000,
			raw: {},
		};
		const result = await processInbound(inbound, deps);
		expect(result.persisted).toBe(true);
		expect(result.outboundEnqueued).toBe(0);
		expect(deps._fakes.messages.all()[0]?.text).toBe("");
		expect(deps._fakes.messages.all()[0]?.metaJson).toContain("photo");
	});

	it("callback_query не персистится как message (отдельный handler)", async () => {
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "100",
			externalUserId: "u1",
			parts: [
				{
					kind: "callback_query",
					data: "approve:42",
					originalMessageId: "999",
				},
			],
			receivedAt: 1700000000,
			raw: {},
		};
		const result = await processInbound(inbound, deps);
		expect(result.persisted).toBe(false);
		expect(deps._fakes.messages.all()).toHaveLength(0);
		// Но Contact + Conversation всё равно создаются (нужны downstream'у).
		expect(deps._fakes.contacts.all()).toHaveLength(1);
		expect(deps._fakes.conversations.all()).toHaveLength(1);
	});

	// ── Опциональные хуки pipeline (notifications / transcriber / extractFields /
	//    memoryExtractor / deferReply) — все через фейки, без БД. ──────────────
	type NotifyEvent = { eventType: string; conversationId: number };
	function fakeNotifications(events: NotifyEvent[]) {
		return {
			notify: async (e: NotifyEvent) => {
				events.push(e);
			},
		} as unknown as Parameters<typeof processInbound>[1]["notifications"];
	}

	it("video_note → notifications verification_requested", async () => {
		const events: NotifyEvent[] = [];
		const d = { ...makeDeps(), notifications: fakeNotifications(events) };
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "200",
			externalUserId: "u1",
			parts: [
				{
					kind: "video_note",
					mediaRef: { channelId: "tg-1", externalRef: "vn1" },
				},
			],
			receivedAt: 1700000000,
			raw: {},
		};
		await processInbound(inbound, d);
		expect(events.some((e) => e.eventType === "verification_requested")).toBe(
			true,
		);
	});

	it("photo (медиа) → notifications document_uploaded", async () => {
		const events: NotifyEvent[] = [];
		const d = { ...makeDeps(), notifications: fakeNotifications(events) };
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "201",
			externalUserId: "u2",
			parts: [
				{ kind: "photo", mediaRef: { channelId: "tg-1", externalRef: "ph1" } },
			],
			receivedAt: 1700000000,
			raw: {},
		};
		await processInbound(inbound, d);
		expect(events.some((e) => e.eventType === "document_uploaded")).toBe(true);
	});

	it("voice part → транскрибируется в текст и персистится", async () => {
		const d = {
			...makeDeps(),
			transcriber: {
				transcribe: async () => "привет это расшифровка",
			} as unknown as Parameters<typeof processInbound>[1]["transcriber"],
			downloadVoice: (async () =>
				new Response(new Uint8Array([1, 2, 3]))) as unknown as Parameters<
				typeof processInbound
			>[1]["downloadVoice"],
		};
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "202",
			externalUserId: "u3",
			parts: [
				{ kind: "voice", mediaRef: { channelId: "tg-1", externalRef: "v1" } },
			],
			receivedAt: 1700000000,
			raw: {},
		};
		const res = await processInbound(inbound, d);
		expect(res.persisted).toBe(true);
		// voice-part заменён транскриптом → персистится как текстовое сообщение
		expect(d._fakes.messages.all()[0]?.text).toBe("привет это расшифровка");
	});

	it("voice: ошибка транскрипции глотается (pipeline продолжает)", async () => {
		const d = {
			...makeDeps(),
			transcriber: {
				transcribe: async () => {
					throw new Error("whisper down");
				},
			} as unknown as Parameters<typeof processInbound>[1]["transcriber"],
			downloadVoice: (async () =>
				new Response(new Uint8Array([1]))) as unknown as Parameters<
				typeof processInbound
			>[1]["downloadVoice"],
		};
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "203",
			externalUserId: "u4",
			parts: [
				{ kind: "voice", mediaRef: { channelId: "tg-1", externalRef: "v2" } },
			],
			receivedAt: 1700000000,
			raw: {},
		};
		const res = await processInbound(inbound, d);
		expect(res.persisted).toBe(true); // не упало
	});

	it("template.hooks.extractFields → mergeAttributes на contact", async () => {
		const d = {
			...makeDeps(),
			template: {
				hooks: {
					extractFields: async () => ({ name: "Аня", city: "Сочи" }),
				},
			} as unknown as Parameters<typeof processInbound>[1]["template"],
		};
		await processInbound(
			textInbound({
				extUserId: "u5",
				extMessageId: "300",
				text: "меня зовут Аня",
			}),
			d,
		);
		const contact = d._fakes.contacts.all()[0];
		expect(contact?.attributesJson ?? "").toContain("Аня");
	});

	it("extractFields ошибка глотается", async () => {
		const d = {
			...makeDeps(),
			template: {
				hooks: {
					extractFields: async () => {
						throw new Error("hook boom");
					},
				},
			} as unknown as Parameters<typeof processInbound>[1]["template"],
		};
		const res = await processInbound(
			textInbound({ extUserId: "u6", extMessageId: "301", text: "текст" }),
			d,
		);
		expect(res.persisted).toBe(true);
	});

	it("memoryExtractor вызывается и не валит pipeline при ошибке", async () => {
		let called = false;
		const d = {
			...makeDeps(),
			memoryExtractor: {
				extract: async () => {
					called = true;
					throw new Error("llm down");
				},
			} as unknown as Parameters<typeof processInbound>[1]["memoryExtractor"],
		};
		const res = await processInbound(
			textInbound({
				extUserId: "u7",
				extMessageId: "302",
				text: "запомни про меня",
			}),
			d,
		);
		expect(called).toBe(true);
		expect(res.persisted).toBe(true);
	});

	it("memoryExtractor success → mergeAttributes и debug log с keys", async () => {
		const logs: Array<{ level: string; msg: string; keys?: string[] }> = [];
		const d = {
			...makeDeps(),
			memoryExtractor: {
				extract: async () => ({ city: "Bangkok", name: "Alex" }),
			} as unknown as Parameters<typeof processInbound>[1]["memoryExtractor"],
			sink: {
				log: (level: string, msg: string, fields?: { keys?: string[] }) => {
					logs.push({ level, msg, keys: fields?.keys });
				},
			},
		};
		const res = await processInbound(
			textInbound({
				extUserId: "u-memory",
				extMessageId: "304",
				text: "remember me",
			}),
			d,
		);
		expect(res.persisted).toBe(true);
		expect(d._fakes.contacts.all()[0]?.attributesJson).toContain("Bangkok");
		expect(logs).toContainEqual({
			level: "debug",
			msg: "memory facts extracted",
			keys: ["city", "name"],
		});
	});

	it("stage classifier failure logs warning and pipeline continues", async () => {
		const logs: Array<{ level: string; msg: string; error?: string }> = [];
		const d = {
			...makeDeps(),
			db: {} as Parameters<typeof processInbound>[1]["db"],
			stageClassifier: {
				classify: async () => {
					throw new Error("classifier down");
				},
			} as Parameters<typeof processInbound>[1]["stageClassifier"],
			sink: {
				log: (level: string, msg: string, fields?: { error?: string }) => {
					logs.push({ level, msg, error: fields?.error });
				},
			},
		};
		const res = await processInbound(
			textInbound({
				extUserId: "u-stage",
				extMessageId: "305",
				text: "qualify me",
			}),
			d,
		);
		expect(res.persisted).toBe(true);
		expect(logs).toContainEqual({
			level: "warn",
			msg: "stage classifier failed",
			error: "classifier down",
		});
	});

	it("deferReply → возвращается до reply.generate (replyDeferred)", async () => {
		let replyCalled = false;
		const reply: ReplyStrategy = {
			generate: async () => {
				replyCalled = true;
				return [];
			},
		};
		const d = { ...makeDeps(reply), deferReply: true };
		const res = await processInbound(
			textInbound({ extUserId: "u8", extMessageId: "303", text: "привет" }),
			d,
		);
		expect(res.replyDeferred).toBe(true);
		expect(res.outboundEnqueued).toBe(0);
		expect(replyCalled).toBe(false);
	});
});
