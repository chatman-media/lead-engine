/**
 * Integration test для concierge agentic tools (Фаза 2 — трекинг статуса гостем).
 * Прогоняет DB-путь против изолированной БД: tenantSupportsMultiRequest, listOpenRequests
 * и сам tool (resolve contactId из conversationId → открытые запросы).
 *
 * Без DATABASE_URL — мягкий skip (как прочие *.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import {
	applyAllMigrations,
	contacts,
	conversations,
	createIsolatedDb,
	leads,
	schema,
	stageDefinitions,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import {
	makeAwaitingOperatorResolver,
	makeRequestContextResolver,
} from "../llm-bootstrap.ts";
import { applyFunnelStages, SEED_TEMPLATES } from "../routes/admin-funnel.ts";
import { makeAuthRoutes } from "../routes/auth.ts";
import {
	CONCIERGE_CATALOG_KEY,
	type ConciergeCatalog,
	loadConciergeCatalog,
	makeConciergeDomainTools,
} from "./concierge-domain-tools.ts";
import {
	listOpenRequests,
	makeConciergeRequestsTool,
	tenantSupportsMultiRequest,
} from "./concierge-tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ctools_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"storage",
	"migrations",
);
const SECRET = "test-secret-concierge-tools-12345";
const MASTER_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const catalog: ConciergeCatalog = {
	transfer: {
		classes: [
			{
				id: "sedan",
				name: "Sedan",
				description: "Comfort car",
				capacity: 3,
				priceBase: 1200,
				currency: "THB",
			},
			{ id: "van", name: "Van", capacity: 6, priceBase: 1900, currency: "THB" },
		],
	},
	food: {
		menu: [
			{
				id: "pizza",
				name: "Pizza Margherita",
				price: 320,
				currency: "THB",
				category: "pizza",
			},
			{
				id: "rolls",
				name: "Salmon rolls",
				price: 280,
				currency: "THB",
				category: "sushi",
			},
			{
				id: "wine",
				name: "House wine",
				price: 450,
				currency: "THB",
				category: "drinks",
				available: false,
			},
		],
		deliveryFee: 50,
		currency: "THB",
		etaMinutes: 35,
	},
	housekeeping: {
		ratePerHour: 300,
		currency: "THB",
		minHours: 2,
		availableSlots: ["10:00", "14:00"],
	},
	tour: {
		options: [
			{
				id: "island",
				name: "Island tour",
				duration: "6h",
				pricePerPerson: 900,
				currency: "THB",
				minParticipants: 2,
				maxParticipants: 4,
			},
			{
				id: "city",
				name: "City walk",
				pricePerPerson: 450,
				currency: "THB",
				maxParticipants: 8,
			},
		],
	},
};

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let contactId = 0;
let conversationId = 0;
let baseNow = 0;

async function stageId(slug: string): Promise<number> {
	const [s] = await db
		.select({ id: stageDefinitions.id })
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.tenantId, tenantId),
				eq(stageDefinitions.slug, slug),
			),
		);
	if (!s) throw new Error(`stage not found: ${slug}`);
	return s.id;
}

beforeAll(async () => {
	if (!ownerUrl) return;
	const probe = await tryConnectToPg(ownerUrl);
	if (!probe) return;
	await probe.end({ timeout: 0 });

	const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
	sql = postgres(testUrl, { max: 2, onnotice: () => {} });
	await applyAllMigrations(sql, migrationsDir);
	db = drizzle(sql, { schema });

	app = new Hono();
	// biome-ignore lint/suspicious/noExplicitAny: drizzle generic in test harness
	app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
	const sa = await app.request("/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "ctools@demo.io",
			password: "strong-pwd-12345",
		}),
	});
	tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin
		.tenantId;

	const conciergeTemplate = SEED_TEMPLATES.concierge;
	if (!conciergeTemplate) throw new Error("concierge seed template missing");
	await applyFunnelStages(
		db as never,
		tenantId,
		conciergeTemplate,
		"concierge",
	);
	// Воронку НЕ помечаем concierge_v1: гейт теперь capability-based (intake имеет
	// поле request_type), от template id не зависит — это и проверяет тест ниже.

	const [c] = await db
		.insert(contacts)
		.values({ tenantId })
		.returning({ id: contacts.id });
	if (!c) throw new Error("contact insert returned no row");
	contactId = c.id;
	const [conv] = await db
		.insert(conversations)
		.values({ tenantId, userId: contactId, source: "bot" })
		.returning({ id: conversations.id });
	if (!conv) throw new Error("conversation insert returned no row");
	conversationId = conv.id;

	// Открытый запрос: трансфер на стадии transfer_request.
	const now = Math.floor(Date.parse("2026-06-06T00:00:00Z") / 1000);
	baseNow = now;
	await db.insert(leads).values({
		tenantId,
		userId: contactId,
		state: "transfer_request",
		stageDefinitionId: await stageId("transfer_request"),
		requestType: "transfer",
		createdAt: now,
		updatedAt: now,
	});

	await setEncryptedSecret({
		db: db as never,
		tenantId,
		key: CONCIERGE_CATALOG_KEY,
		value: JSON.stringify(catalog),
		masterKeyHex: MASTER_KEY,
		nowEpoch: now,
	});
}, 30_000);

afterAll(async () => {
	if (sql) {
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

describe("concierge tools (Фаза 2 — статус гостя)", () => {
	it("tenantSupportsMultiRequest = true для воронки с request_type на intake (без concierge_v1)", async () => {
		if (!sql) return;
		expect(await tenantSupportsMultiRequest(db as never, tenantId)).toBe(true);
	});

	it("tenantSupportsMultiRequest = false для линейной воронки (нет request_type на intake)", async () => {
		if (!sql) return;
		const sa = await app.request("/api/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "ctools-linear@demo.io",
				password: "strong-pwd-12345",
			}),
		});
		const t2 = ((await sa.json()) as { admin: { tenantId: number } }).admin
			.tenantId;
		const saasTemplate = SEED_TEMPLATES.saas;
		if (!saasTemplate) throw new Error("saas seed template missing");
		await applyFunnelStages(db as never, t2, saasTemplate, "saas");
		expect(await tenantSupportsMultiRequest(db as never, t2)).toBe(false);
	});

	it("listOpenRequests возвращает тип + человекочитаемую стадию", async () => {
		if (!sql) return;
		const reqs = await listOpenRequests({
			db: db as never,
			tenantId,
			contactId,
		});
		expect(reqs).toEqual([{ type: "Трансфер", stage: "Трансфер: детали" }]);
	});

	it("tool list_my_requests резолвит contactId из conversationId", async () => {
		if (!sql) return;
		const tool = makeConciergeRequestsTool({
			db: db as never,
			tenantId,
			conversationId,
		});
		const out = (await tool.execute({})) as {
			requests: Array<{ type: string; stage: string }>;
		};
		expect(out.requests).toEqual([
			{ type: "Трансфер", stage: "Трансфер: детали" },
		]);
	});

	it("терминальный запрос исключается из открытых", async () => {
		if (!sql) return;
		const completedId = await stageId("completed");
		const fresh = await db
			.insert(contacts)
			.values({ tenantId })
			.returning({ id: contacts.id });
		const freshContact = fresh.at(0);
		if (!freshContact) throw new Error("contact insert returned no row");
		const cid = freshContact.id;
		const now = Math.floor(Date.parse("2026-06-06T01:00:00Z") / 1000);
		await db.insert(leads).values({
			tenantId,
			userId: cid,
			state: "completed",
			stageDefinitionId: completedId,
			requestType: "food",
			createdAt: now,
			updatedAt: now,
		});
		const reqs = await listOpenRequests({
			db: db as never,
			tenantId,
			contactId: cid,
		});
		expect(reqs).toEqual([]);
	});
});

async function makeConversationFor(
	requestType: string,
	stageSlug: string,
): Promise<number> {
	const [c] = await db
		.insert(contacts)
		.values({ tenantId, createdAt: baseNow })
		.returning({ id: contacts.id });
	if (!c) throw new Error("contact insert returned no row");
	const [conv] = await db
		.insert(conversations)
		.values({
			tenantId,
			userId: c.id,
			source: "bot",
			mode: "ai",
			createdAt: baseNow,
			lastMessageAt: baseNow,
		})
		.returning({ id: conversations.id });
	await db.insert(leads).values({
		tenantId,
		userId: c.id,
		state: stageSlug,
		stageDefinitionId: await stageId(stageSlug),
		requestType,
		createdAt: baseNow,
		updatedAt: baseNow,
	});
	if (!conv) throw new Error("conversation insert returned no row");
	return conv.id;
}

function toolByName(
	tools: ReturnType<typeof makeConciergeDomainTools>,
	name: string,
) {
	const tool = tools.find((t) => t.name === name);
	expect(tool).toBeDefined();
	if (!tool) throw new Error(`tool not found: ${name}`);
	return tool;
}

describe("concierge domain tools (Фаза 3 — каталог и квоты)", () => {
	it("создаёт все 8 domain tools", () => {
		if (!sql) return;
		const names = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId,
			masterKeyHex: MASTER_KEY,
		}).map((t) => t.name);
		expect(names).toEqual([
			"get_transfer_options",
			"confirm_transfer_booking",
			"get_food_menu",
			"confirm_food_order",
			"get_housekeeping_options",
			"confirm_housekeeping_booking",
			"get_tour_options",
			"confirm_tour_booking",
		]);
	});

	it("transfer options фильтрует capacity и confirm возвращает summary", async () => {
		if (!sql) return;
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId,
			masterKeyHex: MASTER_KEY,
		});
		const options = (await toolByName(tools, "get_transfer_options").execute({
			pickup: "BKK",
			dropoff: "Pattaya",
			datetime: "tomorrow 10:00",
			passengers: 4,
		})) as { options: Array<{ id: string }>; pickup: string; dropoff: string };
		expect(options.options.map((o) => o.id)).toEqual(["van"]);
		expect(options.pickup).toBe("BKK");
		expect(options.dropoff).toBe("Pattaya");

		const confirmed = (await toolByName(
			tools,
			"confirm_transfer_booking",
		).execute({
			classId: "sedan",
			pickup: "BKK",
			dropoff: "Pattaya",
			datetime: "tomorrow 10:00",
			passengers: 2,
			notes: "child seat",
		})) as { ok: boolean; price: number; summary: string; nextStep: string };
		expect(confirmed.ok).toBe(true);
		expect(confirmed.price).toBe(1200);
		expect(confirmed.summary).toContain("Sedan");
		expect(confirmed.nextStep).toBe("needsOperator");
	});

	it("domain tools отказывают при несовпадении request_type", async () => {
		if (!sql) return;
		const foodConversationId = await makeConversationFor(
			"food",
			"food_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: foodConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const out = (await toolByName(tools, "get_transfer_options").execute(
			{},
		)) as { error?: string };
		expect(out.error).toContain("не применим");
	});

	it("food menu скрывает unavailable, фильтрует category и считает заказ", async () => {
		if (!sql) return;
		const foodConversationId = await makeConversationFor(
			"food",
			"food_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: foodConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const menu = (await toolByName(tools, "get_food_menu").execute({
			category: "pizza",
		})) as {
			items: Array<{ id: string }>;
			deliveryFee: number;
			etaMinutes: number;
		};
		expect(menu.items.map((i) => i.id)).toEqual(["pizza"]);
		expect(menu.deliveryFee).toBe(50);
		expect(menu.etaMinutes).toBe(35);

		const order = (await toolByName(tools, "confirm_food_order").execute({
			items: [
				{ id: "pizza", qty: 2 },
				{ id: "rolls", qty: 1 },
			],
			deliveryLocation: "Villa 12",
			notes: "no onion",
		})) as {
			ok: boolean;
			subtotal: number;
			total: number;
			lines: unknown[];
			deliveryLocation: string;
		};
		expect(order.ok).toBe(true);
		expect(order.subtotal).toBe(920);
		expect(order.total).toBe(970);
		expect(order.lines).toHaveLength(2);
		expect(order.deliveryLocation).toBe("Villa 12");
	});

	it("food confirm сообщает unknown ids", async () => {
		if (!sql) return;
		const foodConversationId = await makeConversationFor(
			"food",
			"food_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: foodConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const out = (await toolByName(tools, "confirm_food_order").execute({
			items: [{ id: "missing", qty: 1 }],
		})) as { error?: string };
		expect(out.error).toContain("missing");
	});

	it("housekeeping options даёт estimate, confirm применяет minHours", async () => {
		if (!sql) return;
		const hkConversationId = await makeConversationFor(
			"housekeeping",
			"housekeeping_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: hkConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const options = (await toolByName(
			tools,
			"get_housekeeping_options",
		).execute({
			date: "2026-06-10",
			hours: 3,
		})) as { estimate: { totalPrice: number }; availableSlots: string[] };
		expect(options.estimate.totalPrice).toBe(900);
		expect(options.availableSlots).toEqual(["10:00", "14:00"]);

		const booking = (await toolByName(
			tools,
			"confirm_housekeeping_booking",
		).execute({
			date: "2026-06-10",
			timeSlot: "10:00",
			hours: 1,
		})) as { ok: boolean; hours: number; total: number; summary: string };
		expect(booking.ok).toBe(true);
		expect(booking.hours).toBe(2);
		expect(booking.total).toBe(600);
		expect(booking.summary).toContain("10:00");
	});

	it("tour options фильтрует participants, confirm проверяет min/max", async () => {
		if (!sql) return;
		const tourConversationId = await makeConversationFor(
			"tour",
			"tour_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: tourConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const options = (await toolByName(tools, "get_tour_options").execute({
			participants: 3,
			date: "2026-06-11",
		})) as {
			options: Array<{ id: string; totalPrice: number }>;
			requestedDate: string;
		};
		expect(options.options.map((o) => o.id)).toEqual(["island", "city"]);
		expect(options.options.find((o) => o.id === "island")?.totalPrice).toBe(
			2700,
		);
		expect(options.requestedDate).toBe("2026-06-11");

		const tooFew = (await toolByName(tools, "confirm_tour_booking").execute({
			tourId: "island",
			date: "2026-06-11",
			participants: 1,
		})) as { error?: string };
		expect(tooFew.error).toContain("Минимальное");

		const booked = (await toolByName(tools, "confirm_tour_booking").execute({
			tourId: "island",
			date: "2026-06-11",
			participants: 3,
			notes: "English guide",
		})) as { ok: boolean; total: number; duration: string; notes: string };
		expect(booked.ok).toBe(true);
		expect(booked.total).toBe(2700);
		expect(booked.duration).toBe("6h");
		expect(booked.notes).toBe("English guide");
	});
});

describe("concierge domain tools — fallback-ветки", () => {
	async function signupTenant(email: string): Promise<number> {
		const sa = await app.request("/api/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "strong-pwd-12345" }),
		});
		return ((await sa.json()) as { admin: { tenantId: number } }).admin
			.tenantId;
	}

	async function makeBareConversation(forTenantId: number): Promise<number> {
		const [c] = await db
			.insert(contacts)
			.values({ tenantId: forTenantId })
			.returning({ id: contacts.id });
		if (!c) throw new Error("contact insert returned no row");
		const [conv] = await db
			.insert(conversations)
			.values({ tenantId: forTenantId, userId: c.id, source: "bot" })
			.returning({ id: conversations.id });
		if (!conv) throw new Error("conversation insert returned no row");
		return conv.id;
	}

	it("loadConciergeCatalog: нет секрета → null, битый JSON → null", async () => {
		if (!sql) return;
		const t = await signupTenant("ctools-broken-catalog@demo.io");
		expect(await loadConciergeCatalog(db as never, t, MASTER_KEY)).toBeNull();
		await setEncryptedSecret({
			db: db as never,
			tenantId: t,
			key: CONCIERGE_CATALOG_KEY,
			value: "{not valid json",
			masterKeyHex: MASTER_KEY,
			nowEpoch: baseNow,
		});
		expect(await loadConciergeCatalog(db as never, t, MASTER_KEY)).toBeNull();
	});

	it("каталог не настроен → все 8 инструментов отдают needsOperator", async () => {
		if (!sql) return;
		const t = await signupTenant("ctools-empty-catalog@demo.io");
		const convId = await makeBareConversation(t);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId: t,
			conversationId: convId,
			masterKeyHex: MASTER_KEY,
		});
		const calls: Array<[string, Record<string, unknown>]> = [
			["get_transfer_options", {}],
			[
				"confirm_transfer_booking",
				{
					classId: "sedan",
					pickup: "BKK",
					dropoff: "Kata",
					datetime: "tomorrow",
				},
			],
			["get_food_menu", {}],
			["confirm_food_order", { items: [{ id: "pizza", qty: 1 }] }],
			["get_housekeeping_options", {}],
			["confirm_housekeeping_booking", { date: "2026-06-12", hours: 2 }],
			["get_tour_options", {}],
			[
				"confirm_tour_booking",
				{ tourId: "island", date: "2026-06-12", participants: 2 },
			],
		];
		for (const [name, args] of calls) {
			const out = (await toolByName(tools, name).execute(args)) as {
				needsOperator?: boolean;
				note?: string;
			};
			expect(out.needsOperator).toBe(true);
			expect(out.note).toBeTruthy();
		}
	});

	it("food/housekeeping/tour инструменты отказывают на transfer-запросе", async () => {
		if (!sql) return;
		// Главный conversationId привязан к contact'у с открытым transfer-лидом.
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId,
			masterKeyHex: MASTER_KEY,
		});
		const calls: Array<[string, Record<string, unknown>]> = [
			["get_food_menu", {}],
			["confirm_food_order", { items: [{ id: "pizza", qty: 1 }] }],
			["get_housekeeping_options", {}],
			["confirm_housekeeping_booking", { date: "2026-06-12", hours: 2 }],
			["get_tour_options", {}],
			[
				"confirm_tour_booking",
				{ tourId: "island", date: "2026-06-12", participants: 2 },
			],
		];
		for (const [name, args] of calls) {
			const out = (await toolByName(tools, name).execute(args)) as {
				error?: string;
			};
			expect(out.error).toContain("не применим");
		}
	});

	it("confirm_transfer_booking отказывает на food-запросе", async () => {
		if (!sql) return;
		const foodConversationId = await makeConversationFor(
			"food",
			"food_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: foodConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const out = (await toolByName(tools, "confirm_transfer_booking").execute({
			classId: "sedan",
			pickup: "BKK",
			dropoff: "Kata",
			datetime: "tomorrow",
		})) as { error?: string };
		expect(out.error).toContain("не применим");
	});

	it("confirm_tour_booking: превышение maxParticipants и неизвестный тур", async () => {
		if (!sql) return;
		const tourConversationId = await makeConversationFor(
			"tour",
			"tour_request",
		);
		const tools = makeConciergeDomainTools({
			db: db as never,
			tenantId,
			conversationId: tourConversationId,
			masterKeyHex: MASTER_KEY,
		});
		const tooMany = (await toolByName(tools, "confirm_tour_booking").execute({
			tourId: "island",
			date: "2026-06-12",
			participants: 5,
		})) as { error?: string };
		expect(tooMany.error).toContain("Максимальное");

		const unknownTour = (await toolByName(
			tools,
			"confirm_tour_booking",
		).execute({
			tourId: "ghost-tour",
			date: "2026-06-12",
			participants: 2,
		})) as { needsOperator?: boolean };
		expect(unknownTour.needsOperator).toBe(true);
	});
});

describe("makeRequestContextResolver (R4 — request_type в промпт)", () => {
	it("1 открытый запрос → контекст с типом, без счётчика", async () => {
		if (!sql) return;
		const resolve = makeRequestContextResolver(db as never);
		const ctx = await resolve({ tenantId, contactId });
		expect(ctx).toContain("«Трансфер»");
		expect(ctx).not.toContain("Всего открытых");
	});

	it("несколько открытых → контекст со счётчиком", async () => {
		if (!sql) return;
		const [c] = await db
			.insert(contacts)
			.values({ tenantId })
			.returning({ id: contacts.id });
		if (!c) throw new Error("contact insert returned no row");
		const multiId = c.id;
		const now = Math.floor(Date.parse("2026-06-06T02:00:00Z") / 1000);
		await db.insert(leads).values([
			{
				tenantId,
				userId: multiId,
				state: "transfer_request",
				stageDefinitionId: await stageId("transfer_request"),
				requestType: "transfer",
				createdAt: now,
				updatedAt: now,
			},
			{
				tenantId,
				userId: multiId,
				state: "exchange_request",
				stageDefinitionId: await stageId("exchange_request"),
				requestType: "exchange",
				createdAt: now,
				updatedAt: now + 1,
			},
		]);
		const resolve = makeRequestContextResolver(db as never);
		const ctx = await resolve({ tenantId, contactId: multiId });
		expect(ctx).toContain("Всего открытых запросов у гостя: 2");
	});

	it("нет открытых (только терминальный) → null", async () => {
		if (!sql) return;
		const [c] = await db
			.insert(contacts)
			.values({ tenantId })
			.returning({ id: contacts.id });
		if (!c) throw new Error("contact insert returned no row");
		const doneId = c.id;
		const now = Math.floor(Date.parse("2026-06-06T03:00:00Z") / 1000);
		await db.insert(leads).values({
			tenantId,
			userId: doneId,
			state: "completed",
			stageDefinitionId: await stageId("completed"),
			requestType: "food",
			createdAt: now,
			updatedAt: now,
		});
		const resolve = makeRequestContextResolver(db as never);
		expect(await resolve({ tenantId, contactId: doneId })).toBe(null);
	});
});

describe("makeAwaitingOperatorResolver (R5)", () => {
	it("лид на обычной стадии → false", async () => {
		if (!sql) return;
		const resolve = makeAwaitingOperatorResolver(db as never);
		expect(await resolve({ tenantId, contactId })).toBe(false);
	});

	it("лид на awaiting_operator-стадии → true", async () => {
		if (!sql) return;
		// помечаем transfer_offer как awaiting_operator (как мог бы AI-билдер)
		const offerId = await stageId("transfer_offer");
		await db
			.update(stageDefinitions)
			.set({ stageType: "awaiting_operator" })
			.where(eq(stageDefinitions.id, offerId));
		const [c] = await db
			.insert(contacts)
			.values({ tenantId })
			.returning({ id: contacts.id });
		if (!c) throw new Error("contact insert returned no row");
		const opId = c.id;
		const now = Math.floor(Date.parse("2026-06-06T04:00:00Z") / 1000);
		await db.insert(leads).values({
			tenantId,
			userId: opId,
			state: "transfer_offer",
			stageDefinitionId: offerId,
			requestType: "transfer",
			createdAt: now,
			updatedAt: now,
		});
		const resolve = makeAwaitingOperatorResolver(db as never);
		expect(await resolve({ tenantId, contactId: opId })).toBe(true);
	});
});
