/**
 * runDeferredInboundPostProcessing — отложенный stage-classifier + memory
 * extractor поверх реального Postgres (RLS-снапшоты через withTenant).
 * Требует DATABASE_URL; без него — graceful-skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FunnelStage } from "@chatman-media/kb";
import {
	applyAllMigrations,
	createIsolatedDb,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type { MessageRow } from "./dal/messages.ts";
import { runDeferredInboundPostProcessing } from "./deferred-post-processing.ts";
import type { MemoryExtractor } from "./memory-extractor.ts";
import type { StageClassifier } from "./stage-classifier.ts";
import type {
	PipelineSink,
	ProcessInboundResult,
	TenantContext,
} from "./types.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_test_conv1_deferred_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"storage",
	"migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantWithFunnel = 0;
let tenantNoFunnel = 0;

beforeAll(async () => {
	if (!ownerUrl) return;
	const probe = await tryConnectToPg(ownerUrl);
	if (!probe) return;
	await probe.end({ timeout: 0 }).catch(() => {});
	sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
		max: 3,
		onnotice: () => {},
	});
	await applyAllMigrations(sql, migrationsDir);
	db = drizzle(sql, { schema });
	enabled = true;
	n = Math.floor(Date.now() / 1000);

	const [a] = await db
		.insert(schema.tenants)
		.values({ slug: `dpp-a-${n}` })
		.returning({ id: schema.tenants.id });
	tenantWithFunnel = a!.id;
	const [b] = await db
		.insert(schema.tenants)
		.values({ slug: `dpp-b-${n}` })
		.returning({ id: schema.tenants.id });
	tenantNoFunnel = b!.id;

	const [f] = await db
		.insert(schema.funnels)
		.values({
			tenantId: tenantWithFunnel,
			slug: "main",
			isActive: true,
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: schema.funnels.id });
	const fid = f!.id;
	const mkStage = (
		slug: string,
		kind: string,
		phase: string | null,
		position: number,
	) =>
		db.insert(schema.stageDefinitions).values({
			tenantId: tenantWithFunnel,
			funnelId: fid,
			slug,
			displayName: slug,
			kind,
			stageType: "form_fill",
			...(phase ? { phase } : {}),
			position,
			nextStages: [],
			createdAt: n,
			updatedAt: n,
		});
	await mkStage("intake", "intake", null, 0);
	await mkStage("qual", "active", "qualify", 1);
	await mkStage("offer", "active", "offer", 2);
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

// ── Хелперы ────────────────────────────────────────────────────────────────

function tenantCtx(tenantId: number): TenantContext {
	return { tenantId, slug: `t-${tenantId}`, llmBillingMode: "byok" };
}

async function freshContact(
	tenantId: number,
	attributesJson?: string | null,
): Promise<number> {
	const [c] = await db
		.insert(schema.contacts)
		.values({
			tenantId,
			displayName: `c-${Math.random().toString(36).slice(2, 8)}`,
			...(attributesJson !== undefined ? { attributesJson } : {}),
			createdAt: n,
			updatedAt: n,
		})
		.returning({ id: schema.contacts.id });
	return c!.id;
}

async function freshConversation(
	tenantId: number,
	contactId: number,
	currentStage: string | null = null,
): Promise<number> {
	const [conv] = await db
		.insert(schema.conversations)
		.values({
			tenantId,
			userId: contactId,
			source: "bot",
			...(currentStage ? { currentStage } : {}),
			createdAt: n,
		})
		.returning({ id: schema.conversations.id });
	return conv!.id;
}

async function insertMessage(
	tenantId: number,
	conversationId: number,
	role: "user" | "assistant",
	text: string,
	createdAt: number,
): Promise<void> {
	await db.insert(schema.messages).values({
		tenantId,
		conversationId,
		role,
		text,
		createdAt,
	});
}

async function currentStageOf(conversationId: number): Promise<string | null> {
	const [row] = await db
		.select({ stage: schema.conversations.currentStage })
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId));
	return row?.stage ?? null;
}

async function contactAttrs(
	contactId: number,
): Promise<Record<string, unknown>> {
	const [row] = await db
		.select({ attrs: schema.contacts.attributesJson })
		.from(schema.contacts)
		.where(eq(schema.contacts.id, contactId));
	return row?.attrs ? (JSON.parse(row.attrs) as Record<string, unknown>) : {};
}

interface LogEntry {
	level: string;
	msg: string;
	meta?: Record<string, unknown>;
}

function makeSink() {
	const logs: LogEntry[] = [];
	const sink: PipelineSink = {
		log: (level, msg, meta) => {
			logs.push({ level, msg, meta });
		},
	};
	return { logs, sink };
}

function makeClassifier(
	impl: (input: {
		tenantId: number;
		userMessageText: string;
		previousStage: string | null;
		isFirstUserMessage: boolean;
	}) => FunnelStage | null | Promise<FunnelStage | null>,
) {
	const calls: Array<Record<string, unknown>> = [];
	const classifier: StageClassifier = {
		classify: async (input) => {
			calls.push({ ...input });
			return impl(input);
		},
	};
	return { calls, classifier };
}

function makeExtractor(
	impl: (input: {
		existingFacts: Record<string, string>;
		history?: MessageRow[];
	}) => Record<string, string> | Promise<Record<string, string>>,
	historyLimit?: number,
) {
	const calls: Array<{
		existingFacts: Record<string, string>;
		history?: MessageRow[];
	}> = [];
	const extractor: MemoryExtractor = {
		...(historyLimit !== undefined ? { historyLimit } : {}),
		extract: async (input) => {
			calls.push({
				existingFacts: input.existingFacts,
				history: input.history,
			});
			return impl(input);
		},
	};
	return { calls, extractor };
}

function makeResult(
	overrides: Partial<ProcessInboundResult> & {
		contactId: number;
		conversationId: number;
	},
): ProcessInboundResult {
	return {
		persisted: true,
		outboundEnqueued: 0,
		userMessageText: "хочу обменять 100к",
		...overrides,
	};
}

// ── Тесты ──────────────────────────────────────────────────────────────────

describe("runDeferredInboundPostProcessing: early returns", () => {
	it("persisted=false → классификатор и extractor не вызываются", async () => {
		if (!enabled) return;
		const { calls, classifier } = makeClassifier(() => "qualify");
		const { calls: exCalls, extractor } = makeExtractor(() => ({}));
		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId: 1, conversationId: 1, persisted: false }),
			stageClassifier: classifier,
			memoryExtractor: extractor,
		});
		expect(calls).toEqual([]);
		expect(exCalls).toEqual([]);
	});

	it("пустой текст → no-op", async () => {
		if (!enabled) return;
		const { calls, classifier } = makeClassifier(() => "qualify");
		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({
				contactId: 1,
				conversationId: 1,
				userMessageText: "",
			}),
			stageClassifier: classifier,
		});
		expect(calls).toEqual([]);
	});

	it("userMessageText не задан → no-op", async () => {
		if (!enabled) return;
		const { calls, classifier } = makeClassifier(() => "qualify");
		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({
				contactId: 1,
				conversationId: 1,
				userMessageText: undefined,
			}),
			stageClassifier: classifier,
		});
		expect(calls).toEqual([]);
	});

	it("без classifier и extractor завершается без ошибок (системный clock)", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
		});
		expect(await currentStageOf(conversationId)).toBeNull();
	});
});

describe("runDeferredInboundPostProcessing: stage classification", () => {
	it("классифицированная стадия пишется в conversation + debug-лог", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(
			tenantWithFunnel,
			contactId,
			"opener",
		);
		const { logs, sink } = makeSink();
		const { calls, classifier } = makeClassifier(() => "qualify");

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({
				contactId,
				conversationId,
				previousStage: "opener",
				conversationCreated: false,
			}),
			stageClassifier: classifier,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(calls[0]).toMatchObject({
			tenantId: tenantWithFunnel,
			userMessageText: "хочу обменять 100к",
			previousStage: "opener",
			isFirstUserMessage: false,
		});
		expect(await currentStageOf(conversationId)).toBe("qualify");
		expect(logs).toContainEqual({
			level: "debug",
			msg: "conversation stage classified",
			meta: {
				tenantId: tenantWithFunnel,
				conversationId,
				from: "opener",
				to: "qualify",
			},
		});
		// advanceLead не запрошен → лид не создаётся
		const leads = await db
			.select({ id: schema.leads.id })
			.from(schema.leads)
			.where(
				and(
					eq(schema.leads.tenantId, tenantWithFunnel),
					eq(schema.leads.userId, contactId),
				),
			);
		expect(leads).toEqual([]);
	});

	it("той же стадии → без UPDATE и без лога", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(
			tenantWithFunnel,
			contactId,
			"qualify",
		);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => "qualify");

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({
				contactId,
				conversationId,
				previousStage: "qualify",
			}),
			stageClassifier: classifier,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(logs).toEqual([]);
		expect(await currentStageOf(conversationId)).toBe("qualify");
	});

	it("classifier вернул null → ничего не меняется", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => null);

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			stageClassifier: classifier,
			advanceLead: true,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(logs).toEqual([]);
		expect(await currentStageOf(conversationId)).toBeNull();
	});

	it("advanceLead: создание лида логируется как lead auto-created", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => "qualify");

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			stageClassifier: classifier,
			advanceLead: true,
			sink,
			clock: { nowEpoch: () => n },
		});

		const created = logs.find((l) => l.msg === "lead auto-created");
		expect(created).toBeDefined();
		expect(created?.level).toBe("info");
		expect(created?.meta).toMatchObject({
			tenantId: tenantWithFunnel,
			conversationId,
			contactId,
			stage: "qual",
			salesStage: "qualify",
		});
		const [lead] = await db
			.select({ id: schema.leads.id })
			.from(schema.leads)
			.where(
				and(
					eq(schema.leads.tenantId, tenantWithFunnel),
					eq(schema.leads.userId, contactId),
				),
			);
		expect(lead).toBeDefined();
	});

	it("advanceLead: продвижение существующего лида → lead advanced", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { classifier: first } = makeClassifier(() => "qualify");
		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			stageClassifier: first,
			advanceLead: true,
			clock: { nowEpoch: () => n },
		});

		const { logs, sink } = makeSink();
		const { classifier: second } = makeClassifier(() => "pitch");
		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({
				contactId,
				conversationId,
				previousStage: "qualify",
			}),
			stageClassifier: second,
			advanceLead: true,
			sink,
			clock: { nowEpoch: () => n },
		});

		const advanced = logs.find((l) => l.msg === "lead advanced");
		expect(advanced).toBeDefined();
		expect(advanced?.meta).toMatchObject({
			stage: "offer",
			salesStage: "pitch",
		});
	});

	it("advanceLead: без активной воронки результат null → лог не пишется", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantNoFunnel);
		const conversationId = await freshConversation(tenantNoFunnel, contactId);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => "qualify");

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantNoFunnel),
			result: makeResult({ contactId, conversationId }),
			stageClassifier: classifier,
			advanceLead: true,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(await currentStageOf(conversationId)).toBe("qualify");
		expect(logs.filter((l) => l.msg.startsWith("lead "))).toEqual([]);
	});

	it("advanceLead: стадия opener не двигает лид", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => "opener");

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			stageClassifier: classifier,
			advanceLead: true,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(await currentStageOf(conversationId)).toBe("opener");
		expect(logs.filter((l) => l.msg.startsWith("lead "))).toEqual([]);
		const leads = await db
			.select({ id: schema.leads.id })
			.from(schema.leads)
			.where(
				and(
					eq(schema.leads.tenantId, tenantWithFunnel),
					eq(schema.leads.userId, contactId),
				),
			);
		expect(leads).toEqual([]);
	});

	it("ошибка lead-advance ловится warn-логом lead auto-advance failed", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => "qualify");

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			// contactId без contact-строки → FK violation внутри lead-advance
			result: makeResult({ contactId: 99_999_999, conversationId }),
			stageClassifier: classifier,
			advanceLead: true,
			sink,
			clock: { nowEpoch: () => n },
		});

		const warn = logs.find((l) => l.msg === "lead auto-advance failed");
		expect(warn).toBeDefined();
		expect(warn?.level).toBe("warn");
		expect(warn?.meta).toMatchObject({
			tenantId: tenantWithFunnel,
			conversationId,
		});
		expect(typeof warn?.meta?.error).toBe("string");
	});

	it("исключение классификатора → warn stage classifier failed", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { classifier } = makeClassifier(() => {
			throw new Error("llm exploded");
		});

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			stageClassifier: classifier,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(logs).toContainEqual({
			level: "warn",
			msg: "stage classifier failed",
			meta: {
				tenantId: tenantWithFunnel,
				conversationId,
				error: "llm exploded",
			},
		});
		expect(await currentStageOf(conversationId)).toBeNull();
	});
});

describe("runDeferredInboundPostProcessing: memory extraction", () => {
	it("контакт не найден → extractor не вызывается", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { calls, extractor } = makeExtractor(() => ({ city: "BKK" }));

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId: 99_999_999, conversationId }),
			memoryExtractor: extractor,
			clock: { nowEpoch: () => n },
		});

		expect(calls).toEqual([]);
	});

	it("существующие string-факты и история передаются extractor'у", async () => {
		if (!enabled) return;
		const contactId = await freshContact(
			tenantWithFunnel,
			JSON.stringify({ city: "Bangkok", age: 33, nested: { a: 1 } }),
		);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		await insertMessage(tenantWithFunnel, conversationId, "user", "привет", n);
		await insertMessage(
			tenantWithFunnel,
			conversationId,
			"assistant",
			"здравствуйте",
			n + 1,
		);
		const { calls, extractor } = makeExtractor(() => ({}), 5);

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			memoryExtractor: extractor,
			clock: { nowEpoch: () => n },
		});

		expect(calls).toHaveLength(1);
		// не-строковые значения отфильтрованы
		expect(calls[0]?.existingFacts).toEqual({ city: "Bangkok" });
		expect(calls[0]?.history?.map((m) => [m.role, m.text])).toEqual([
			["user", "привет"],
			["assistant", "здравствуйте"],
		]);
	});

	it("пустой результат extract → атрибуты не меняются, лог не пишется", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel, null);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { calls, extractor } = makeExtractor(() => ({}));

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			memoryExtractor: extractor,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.existingFacts).toEqual({});
		expect(await contactAttrs(contactId)).toEqual({});
		expect(logs).toEqual([]);
	});

	it("извлечённые факты merge'атся в attributes_json + debug-лог", async () => {
		if (!enabled) return;
		const contactId = await freshContact(
			tenantWithFunnel,
			JSON.stringify({ city: "Bangkok" }),
		);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { extractor } = makeExtractor(() => ({
			budget: "100000 RUB",
			city: "Phuket",
		}));

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			memoryExtractor: extractor,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(await contactAttrs(contactId)).toEqual({
			city: "Phuket",
			budget: "100000 RUB",
		});
		expect(logs).toContainEqual({
			level: "debug",
			msg: "memory facts extracted",
			meta: {
				tenantId: tenantWithFunnel,
				conversationId,
				keys: ["budget", "city"],
			},
		});
	});

	it("исключение extractor'а → warn memory extractor failed", async () => {
		if (!enabled) return;
		const contactId = await freshContact(tenantWithFunnel);
		const conversationId = await freshConversation(tenantWithFunnel, contactId);
		const { logs, sink } = makeSink();
		const { extractor } = makeExtractor(() => {
			throw new Error("extractor exploded");
		});

		await runDeferredInboundPostProcessing({
			db,
			tenant: tenantCtx(tenantWithFunnel),
			result: makeResult({ contactId, conversationId }),
			memoryExtractor: extractor,
			sink,
			clock: { nowEpoch: () => n },
		});

		expect(logs).toContainEqual({
			level: "warn",
			msg: "memory extractor failed",
			meta: {
				tenantId: tenantWithFunnel,
				conversationId,
				error: "extractor exploded",
			},
		});
	});
});
