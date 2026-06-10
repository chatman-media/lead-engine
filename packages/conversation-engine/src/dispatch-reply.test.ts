// Unit-test для generateReplyAndEnqueue. Проверяет contract:
//   - mediaOnly → early-return (0 envelopes, replyStrategy не вызван)
//   - userMessageText="" → early-return
//   - replyStrategy returns null/[] → 0 envelopes
//   - happy path: replyStrategy returns N envelopes → outbound.enqueue × N
//
// Postgres не нужен — мокаем db.transaction через TestDb shim, который
// просто исполняет callback. Тест покрывает orchestration, не DAL-уровень.

import { describe, expect, it } from "bun:test";
import type { Inbound, OutboundEnvelope } from "@chatman-media/channel-core";
import type { Db } from "./dal/types.ts";
import { generateReplyAndEnqueue } from "./dispatch-reply.ts";
import type { ProcessInboundResult } from "./types.ts";

interface TestDb {
	transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
	execute: (sql: unknown) => Promise<unknown>;
}

function makeTestDb(): TestDb {
	return {
		transaction: async (fn) => fn({} as unknown as Db),
		execute: async () => undefined,
	};
}

function fakeInbound(): Inbound {
	return {
		channelId: "1",
		externalMessageId: "msg-1",
		externalUserId: "user-1",
		receivedAt: 0,
		parts: [{ kind: "text", text: "hello" }],
		raw: {},
	};
}

const tenant = { tenantId: 1, slug: "t1", llmBillingMode: "byok" as const };
const channel = {
	channelId: 100,
	kind: "telegram_bot" as const,
	externalId: "test-bot",
};

