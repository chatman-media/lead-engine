import { beforeEach, describe, expect, it } from "bun:test";
import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import type { ContactsRepo } from "./dal/index.ts";
import {
	processInbound,
	type ReplyStrategy,
	transcribeInboundVoice,
} from "./process-inbound.ts";
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

function makeDeps(
	reply: ReplyStrategy | null = null,
	channel: ChannelContext = CHANNEL,
) {
	const contacts = new FakeContactsRepo(TENANT.tenantId);
	const identities = new FakeChannelIdentitiesRepo();
	const conversations = new FakeConversationsRepo(TENANT.tenantId);
	const messages = new FakeMessagesRepo(TENANT.tenantId);
	const outbound = new FakeOutboundQueueRepo(TENANT.tenantId);
	return {
		tenant: TENANT,
		channel,
		channelDbId: channel.channelId,
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

	it("same contact can keep separate conversations per real channel", async () => {
		const contact = await deps._fakes.contacts.create({ displayName: "Multi" });
		await deps._fakes.identities.create({
			contactId: contact.id,
			channelId: 10,
			externalUserId: "u1",
		});
		await deps._fakes.identities.create({
			contactId: contact.id,
			channelId: 20,
			externalUserId: "u1",
		});

		await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "tg" }),
			deps,
		);
		const whatsappDeps = {
			...deps,
			channel: {
				channelId: 20,
				kind: "whatsapp" as const,
				externalId: "wa",
			},
			channelDbId: 20,
		};
		await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "200", text: "wa" }),
			whatsappDeps,
		);

		expect(deps._fakes.contacts.all()).toHaveLength(1);
		expect(deps._fakes.conversations.all()).toHaveLength(2);
		expect(deps._fakes.conversations.all().map((row) => row.channelId)).toEqual(
			[10, 20],
		);
		expect(deps._fakes.conversations.all().map((row) => row.source)).toEqual([
			"bot",
			"bot",
		]);
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

	it("правка (edited) с изменённым текстом обновляет строку, метит editedAt и переотвечает", async () => {
		let replyCalls = 0;
		const reply: ReplyStrategy = {
			generate: async () => {
				replyCalls += 1;
				return [
					{
						channelId: "tg-1",
						externalUserId: "u1",
						parts: [{ kind: "text" as const, text: "ответ" }],
					},
				];
			},
		};
		deps = makeDeps(reply);

		await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "превед" }),
			deps,
		);
		expect(replyCalls).toBe(1);

		const edited: Inbound = {
			...textInbound({ extUserId: "u1", extMessageId: "100", text: "привет" }),
			edited: true,
		};
		const res = await processInbound(edited, deps);

		expect(res.persisted).toBe(true);
		const userMsgs = deps._fakes.messages.all().filter((m) => m.role === "user");
		// Правку пишем in-place — новая строка НЕ создаётся.
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0]?.text).toBe("привет");
		expect(JSON.parse(userMsgs[0]?.metaJson ?? "{}").editedAt).toBe(1700000000);
		// Бот переотвечает на исправленный текст.
		expect(replyCalls).toBe(2);
	});

	it("правка (edited) с тем же текстом — no-op (идемпотентность ретрая edited_message)", async () => {
		let replyCalls = 0;
		const reply: ReplyStrategy = {
			generate: async () => {
				replyCalls += 1;
				return [];
			},
		};
		deps = makeDeps(reply);

		await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "hi" }),
			deps,
		);
		expect(replyCalls).toBe(1);

		const edited: Inbound = {
			...textInbound({ extUserId: "u1", extMessageId: "100", text: "hi" }),
			edited: true,
		};
		const res = await processInbound(edited, deps);

		expect(res.persisted).toBe(false);
		// Текст не менялся → ни апдейта строки, ни повторного reply.
		expect(replyCalls).toBe(1);
		const userMsgs = deps._fakes.messages.all().filter((m) => m.role === "user");
		expect(userMsgs).toHaveLength(1);
		expect(userMsgs[0]?.metaJson).toBeNull();
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

	it("забаненный contact сохраняет inbound, но не зовёт reply-strategy", async () => {
		let replyCalls = 0;
		deps = makeDeps({
			async generate() {
				replyCalls += 1;
				return [
					{
						channelId: "10",
						externalUserId: "u1",
						parts: [{ kind: "text", text: "reply" }],
					},
				];
			},
		});
		const contact = await deps._fakes.contacts.create({
			displayName: "Blocked User",
			attributesJson: JSON.stringify({
				isBanned: true,
				banStatus: "banned",
				ban: { status: "banned" },
			}),
		});
		await deps._fakes.identities.create({
			contactId: contact.id,
			channelId: 10,
			externalUserId: "u1",
		});
		// Пред-создаём resolved-диалог: забаненный inbound не должен его
		// переоткрывать и инкрементить unread (иначе всплывёт «новым» диалогом).
		const existing = await deps._fakes.conversations.create({
			contactId: contact.id,
			source: "bot",
			channelId: 10,
			nowEpoch: 1700000000,
		});
		await deps._fakes.conversations.updateInboxMetadata(existing.id, {
			status: "resolved",
		});

		const result = await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "100", text: "spam" }),
			deps,
		);

		expect(result.persisted).toBe(true);
		expect(result.outboundEnqueued).toBe(0);
		expect(result.escalatedReason).toBe("contact_banned");
		expect(replyCalls).toBe(0);
		expect(deps._fakes.messages.all()).toHaveLength(1);
		expect(deps._fakes.outbound.all()).toHaveLength(0);
		// Инбокс не дёрнут: resolved не переоткрыт, unread не вырос.
		const conv = deps._fakes.conversations.all()[0];
		expect(conv?.status).toBe("resolved");
		expect(conv?.unreadCount).toBe(0);
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

	it("human_takeover прикладывает медиа-рефы (паспорт/видео после передачи оператору)", async () => {
		const events: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
		const d = {
			...makeDeps(),
			notifications: {
				notify: async (e: { eventType: string; data?: Record<string, unknown> }) => {
					events.push(e);
				},
			} as unknown as Parameters<typeof processInbound>[1]["notifications"],
		};
		// Диалог уже у оператора (mode=human); клиент досылает паспорт.
		await d._fakes.conversations.create({
			contactId: 1,
			source: "bot",
			mode: "human",
			nowEpoch: 1700000000,
		});
		await d._fakes.contacts.create({ displayName: "KYC user" });
		await d._fakes.identities.create({
			contactId: 1,
			channelId: 10,
			externalUserId: "u-doc",
		});

		const photoInbound = {
			channelId: "tg-1",
			externalMessageId: "300",
			externalUserId: "u-doc",
			parts: [
				{
					kind: "photo",
					mediaRef: { channelId: "10", externalRef: "passport_file_1" },
				},
			],
			receivedAt: 1700000000,
			raw: {},
		} as unknown as Inbound;

		await processInbound(photoInbound, d);

		const takeover = events.find((e) => e.eventType === "human_takeover");
		expect(takeover).toBeDefined();
		expect(takeover?.data?.mediaCount).toBe(1);
		expect(String(takeover?.data?.mediaRefsJson)).toContain("passport_file_1");
	});

	it("human_takeover в exchange с медиа помечается reason=kyc_review (KYC-кнопки в боте)", async () => {
		const events: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
		const d = {
			...makeDeps(),
			template: { slug: "exchange_v1" } as unknown as Parameters<
				typeof processInbound
			>[1]["template"],
			notifications: {
				notify: async (e: { eventType: string; data?: Record<string, unknown> }) => {
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
		await d._fakes.contacts.create({ displayName: "KYC user" });
		await d._fakes.identities.create({
			contactId: 1,
			channelId: 10,
			externalUserId: "u-kyc",
		});

		const photoInbound = {
			channelId: "tg-1",
			externalMessageId: "301",
			externalUserId: "u-kyc",
			parts: [
				{ kind: "photo", mediaRef: { channelId: "10", externalRef: "passport_2" } },
			],
			receivedAt: 1700000000,
			raw: {},
		} as unknown as Inbound;

		await processInbound(photoInbound, d);

		const takeover = events.find((e) => e.eventType === "human_takeover");
		expect(takeover).toBeDefined();
		expect(takeover?.data?.reason).toBe("kyc_review");
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

	// ── Опциональные хуки pipeline (notifications / voice STT / extractFields /
	//    memoryExtractor / deferReply) — все через фейки, без БД. ──────────────
	type NotifyEvent = {
		eventType: string;
		conversationId: number;
		data?: Record<string, unknown>;
	};
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

	it("exchange media-only inbound creates actionable operator handoff with media refs", async () => {
		const events: NotifyEvent[] = [];
		const d = {
			...makeDeps(),
			template: {
				slug: "exchange_v1",
				displayName: "Exchange",
				version: 1,
				funnelStages: [],
				systemPromptFragment: "",
			},
			notifications: fakeNotifications(events),
		};
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "202",
			externalUserId: "u3",
			parts: [
				{
					kind: "video_note",
					mediaRef: { channelId: "tg-1", externalRef: "vn1" },
					durationSec: 8,
				},
				{
					kind: "document",
					mediaRef: { channelId: "tg-1", externalRef: "doc1" },
					fileName: "passport.pdf",
					mimeType: "application/pdf",
				},
			],
			receivedAt: 1700000000,
			raw: {},
		};

		await processInbound(inbound, d);

		const handoff = events.find(
			(e) => e.eventType === "operator_handoff_required",
		);
		expect(handoff?.data).toMatchObject({
			reason: "kyc_review",
			title: "Проверить KYC клиента",
			pending: "operator_kyc_decision",
			mediaCount: 2,
		});
		expect(String(handoff?.data?.mediaSummary)).toContain("video_note");
		expect(String(handoff?.data?.mediaSummary)).toContain("passport.pdf");
		expect(events.some((e) => e.eventType === "verification_requested")).toBe(
			false,
		);
	});

	it("voice part → транскрибируется в текст и персистится", async () => {
		const d = {
			...makeDeps(),
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
		await transcribeInboundVoice(inbound, {
			tenantId: TENANT.tenantId,
			transcriber: {
				transcribe: async () => "привет это расшифровка",
			},
			downloadVoice: async () => new Response(new Uint8Array([1, 2, 3])),
		});
		const res = await processInbound(inbound, d);
		expect(res.persisted).toBe(true);
		// voice-part заменён транскриптом → персистится как текстовое сообщение
		expect(d._fakes.messages.all()[0]?.text).toBe("привет это расшифровка");
	});

	it("voice: ошибка транскрипции глотается (pipeline продолжает)", async () => {
		const d = {
			...makeDeps(),
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
		await transcribeInboundVoice(inbound, {
			tenantId: TENANT.tenantId,
			transcriber: {
				transcribe: async () => {
					throw new Error("whisper down");
				},
			},
			downloadVoice: async () => new Response(new Uint8Array([1])),
		});
		const res = await processInbound(inbound, d);
		expect(res.persisted).toBe(true); // не упало
	});

	it("voice STT не резолвит transcriber для текстового inbound", async () => {
		let resolveCalls = 0;
		const inbound = textInbound({
			extUserId: "u5",
			extMessageId: "204",
			text: "plain text",
		});

		await transcribeInboundVoice(inbound, {
			tenantId: TENANT.tenantId,
			resolveTranscriber: () => {
				resolveCalls += 1;
				return {
					transcribe: async () => "should not run",
				};
			},
			downloadVoice: async () => new Response(new Uint8Array([1])),
		});

		expect(resolveCalls).toBe(0);
		expect(inbound.parts).toEqual([{ kind: "text", text: "plain text" }]);
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

	it("deferPostProcessing → не вызывает classifier/memory внутри processInbound", async () => {
		let classifierCalled = false;
		let memoryCalled = false;
		const d = {
			...makeDeps(),
			deferPostProcessing: true,
			db: {} as Parameters<typeof processInbound>[1]["db"],
			stageClassifier: {
				classify: async () => {
					classifierCalled = true;
					return "qualified" as never;
				},
			} as Parameters<typeof processInbound>[1]["stageClassifier"],
			memoryExtractor: {
				extract: async () => {
					memoryCalled = true;
					return { city: "Bangkok" };
				},
			} as unknown as Parameters<typeof processInbound>[1]["memoryExtractor"],
		};

		const res = await processInbound(
			textInbound({
				extUserId: "u-post",
				extMessageId: "306",
				text: "qualify and remember me",
			}),
			d,
		);

		expect(res.persisted).toBe(true);
		expect(res.postProcessingDeferred).toBe(true);
		expect(res.userMessageText).toBe("qualify and remember me");
		expect(res.previousStage).toBeNull();
		expect(res.conversationCreated).toBe(true);
		expect(classifierCalled).toBe(false);
		expect(memoryCalled).toBe(false);
	});

		it("exchange: фото с подписью про оплату → payment_review handoff (не KYC)", async () => {
			const events: NotifyEvent[] = [];
			let replyCalls = 0;
			const reply: ReplyStrategy = {
				generate: async () => {
					replyCalls += 1;
					return [{ channelId: "10", externalUserId: "u-pay", parts: [{ kind: "text", text: "AI" }] }];
				},
			};
			const d = {
				...makeDeps(reply),
				template: {
					slug: "exchange_v1",
					displayName: "Exchange",
				version: 1,
				funnelStages: [],
				systemPromptFragment: "",
			},
			notifications: fakeNotifications(events),
		};
		const inbound: Inbound = {
			channelId: "tg-1",
			externalMessageId: "210",
			externalUserId: "u-pay",
			parts: [
				{
					kind: "photo",
					mediaRef: { channelId: "tg-1", externalRef: "ph-receipt" },
					caption: "Чек об оплате 100000 RUB",
				},
			],
			receivedAt: 1700000000,
				raw: {},
			};

			const result = await processInbound(inbound, d);

			const handoff = events.find(
				(e) => e.eventType === "operator_handoff_required",
			);
		expect(handoff?.data).toMatchObject({
			reason: "payment_review",
			title: "Проверить оплату по чеку",
			pending: "operator_payment_review",
			priority: "high",
			});
			expect(String(handoff?.data?.reviewPath)).toContain("payment_confirmed");
			expect(result.escalatedReason).toBe("payment_review");
			expect(replyCalls).toBe(0);
			const [conv] = d._fakes.conversations.all();
			expect(conv).toMatchObject({
				mode: "human",
				status: "pending",
				escalatedAt: 1700000000,
			});

			await processInbound(
				textInbound({
					extUserId: "u-pay",
					extMessageId: "211",
					text: "ну что там?",
				}),
				d,
			);
			expect(replyCalls).toBe(0);
		});

	// ── Stage classifier + lead auto-advance (фейковый чейнящийся Db) ─────────
	/**
	 * Каждый await терминального drizzle-выражения забирает следующий элемент
	 * script (Error → reject). Позволяет прогнать applyClassifiedStage +
	 * ensureAndAdvanceLeadByPhase без Postgres.
	 */
	function scriptedDb(script: Array<unknown[] | Error>) {
		let i = 0;
		const next = (): Promise<unknown[]> => {
			const entry = script[i++];
			if (entry instanceof Error) return Promise.reject(entry);
			return Promise.resolve(entry ?? []);
		};
		const makeChain = () => {
			// biome-ignore lint/suspicious/noExplicitAny: фейковый query-builder
			const chain: any = {};
			for (const m of [
				"from",
				"where",
				"innerJoin",
				"leftJoin",
				"orderBy",
				"limit",
				"set",
				"values",
				"returning",
			]) {
				chain[m] = () => chain;
			}
			// biome-ignore lint/suspicious/noThenProperty: thenable нужен, чтобы await drizzle-чейна забирал script
			chain.then = (
				res: (v: unknown) => unknown,
				rej?: (e: unknown) => unknown,
			) => next().then(res, rej);
			return chain;
		};
		return {
			select: () => makeChain(),
			insert: () => makeChain(),
			update: () => makeChain(),
		} as unknown as Parameters<typeof processInbound>[1]["db"];
	}

	type SinkLog = {
		level: string;
		msg: string;
		fields?: Record<string, unknown>;
	};
	function capturingSink(logs: SinkLog[]) {
		return {
			log: (level: string, msg: string, fields?: Record<string, unknown>) => {
				logs.push({ level, msg, fields });
			},
		};
	}

	it("stage classifier: смена стадии логируется, лид auto-created и продвинут", async () => {
		const logs: SinkLog[] = [];
		const d = {
			...makeDeps(),
			db: scriptedDb([
				[{ stage: null }], // applyClassifiedStage: текущая стадия
				[], // applyClassifiedStage: UPDATE conversations
				[
					// lead-advance: стадии активной воронки
					{ id: 1, slug: "new", phase: null, kind: "intake", position: 0 },
					{
						id: 2,
						slug: "qualified",
						phase: "qualify",
						kind: "normal",
						position: 1,
					},
				],
				[], // lead-advance: существующий лид (нет)
				[{ id: 42 }], // lead INSERT returning
				[], // lead UPDATE (advance)
			]),
			leads: {} as Parameters<typeof processInbound>[1]["leads"],
			stageClassifier: {
				classify: async () => "qualify" as never,
			} as Parameters<typeof processInbound>[1]["stageClassifier"],
			sink: capturingSink(logs),
		};

		const res = await processInbound(
			textInbound({
				extUserId: "u-lead-new",
				extMessageId: "401",
				text: "хочу обменять 500 usdt",
			}),
			d,
		);

		expect(res.persisted).toBe(true);
		expect(logs).toContainEqual(
			expect.objectContaining({
				level: "debug",
				msg: "conversation stage classified",
				fields: expect.objectContaining({ from: null, to: "qualify" }),
			}),
		);
		const created = logs.find((l) => l.msg === "lead auto-created");
		expect(created?.fields).toMatchObject({
			leadId: 42,
			stage: "qualified",
			salesStage: "qualify",
		});
	});

	it("stage classifier: существующий лид продвигается → 'lead advanced'", async () => {
		const logs: SinkLog[] = [];
		const d = {
			...makeDeps(),
			db: scriptedDb([
				[{ stage: null }],
				[],
				[
					{ id: 1, slug: "new", phase: null, kind: "intake", position: 0 },
					{ id: 2, slug: "offer", phase: "offer", kind: "normal", position: 1 },
				],
				[{ id: 7, state: "new", stageDefinitionId: 1 }], // лид уже есть
				[], // lead UPDATE (advance)
			]),
			leads: {} as Parameters<typeof processInbound>[1]["leads"],
			stageClassifier: {
				classify: async () => "pitch" as never,
			} as Parameters<typeof processInbound>[1]["stageClassifier"],
			sink: capturingSink(logs),
		};

		await processInbound(
			textInbound({
				extUserId: "u-lead-adv",
				extMessageId: "402",
				text: "какие условия?",
			}),
			d,
		);

		const advanced = logs.find((l) => l.msg === "lead advanced");
		expect(advanced?.fields).toMatchObject({
			leadId: 7,
			stage: "offer",
			salesStage: "pitch",
		});
	});

	it("stage classifier: ошибка lead-advance → warn, pipeline продолжает", async () => {
		const logs: SinkLog[] = [];
		const d = {
			...makeDeps(),
			db: scriptedDb([
				[{ stage: "qualify" }], // та же стадия → UPDATE не нужен
				new Error("stages query down"), // lead-advance падает на выборке стадий
			]),
			leads: {} as Parameters<typeof processInbound>[1]["leads"],
			stageClassifier: {
				classify: async () => "qualify" as never,
			} as Parameters<typeof processInbound>[1]["stageClassifier"],
			sink: capturingSink(logs),
		};

		const res = await processInbound(
			textInbound({
				extUserId: "u-lead-err",
				extMessageId: "403",
				text: "обмен usdt",
			}),
			d,
		);

		expect(res.persisted).toBe(true);
		expect(logs).toContainEqual(
			expect.objectContaining({
				level: "warn",
				msg: "lead auto-advance failed",
				fields: expect.objectContaining({ error: "stages query down" }),
			}),
		);
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

	describe("#735 language detection in tx1", () => {
		it("первый ru-text детектится: detectedLang='ru', langLocked=true", async () => {
			const inbound: Inbound = {
				channelId: "tg-1",
				externalMessageId: "lang-1",
				externalUserId: "u-lang-1",
				parts: [{ kind: "text", text: "Привет, сколько стоит обмен USDT?" }],
				receivedAt: 1700000000,
				raw: {},
			};
			await processInbound(inbound, deps);
			const conv = deps._fakes.conversations.all()[0]!;
			expect(conv.detectedLang).toBe("ru");
			expect(conv.langLocked).toBe(true);
		});

		it("«ok» не сбивает залипший язык (короткий не-confident сигнал)", async () => {
			// Первое сообщение — confident ru → залипает.
			await processInbound(
				{
					channelId: "tg-1",
					externalMessageId: "lang-2a",
					externalUserId: "u-lang-2",
					parts: [{ kind: "text", text: "Здравствуйте, хочу обменять" }],
					receivedAt: 1700000000,
					raw: {},
				},
				deps,
			);
			const convId = deps._fakes.conversations.all()[0]!.id;
			expect(deps._fakes.conversations.all()[0]?.detectedLang).toBe("ru");

			// Второе сообщение — короткий «ok»: не должен переключать.
			await processInbound(
				{
					channelId: "tg-1",
					externalMessageId: "lang-2b",
					externalUserId: "u-lang-2",
					parts: [{ kind: "text", text: "ok" }],
					receivedAt: 1700000060,
					raw: {},
				},
				deps,
			);
			const conv = deps._fakes.conversations.all().find((c) => c.id === convId)!;
			expect(conv.detectedLang).toBe("ru");
			expect(conv.langLocked).toBe(true);
		});

		it("confident en перебивает залипший ru (осознанная смена скрипта)", async () => {
			await processInbound(
				{
					channelId: "tg-1",
					externalMessageId: "lang-3a",
					externalUserId: "u-lang-3",
					parts: [{ kind: "text", text: "Здравствуйте, хочу обменять" }],
					receivedAt: 1700000000,
					raw: {},
				},
				deps,
			);
			expect(deps._fakes.conversations.all()[0]?.detectedLang).toBe("ru");

			await processInbound(
				{
					channelId: "tg-1",
					externalMessageId: "lang-3b",
					externalUserId: "u-lang-3",
					parts: [{ kind: "text", text: "Hello, can you switch to English please?" }],
					receivedAt: 1700000060,
					raw: {},
				},
				deps,
			);
			const conv = deps._fakes.conversations.all()[0]!;
			expect(conv.detectedLang).toBe("en");
			expect(conv.langLocked).toBe(true);
		});

		it("media-only берёт channelLangHint только на первом сообщении (locked=false)", async () => {
			const inbound: Inbound = {
				channelId: "tg-1",
				externalMessageId: "lang-4",
				externalUserId: "u-lang-4",
				parts: [{ kind: "photo", mediaRef: { channelId: "tg-1", externalRef: "AgACAgI" } }],
				receivedAt: 1700000000,
				raw: {},
				channelLangHint: "ko",
			};
			await processInbound(inbound, deps);
			const conv = deps._fakes.conversations.all()[0]!;
			expect(conv.detectedLang).toBe("ko");
			// hint мягкий — locked=false, чтобы любой confident-сигнал переключал.
			expect(conv.langLocked).toBe(false);
		});

		it("detected_lang сохраняется в tx1 до reply.generate (виден reply-стратегии)", async () => {
			let snapshotDetectedLang: string | null | undefined;
			let snapshotLocked: boolean | undefined;
			const d = makeDeps();
			const reply: ReplyStrategy = {
				generate: async (opts) => {
					// На момент reply.generate шаг 4a уже отработал внутри tx1 →
					// conversation в репо хранит сохранённый detected_lang.
					const row = d._fakes.conversations.all().find((c) => c.id === opts.conversationId);
					snapshotDetectedLang = row?.detectedLang ?? undefined;
					snapshotLocked = row?.langLocked ?? undefined;
					return [];
				},
			};
			const withReply = { ...d, reply };
			await processInbound(
				textInbound({
					extUserId: "u-lang-5",
					extMessageId: "lang-5",
					text: "Привет, какой курс USDT?",
				}),
				withReply,
			);
			expect(snapshotDetectedLang).toBe("ru");
			expect(snapshotLocked).toBe(true);
		});
	});

	it("reply с photo-частью → outboundEnvelopeText пропускает нетекстовую часть (line 96)", async () => {
		deps = makeDeps({
			async generate() {
				return [
					{
						channelId: "10",
						externalUserId: "u1",
						// photo без caption → outboundEnvelopeText вернёт null → не кладётся в messages
						parts: [{ kind: "photo" as const, mediaRef: { channelId: "10", externalRef: "ext1" } }],
					},
				];
			},
		});
		const result = await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "m-photo", text: "привет" }),
			deps,
		);
		expect(result.persisted).toBe(true);
		// photo без caption → aiText = null → assistant message не записывается
		expect(deps._fakes.messages.all().filter((m) => m.role === "assistant")).toHaveLength(0);
		// envelope всё равно попадает в outbound
		expect(deps._fakes.outbound.all()).toHaveLength(1);
	});

	it("contact с невалидным attributesJson → parseJsonObject не падает (lines 110-114)", async () => {
		// non-object JSON ("42") → ветка: JSON.parse OK но не объект → return {}
		const contact1 = await deps._fakes.contacts.create({
			attributesJson: "42",
		});
		await deps._fakes.identities.create({
			contactId: contact1.id,
			channelId: 10,
			externalUserId: "u-bad1",
		});

		// broken JSON → catch-ветка
		const contact2 = await deps._fakes.contacts.create({
			attributesJson: "{broken-json",
		});
		await deps._fakes.identities.create({
			contactId: contact2.id,
			channelId: 10,
			externalUserId: "u-bad2",
		});

		// Оба inbound должны пройти без падения (contact не забанен)
		const r1 = await processInbound(
			textInbound({ extUserId: "u-bad1", extMessageId: "m-bad1", text: "hello" }),
			deps,
		);
		expect(r1.persisted).toBe(true);

		const r2 = await processInbound(
			textInbound({ extUserId: "u-bad2", extMessageId: "m-bad2", text: "world" }),
			deps,
		);
		expect(r2.persisted).toBe(true);
	});

	it("autoTakeover с handoff → applyAutoHandoff вызывается (lines 812-823)", async () => {
		deps = makeDeps({
			async generate() {
				return {
					envelopes: [
						{
							channelId: "10",
							externalUserId: "u1",
							parts: [{ kind: "text" as const, text: "Передаю оператору." }],
						},
					],
					operatorHandoffs: [
						{
							reason: "kyc_review" as const,
							title: "KYC",
							action: "Проверить",
							orderId: 5,
							stageSlug: "kyc_waiting",
						},
					],
					autoTakeover: true,
					customerNoticeSent: true,
				};
			},
		});
		const result = await processInbound(
			textInbound({ extUserId: "u1", extMessageId: "m-takeover", text: "паспорт" }),
			deps,
		);
		expect(result.escalatedReason).toBe("kyc_review");
		// conversation переведена в human mode
		const conv = deps._fakes.conversations.all().find((c) => c.mode === "human");
		expect(conv).toBeDefined();
	});


});
