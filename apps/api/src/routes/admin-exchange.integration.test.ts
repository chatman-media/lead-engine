import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
	setEncryptedSecret,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	applyAllMigrations,
	channelIdentities,
	channels,
	contacts,
	conversations,
	createIsolatedDb,
	exchangeOrders,
	outboundQueue,
	schema,
	tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { getTenantRefreshSec } from "../lib/exchange/rate-feed.ts";
import { makeExchangeTools } from "../lib/exchange/tools.ts";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminExchangeRoutes } from "./admin-exchange.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_admin_exchange_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-admin-exchange-12345";
const MASTER_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantA = 0;
let tokenB = "";
let tenantB = 0;
let reloadCalls: number[] = [];
let conversationIdA = 0;

interface ToolResult {
	[key: string]: unknown;
}

const MOCK_RATE_CARD = [
	{
		asset: "RUB",
		network: "",
		quoteMode: "divide",
		marketRate: 2.55,
		tiers: [
			{
				minThb: 2_000,
				maxThb: 3_000,
				displayRate: 2.64,
				deviationPct: 3.5294,
				formula: "market + 3.5294%",
			},
			{
				minThb: 3_000,
				maxThb: 7_000,
				displayRate: 2.59,
				deviationPct: 1.5686,
				formula: "market + 1.5686%",
			},
			{
				minThb: 7_000,
				maxThb: 20_000,
				displayRate: 2.52,
				deviationPct: -1.1765,
				formula: "market - 1.1765%",
			},
		],
	},
	{
		asset: "USDT",
		network: "trc20",
		quoteMode: "multiply",
		marketRate: 31.5,
		tiers: [
			{
				minThb: 2_000,
				maxThb: 10_000,
				displayRate: 31.35,
				deviationPct: -0.4762,
				formula: "market - 0.4762%",
			},
			{
				minThb: 10_000,
				maxThb: 100_000,
				displayRate: 31.45,
				deviationPct: -0.1587,
				formula: "market - 0.1587%",
			},
		],
	},
];

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined)
		throw new Error(`Missing ${label}`);
	return value;
}

async function authReq(
	token: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return app.request(path, {
		...init,
		headers: {
			...(init.headers ?? {}),
			Authorization: `Bearer ${token}`,
		},
	});
}