describe("generateReplyAndEnqueue", () => {
	it("mediaOnly → no LLM call, 0 envelopes", async () => {
		let strategyCalled = false;
		const db = makeTestDb();
		const result: ProcessInboundResult = {
			contactId: 1,
			conversationId: 10,
			persisted: true,
			outboundEnqueued: 0,
			userMessageText: "",
			mediaOnly: true,
			replyDeferred: true,
		};
		const out = await generateReplyAndEnqueue({
			db: db as unknown as Db,
			tenant,
			channel,
			channelDbId: 100,
			inbound: fakeInbound(),
			result,
			replyStrategy: {
				async generate() {
					strategyCalled = true;
					return [{ channelId: "1", externalUserId: "u1", parts: [] }];
				},
			},
		});
		expect(out.outboundEnqueued).toBe(0);
		expect(strategyCalled).toBe(false);
	});

	it("empty userMessageText → no LLM call, 0 envelopes", async () => {
		let strategyCalled = false;
		const db = makeTestDb();
		const out = await generateReplyAndEnqueue({
			db: db as unknown as Db,
			tenant,
			channel,
			channelDbId: 100,
			inbound: fakeInbound(),
			result: {
				contactId: 1,
				conversationId: 10,
				persisted: true,
				outboundEnqueued: 0,
				userMessageText: "",
				mediaOnly: false,
				replyDeferred: true,
			},
			replyStrategy: {
				async generate() {
					strategyCalled = true;
					return [];
				},
			},
		});
		expect(out.outboundEnqueued).toBe(0);
		expect(strategyCalled).toBe(false);
	});

	it("replyStrategy returns null → 0 envelopes (tx не открывается)", async () => {
		let txOpened = false;
		const db: TestDb = {
			transaction: async (fn) => {
				txOpened = true;
				return fn({} as unknown as Db);
			},
			execute: async () => undefined,
		};
		const out = await generateReplyAndEnqueue({
			db: db as unknown as Db,
			tenant,
			channel,
			channelDbId: 100,
			inbound: fakeInbound(),
			result: {
				contactId: 1,
				conversationId: 10,
				persisted: true,
				outboundEnqueued: 0,
				userMessageText: "hello",
				mediaOnly: false,
				replyDeferred: true,
			},
			replyStrategy: {
				async generate() {
					return null;
				},
			},
		});
		expect(out.outboundEnqueued).toBe(0);
		// Главный invariant: НЕТ открытой DB tx при пустом результате LLM.
		expect(txOpened).toBe(false);
	});

	it("contract: LLM call происходит ВНЕ db.transaction", async () => {
		// Сценарий: replyStrategy.generate должен быть вызван ДО db.transaction.
		// Мы регистрируем порядок вызовов и сверяем.
		const events: string[] = [];
		const replyEnvelopes: OutboundEnvelope[] = [
			{
				channelId: "100",
				externalUserId: "u1",
				parts: [{ kind: "text", text: "ответ" }],
			},
		];
		const db: TestDb = {
			transaction: async (fn) => {
				events.push("tx-open");
				const out = await fn({
					insert: () => ({
						values: () => ({ returning: async () => [{ id: 99 }] }),
					}),
					select: () => ({ from: () => ({ where: async () => [] }) }),
					execute: async () => [],
				} as unknown as Db);
				events.push("tx-commit");
				return out;
			},
			execute: async () => undefined,
		};
		const out = await generateReplyAndEnqueue({
			db: db as unknown as Db,
			tenant,
			channel,
			channelDbId: 100,
			inbound: fakeInbound(),
			result: {
				contactId: 1,
				conversationId: 10,
				persisted: true,
				outboundEnqueued: 0,
				userMessageText: "hello",
				mediaOnly: false,
				replyDeferred: true,
			},
			replyStrategy: {
				async generate() {
					events.push("llm-call");
					return replyEnvelopes;
				},
			},
		});
		// КЛЮЧЕВОЙ инвариант split'а: llm-call ДО tx-open.
		expect(events.indexOf("llm-call")).toBeLessThan(events.indexOf("tx-open"));
		// Tx должна была открыться один раз (для enqueue).
		expect(events.filter((e) => e === "tx-open")).toHaveLength(1);
		// outboundEnqueued = 1 (n envelopes отправлено)
		expect(out.outboundEnqueued).toBe(1);
	});

	it("operatorHandoff envelope → emits operator notification", async () => {
		const notifications: Array<{
			eventType: string;
			conversationId?: number;
			contactId?: number;
			data: Record<string, unknown>;
		}> = [];
		const db: TestDb = {
			transaction: async (fn) =>
				fn({
					insert: () => ({
						values: () => ({ returning: async () => [{ id: 100 }] }),
					}),
					select: () => ({ from: () => ({ where: async () => [] }) }),
					execute: async () => [],
				} as unknown as Db),
			execute: async () => undefined,
		};

		const out = await generateReplyAndEnqueue({
			db: db as unknown as Db,
			tenant,
			channel,
			channelDbId: 100,
			inbound: {
				...fakeInbound(),
				parts: [
					{ kind: "text", text: "Вот видео и паспорт" },
					{
						kind: "video_note",
						mediaRef: { channelId: "tg-1", externalRef: "vn1" },
						durationSec: 7,
					},
					{
						kind: "document",
						mediaRef: { channelId: "tg-1", externalRef: "doc1" },
						fileName: "passport.pdf",
						mimeType: "application/pdf",
					},
				],
			},
			result: {
				contactId: 7,
				contactDisplayName: "KYC Client",
				conversationId: 55,
				persisted: true,
				outboundEnqueued: 0,
				userMessageText: "Вот видео и паспорт",
				mediaOnly: false,
				replyDeferred: true,
			},
			replyStrategy: {
				async generate() {
					return [
						{
							channelId: "100",
							externalUserId: "u1",
							parts: [{ kind: "text", text: "Передаю на проверку." }],
							operatorHandoff: {
								reason: "kyc_review",
								title: "KYC: проверить документ/видео",
								action:
									"Проверить KYC-материалы через внешний KYC-сервис или manual operator review.",
								contractId: "kyc_submitted",
								priority: "high",
								accepted: "Клиент отправил KYC-материалы.",
								pending: "Верификация ждёт результата.",
								reviewPath: "operator_or_external_kyc",
								context:
									"Заявка #42; media=document/video; raw contents omitted.",
								urgency: "high: KYC blocks payment requisites.",
								amount: "100000 RUB -> 40000 THB",
								rail: "card transfer",
								network: "TRC20",
							},
						},
					];
				},
			},
			notifications: {
				notify: async (event: {
					eventType: string;
					conversationId?: number;
					contactId?: number;
					data: Record<string, unknown>;
				}) => {
					notifications.push(event);
				},
			} as never,
		});

		expect(out.outboundEnqueued).toBe(1);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toMatchObject({
			eventType: "operator_handoff_required",
			conversationId: 55,
			contactId: 7,
			data: {
				reason: "kyc_review",
				displayName: "KYC Client",
				contractId: "kyc_submitted",
				priority: "high",
				accepted: "Клиент отправил KYC-материалы.",
				pending: "Верификация ждёт результата.",
				reviewPath: "operator_or_external_kyc",
				context: "Заявка #42; media=document/video; raw contents omitted.",
				urgency: "high: KYC blocks payment requisites.",
				amount: "100000 RUB -> 40000 THB",
				rail: "card transfer",
				network: "TRC20",
				mediaCount: 2,
			},
		});
		expect(String(notifications[0]?.data.mediaSummary)).toContain("video_note");
		expect(String(notifications[0]?.data.mediaSummary)).toContain("7s");
		expect(String(notifications[0]?.data.mediaSummary)).toContain("passport.pdf");
		expect(String(notifications[0]?.data.mediaRefsJson)).toContain("doc1");
	});
});
