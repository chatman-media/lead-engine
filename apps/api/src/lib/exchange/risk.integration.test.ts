import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { withTenant } from "@chatman-media/conversation-engine";
import {
	applyAllMigrations,
	channelIdentities,
	channels,
	contacts,
	conversations,
	createIsolatedDb,
	exchangeOrders,
	schema,
	tenants,
	tryConnectToPg,
} from "@chatman-media/storage";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { assessOrderRisk, findOpenOrderId, screenSenderAddress } from "./risk.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exchange_risk_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"packages",
	"storage",
	"migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let tenantId = 0;
let suffix = 0;

async function createConversationFixture(): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	suffix += 1;
	return withTenant(db, tenantId, async (tx) => {
		const [channel] = await tx
			.insert(channels)
			.values({
				tenantId,
				kind: "telegram_bot",
				externalId: `exchange-risk-${suffix}`,
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: channels.id });
		const [contact] = await tx
			.insert(contacts)
			.values({
				tenantId,
				displayName: `Risk Client ${suffix}`,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: contacts.id });
		const [conversation] = await tx
			.insert(conversations)
			.values({
				tenantId,
				userId: contact!.id,
				source: "bot",
				mode: "ai",
				createdAt: now,
				lastMessageAt: now,
			})
			.returning({ id: conversations.id });
		await tx.insert(channelIdentities).values({
			contactId: contact!.id,
			channelId: channel!.id,
			externalUserId: `risk-client-${suffix}`,
			createdAt: now,
		});
		return conversation!.id;
	});
}

async function insertOrder(conversationId: number, status: string): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	return withTenant(db, tenantId, async (tx) => {
		const [order] = await tx
			.insert(exchangeOrders)
			.values({
				tenantId,
				conversationId,
				direction: "crypto_to_thb",
				assetFrom: "USDT",
				network: "trc20",
				amountMode: "target_thb",
				requestedAmount: 10_000,
				amountFrom: 285.71,
				rate: 35,
				amountToThb: 10_000,
				status,
				idempotencyKey: `risk-${conversationId}-${status}-${now}-${suffix}`,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: exchangeOrders.id });
		return order!.id;
	});
}

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
	const [tenant] = await db
		.insert(tenants)
		.values({ slug: `exchange-risk-${Date.now()}` })
		.returning({ id: tenants.id });
	tenantId = tenant!.id;
	enabled = true;
}, 30_000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 0 }).catch(() => {});
	sql = null;
});

describe("screenSenderAddress", () => {
	it("defaults to allowing sender addresses until an AML provider is configured", async () => {
		await expect(screenSenderAddress("TXYZ", "USDT", "trc20")).resolves.toEqual({
			ok: true,
		});
	});
});

describe("findOpenOrderId", () => {
	it("returns null when the conversation has no active order", async () => {
		if (!enabled) return;
		const conversationId = await createConversationFixture();
		await insertOrder(conversationId, "completed");

		await expect(findOpenOrderId(db, tenantId, conversationId)).resolves.toBeNull();
	});

	it.each(["quote", "awaiting_payment", "paid", "payout"])(
		"returns the order id for %s orders",
		async (status) => {
			if (!enabled) return;
			const conversationId = await createConversationFixture();
			const orderId = await insertOrder(conversationId, status);

			await expect(findOpenOrderId(db, tenantId, conversationId)).resolves.toBe(orderId);
		},
	);
});

describe("assessOrderRisk", () => {
	it("allows a positive amount when there is no open order", async () => {
		if (!enabled) return;
		const conversationId = await createConversationFixture();

		await expect(
			assessOrderRisk(db, tenantId, { conversationId, amountToThb: 10_000 }),
		).resolves.toEqual({ ok: true, reasons: [] });
	});

	it("blocks duplicate open orders and invalid receive amounts", async () => {
		if (!enabled) return;
		const conversationId = await createConversationFixture();
		const orderId = await insertOrder(conversationId, "awaiting_payment");

		await expect(
			assessOrderRisk(db, tenantId, { conversationId, amountToThb: Number.NaN }),
		).resolves.toEqual({
			ok: false,
			reasons: [
				`В этой беседе уже есть незавершённая заявка #${orderId}.`,
				"Некорректная сумма к получению.",
			],
		});
	});
});