async function postJson(token: string, path: string, body: unknown) {
	return authReq(token, path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function patchJson(token: string, path: string, body: unknown) {
	return authReq(token, path, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function createVerifiedConversation(tenantId: number): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	return withTenant(db, tenantId, async (tx) => {
		const [channel] = await tx
			.insert(channels)
			.values({
				tenantId,
				kind: "telegram_bot",
				externalId: `exchange-admin-${tenantId}`,
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: channels.id });
		const [contact] = await tx
			.insert(contacts)
			.values({
				tenantId,
				displayName: "Mock Exchange Client",
				attributesJson: JSON.stringify({
					exchangeKyc: {
						status: "verified",
						verificationId: "crm-verify-admin-e2e",
					},
				}),
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: contacts.id });
		const [conversation] = await tx
			.insert(conversations)
			.values({
				tenantId,
				userId: must(contact, "contact").id,
				source: "bot",
				mode: "ai",
				createdAt: now,
				lastMessageAt: now,
			})
			.returning({ id: conversations.id });
		await tx.insert(channelIdentities).values({
			contactId: must(contact, "contact").id,
			channelId: must(channel, "channel").id,
			externalUserId: "tg-admin-exchange-e2e",
			createdAt: now,
		});
		return must(conversation, "conversation").id;
	});
}

async function createRubOrderThroughTools() {
	const tools = Object.fromEntries(
		makeExchangeTools({
			db,
			tenantId: tenantA,
			conversationId: conversationIdA,
			masterKeyHex: MASTER_KEY,
		}).map((tool) => [tool.name, tool]),
	);
	const quote = (await must(
		tools.compute_exchange_quote,
		"compute_exchange_quote",
	).execute({
		asset: "RUB",
		amount: 10_000,
		amountMode: "target_thb",
	})) as ToolResult;
	expect(quote.rate).toBe(2.52);
	expect(quote.amountToThb).toBe(10_000);

	const created = (await must(
		tools.create_exchange_order,
		"create_exchange_order",
	).execute({
		asset: "RUB",
		amount: 10_000,
		amountMode: "target_thb",
		paymentMethod: "sbp_qr",
		paymentRail: "sbp",
		sourceBank: "T-Bank",
		payoutMethod: "cardless_atm",
		payoutLocation: "SCB ATM",
		payoutDestination: { atmBank: "SCB" },
	})) as ToolResult;
	expect(created.status).toBe("awaiting_payment");
	expect(typeof created.orderId).toBe("number");

	const requisites = (await must(
		tools.fetch_exchange_requisites,
		"fetch_exchange_requisites",
	).execute({})) as ToolResult;
	expect(requisites.kind).toBe("fiat");
	expect(requisites.paymentUrl).toBe("https://mock.local/sbp/admin-e2e");

	const proof = (await must(
		tools.verify_exchange_payment,
		"verify_exchange_payment",
	).execute({
		proof: "mock admin route receipt",
		sourceBank: "T-Bank",
		receiptAmount: created.amountFrom,
		payerName: "Mock Route Payer",
		paymentReference: "route-ref-001",
	})) as ToolResult;
	expect(proof.needsOperator).toBe(true);

	return created.orderId as number;
}

beforeAll(async () => {
	if (!ownerUrl) return;
	const probe = await tryConnectToPg(ownerUrl);
	if (!probe) return;
	await probe.end({ timeout: 0 });

	const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
	sql = postgres(testUrl, { max: 3, onnotice: () => {} });
	await applyAllMigrations(sql, migrationsDir);
	db = drizzle(sql, { schema });

	app = new Hono();
	app.route("/", makeAuthRoutes({ db: db as never, secret: SECRET }));
	app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
	app.route(
		"/",
		makeAdminExchangeRoutes({
			db,
			masterKeyHex: MASTER_KEY,
			onReload: (tenantId) => reloadCalls.push(tenantId),
		}),
	);

	const signupA = await app.request("/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "exchange-a@demo.io",
			password: "strong-pwd-12345",
		}),
	});
	const bodyA = (await signupA.json()) as {
		token: string;
		admin: { tenantId: number };
	};
	tokenA = bodyA.token;
	tenantA = bodyA.admin.tenantId;

	const signupB = await app.request("/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "exchange-b@demo.io",
			password: "strong-pwd-12345",
		}),
	});
	const bodyB = (await signupB.json()) as {
		token: string;
		admin: { tenantId: number };
	};
	tokenB = bodyB.token;
	tenantB = bodyB.admin.tenantId;
	conversationIdA = await createVerifiedConversation(tenantA);

	await setEncryptedSecret({
		db,
		tenantId: tenantA,
		key: "exchange_wallet_usdt_trc20",
		value: "TMockAdminExchangeWallet11111111111111",
		masterKeyHex: MASTER_KEY,
		nowEpoch: Math.floor(Date.now() / 1000),
	});
}, 30_000);

afterAll(async () => {
	if (sql) {
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

describe("admin-exchange routes", () => {
	it("requires auth for admin endpoints", async () => {
		if (!sql) return;
		const res = await app.request("/api/admin/exchange/orders");
		expect(res.status).toBe(401);
	});

	it("approves mocked rate-card and reloads exchange tools", async () => {
		if (!sql) return;
		reloadCalls = [];
		const res = await postJson(
			tokenA,
			"/api/admin/exchange/rate-card/approve",
			{
				proposals: MOCK_RATE_CARD,
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; message: string };
		expect(body.ok).toBe(true);
		expect(body.message).toContain("АКТУАЛЬНЫЙ КУРС");
		expect(reloadCalls).toEqual([tenantA]);

		const ratesRes = await authReq(tokenA, "/api/admin/exchange/rates");
		const ratesBody = (await ratesRes.json()) as {
			rates: Array<{ asset: string; baseRate: number; quoteMode: string }>;
		};
		expect(ratesBody.rates.map((rate) => rate.asset).sort()).toEqual([
			"RUB",
			"USDT",
		]);
		expect(
			ratesBody.rates.find((rate) => rate.asset === "RUB")?.quoteMode,
		).toBe("divide");
	});

	it("stores mocked requisites and creates a full exchange order through tools", async () => {
		if (!sql) return;
		for (const [key, value] of [
			["exchange_fiat_payment_url", "https://mock.local/sbp/admin-e2e"],
			["exchange_binance_id", "66775963"],
			["exchange_rub_card_requisites", "💳 ADMIN MOCK RUB CARD"],
		]) {
			const res = await postJson(tokenA, "/api/admin/exchange/requisites", {
				key,
				value,
			});
			expect(res.status).toBe(200);
		}

		const bad = await postJson(tokenA, "/api/admin/exchange/requisites", {
			key: "plain_secret",
			value: "x",
		});
		expect(bad.status).toBe(400);

		const orderId = await createRubOrderThroughTools();
		const listRes = await authReq(tokenA, "/api/admin/exchange/orders");
		const listBody = (await listRes.json()) as {
			orders: Array<{
				id: number;
				status: string;
				amountMode: string;
				paymentMethod: string;
				payoutMethod: string;
				proofJson: string | null;
				workflowStage: { slug: string; label: string };
			}>;
		};
		expect(listBody.orders).toHaveLength(1);
		expect(listBody.orders[0]?.id).toBe(orderId);
		expect(listBody.orders[0]?.amountMode).toBe("target_thb");
		expect(listBody.orders[0]?.paymentMethod).toBe("sbp_qr");
		expect(listBody.orders[0]?.payoutMethod).toBe("cardless_atm");
		expect(listBody.orders[0]?.proofJson).toContain("fiat_receipt");
		expect(listBody.orders[0]?.workflowStage).toEqual({
			slug: "payment_verified",
			label: "Проверка чека",
		});
	});

	it("patches operator fields and counts completed turnover", async () => {
		if (!sql) return;
		const [row] = await withTenant(db, tenantA, (tx) =>
			tx
				.select({ id: exchangeOrders.id })
				.from(exchangeOrders)
				.where(eq(exchangeOrders.tenantId, tenantA))
				.limit(1),
		);
		const orderId = must(row, "exchange order").id;

		const patchRes = await patchJson(
			tokenA,
			`/api/admin/exchange/orders/${orderId}`,
			{
				status: "completed",
				payoutCode: "ATM-CODE-123",
				sourceBank: "T-Bank",
				payerName: "Route Payer",
				thirdPartyApproved: true,
			},
		);
		expect(patchRes.status).toBe(200);
		const patchBody = (await patchRes.json()) as {
			order: {
				status: string;
				payoutCode: string;
				completedAt: number | null;
				thirdPartyApproved: boolean;
				workflowStage: { slug: string; label: string };
			};
		};
		expect(patchBody.order.status).toBe("completed");
		expect(patchBody.order.payoutCode).toBe("ATM-CODE-123");
		expect(patchBody.order.completedAt).toBeGreaterThan(0);
		expect(patchBody.order.thirdPartyApproved).toBe(true);
		expect(patchBody.order.workflowStage).toEqual({
			slug: "payout_or_completion",
			label: "Выдача / Завершено",
		});

		const turnoverRes = await authReq(tokenA, "/api/admin/exchange/turnover");
		const turnover = (await turnoverRes.json()) as {
			totals: { completedCount: number; openCount: number; totalThb: number };
			byContact: Array<{ orders: number; totalThb: number }>;
		};
		expect(Number(turnover.totals.completedCount)).toBe(1);
		expect(Number(turnover.totals.openCount)).toBe(0);
		expect(Number(turnover.totals.totalThb)).toBe(10_000);
		expect(Number(turnover.byContact[0]?.totalThb)).toBe(10_000);
	});

	it("issue-payout-code generates a code, sets TTL and delivers to client", async () => {
		if (!sql) return;
		const [row] = await withTenant(db, tenantA, (tx) =>
			tx
				.select({ id: exchangeOrders.id })
				.from(exchangeOrders)
				.where(eq(exchangeOrders.tenantId, tenantA))
				.limit(1),
		);
		const orderId = must(row, "exchange order").id;

		const nowSec = Math.floor(Date.now() / 1000);
		const res = await postJson(
			tokenA,
			`/api/admin/exchange/orders/${orderId}/issue-payout-code`,
			{ generate: true, ttlMinutes: 30, payoutLocation: "Bangtao office" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			payoutCode: string;
			expiresAt: number | null;
			delivered: boolean;
			order: { payoutCode: string; payoutCodeExpiresAt: number | null };
		};
		expect(body.ok).toBe(true);
		expect(body.payoutCode).toMatch(/^CODE-/);
		expect(body.expiresAt ?? 0).toBeGreaterThan(nowSec);
		expect(body.order.payoutCode).toBe(body.payoutCode);
		expect(body.order.payoutCodeExpiresAt).toBe(body.expiresAt);
		// Доставка без поллинга: сообщение поставлено в outbound_queue.
		expect(body.delivered).toBe(true);
		const ob = await withTenant(db, tenantA, (tx) =>
			tx
				.select({ key: outboundQueue.idempotencyKey })
				.from(outboundQueue)
				.where(eq(outboundQueue.tenantId, tenantA)),
		);
		expect(
			ob.some((r) => String(r.key).startsWith(`exch-payout-code-${orderId}`)),
		).toBe(true);

		// Требуется код или generate:true.
		const bad = await postJson(
			tokenA,
			`/api/admin/exchange/orders/${orderId}/issue-payout-code`,
			{},
		);
		expect(bad.status).toBe(400);
	});

	it("keeps exchange CRM isolated by tenant", async () => {
		if (!sql) return;
		expect(tenantA).not.toBe(tenantB);

		const listB = await authReq(tokenB, "/api/admin/exchange/orders");
		const bodyB = (await listB.json()) as { orders: unknown[] };
		expect(bodyB.orders).toHaveLength(0);

		const [row] = await withTenant(db, tenantA, (tx) =>
			tx
				.select({ id: exchangeOrders.id })
				.from(exchangeOrders)
				.where(eq(exchangeOrders.tenantId, tenantA))
				.limit(1),
		);
		const orderId = must(row, "exchange order").id;
		const getFromB = await authReq(
			tokenB,
			`/api/admin/exchange/orders/${orderId}`,
		);
		expect(getFromB.status).toBe(404);
	});

	it("rejects invalid order status patch", async () => {
		if (!sql) return;
		const [row] = await withTenant(db, tenantA, (tx) =>
			tx
				.select({ id: exchangeOrders.id })
				.from(exchangeOrders)
				.where(and(eq(exchangeOrders.tenantId, tenantA)))
				.limit(1),
		);
		const orderId = must(row, "exchange order").id;
		const res = await patchJson(
			tokenA,
			`/api/admin/exchange/orders/${orderId}`,
			{
				status: "money_disappeared",
			},
		);
		expect(res.status).toBe(400);
	});
});

describe("admin-exchange settings (per-tenant частота/порог)", () => {
	it("GET по умолчанию → 180с / null", async () => {
		if (!sql) return;
		const res = await authReq(tokenA, "/api/admin/exchange/settings");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			rateRefreshSec: number;
			feedStaleSec: number | null;
		};
		expect(body.rateRefreshSec).toBe(180);
		expect(body.feedStaleSec).toBe(null);
	});

	it("PUT валидные → сохраняет; GET и планировщик видят", async () => {
		if (!sql) return;
		const put = await authReq(tokenA, "/api/admin/exchange/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rateRefreshSec: 600, feedStaleSec: 1800 }),
		});
		expect(put.status).toBe(200);
		const got = (await (
			await authReq(tokenA, "/api/admin/exchange/settings")
		).json()) as { rateRefreshSec: number; feedStaleSec: number | null };
		expect(got.rateRefreshSec).toBe(600);
		expect(got.feedStaleSec).toBe(1800);
		// планировщик читает то же значение
		expect(await getTenantRefreshSec(db as never, tenantA, 180)).toBe(600);
	});

	it("PUT невалидные → 400 (частота < 60 / stale < refresh)", async () => {
		if (!sql) return;
		const tooFast = await authReq(tokenA, "/api/admin/exchange/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rateRefreshSec: 30 }),
		});
		expect(tooFast.status).toBe(400);
		const badStale = await authReq(tokenA, "/api/admin/exchange/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rateRefreshSec: 600, feedStaleSec: 120 }),
		});
		expect(badStale.status).toBe(400);
	});
});
