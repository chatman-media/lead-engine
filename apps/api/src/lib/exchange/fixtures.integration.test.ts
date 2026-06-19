import { type Db, getDecryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import {
	applyAllMigrations,
	contacts,
	conversations,
	createIsolatedDb,
	exchangeRates,
	exchangeRateTiers,
	exchangeSettings,
	kbChunks,
	kbDocuments,
	schema,
	tenantSecrets,
	tenants,
	tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import {
	EXCHANGE_FIXTURE_KB_DOCUMENTS,
	EXCHANGE_FIXTURE_RATES,
	EXCHANGE_FIXTURE_RATE_TIERS,
	EXCHANGE_FIXTURE_SECRETS,
	exchangeFixtureOffices,
	seedExchangeFixtures,
} from "./fixtures.ts";
import { makeExchangeTools } from "./tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exchange_fixtures_${Math.random().toString(36).slice(2, 10)}`;
const appRoleName = `app_exchange_fixtures_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-exchange-fixtures";
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
const MASTER_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = Math.floor(Date.parse("2026-06-10T08:00:00Z") / 1000);

let sql: Sql | null = null;
let appSql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let appDb: PostgresJsDatabase<typeof schema>;
let tenantId = 0;

type ToolMap = Record<
	string,
	{ execute: (args: Record<string, unknown>) => Promise<unknown> }
>;

beforeAll(async () => {
	if (!ownerUrl) return;
	const probe = await tryConnectToPg(ownerUrl);
	if (!probe) return;
	await probe.end({ timeout: 0 });

	const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
	sql = postgres(testUrl, { max: 2, onnotice: () => {} });
	await applyAllMigrations(sql, migrationsDir);
	await sql.unsafe(`
		CREATE ROLE "${appRoleName}" LOGIN PASSWORD '${appRolePass}' NOSUPERUSER NOBYPASSRLS;
		GRANT USAGE ON SCHEMA public TO "${appRoleName}";
		GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRoleName}";
		GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRoleName}";
	`);
	db = drizzle(sql, { schema });

	const parsed = new URL(testUrl);
	parsed.username = appRoleName;
	parsed.password = appRolePass;
	appSql = postgres(parsed.toString(), { max: 2, onnotice: () => {} });
	appDb = drizzle(appSql, { schema });

	const [tenant] = await db
		.insert(tenants)
		.values({
			slug: "exchange-fixtures-demo",
			plan: "free",
			status: "active",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.returning({ id: tenants.id });
	if (!tenant) throw new Error("tenant insert failed");
	tenantId = tenant.id;
}, 30_000);

afterAll(async () => {
	if (appSql) {
		await appSql.end({ timeout: 0 }).catch(() => {});
		appSql = null;
	}
	if (sql) {
		await sql
			.unsafe(`DROP OWNED BY "${appRoleName}"; DROP ROLE IF EXISTS "${appRoleName}"`)
			.catch(() => {});
		await sql.end({ timeout: 0 }).catch(() => {});
		sql = null;
	}
}, 10_000);

async function fixtureCounts() {
	return withTenant(appDb as Db, tenantId, async (tx) => {
		const rates = await tx
			.select({ id: exchangeRates.id })
			.from(exchangeRates)
			.where(eq(exchangeRates.tenantId, tenantId));
		const tiers = await tx
			.select({ id: exchangeRateTiers.id })
			.from(exchangeRateTiers)
			.where(eq(exchangeRateTiers.tenantId, tenantId));
		const secrets = await tx
			.select({ key: tenantSecrets.key })
			.from(tenantSecrets)
			.where(and(eq(tenantSecrets.tenantId, tenantId), like(tenantSecrets.key, "exchange_%")));
		const docs = await tx
			.select({ id: kbDocuments.id })
			.from(kbDocuments)
			.where(
				and(eq(kbDocuments.tenantId, tenantId), like(kbDocuments.source, "exchange-fixtures:%")),
			);
		const chunks = await tx
			.select({ id: kbChunks.id })
			.from(kbChunks)
			.where(eq(kbChunks.tenantId, tenantId));
		return {
			rates: rates.length,
			tiers: tiers.length,
			secrets: secrets.length,
			docs: docs.length,
			chunks: chunks.length,
		};
	});
}

async function createVerifiedConversation(): Promise<number> {
	return withTenant(appDb as Db, tenantId, async (tx) => {
		const [contact] = await tx
			.insert(contacts)
			.values({
				tenantId,
				displayName: "Fixture QA Customer",
				attributesJson: JSON.stringify({
					exchangeKyc: {
						status: "verified",
						verificationId: "fixture-kyc-001",
					},
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.returning({ id: contacts.id });
		if (!contact) throw new Error("contact insert failed");
		const [conversation] = await tx
			.insert(conversations)
			.values({
				tenantId,
				userId: contact.id,
				source: "self_play",
				mode: "ai",
				createdAt: NOW,
				lastMessageAt: NOW,
			})
			.returning({ id: conversations.id });
		if (!conversation) throw new Error("conversation insert failed");
		return conversation.id;
	});
}

function toolsFor(conversationId: number): ToolMap {
	return Object.fromEntries(
		makeExchangeTools({
			db: appDb as Db,
			tenantId,
			conversationId,
			masterKeyHex: MASTER_KEY,
		}).map((tool) => [tool.name, tool]),
	) as ToolMap;
}

describe("exchange deterministic fixtures", () => {
	it("seeds rates, requisites, offices and KB idempotently under non-bypass RLS", async () => {
		if (!sql || !appSql) return;

		const first = await seedExchangeFixtures({
			db: appDb as Db,
			tenantId,
			masterKeyHex: MASTER_KEY,
			nowEpoch: NOW,
		});
		const firstCounts = await fixtureCounts();
		const second = await seedExchangeFixtures({
			db: appDb as Db,
			tenantId,
			masterKeyHex: MASTER_KEY,
			nowEpoch: NOW + 60,
		});
		const secondCounts = await fixtureCounts();

		expect(first).toMatchObject({
			rates: EXCHANGE_FIXTURE_RATES.length,
			rateTiers: EXCHANGE_FIXTURE_RATE_TIERS.length,
			secrets: EXCHANGE_FIXTURE_SECRETS.length,
			kbDocuments: EXCHANGE_FIXTURE_KB_DOCUMENTS.length,
		});
		expect(second).toEqual(first);
		expect(secondCounts).toEqual(firstCounts);
		expect(secondCounts).toMatchObject({
			rates: EXCHANGE_FIXTURE_RATES.length,
			tiers: EXCHANGE_FIXTURE_RATE_TIERS.length,
			secrets: EXCHANGE_FIXTURE_SECRETS.length,
			docs: EXCHANGE_FIXTURE_KB_DOCUMENTS.length,
			chunks: EXCHANGE_FIXTURE_KB_DOCUMENTS.length,
		});

		const [settings] = await withTenant(appDb as Db, tenantId, (tx) =>
			tx
				.select({
					rateRefreshSec: exchangeSettings.rateRefreshSec,
					feedStaleSec: exchangeSettings.feedStaleSec,
				})
				.from(exchangeSettings)
				.where(eq(exchangeSettings.tenantId, tenantId)),
		);
		expect(settings).toMatchObject({ rateRefreshSec: 300, feedStaleSec: 900 });

		const rubRecipient = await withTenant(appDb as Db, tenantId, (tx) =>
			getDecryptedSecret({
				db: tx as Db,
				tenantId,
				key: "exchange_rub_card_recipient",
				masterKeyHex: MASTER_KEY,
			}),
		);
		expect(rubRecipient).toBe("LE Demo Ops");
	});

	it("seeded fixtures drive exchange tools without direct secret reads", async () => {
		if (!sql || !appSql) return;
		await seedExchangeFixtures({
			db: appDb as Db,
			tenantId,
			masterKeyHex: MASTER_KEY,
			nowEpoch: NOW,
		});
		const conversationId = await createVerifiedConversation();
		const tools = toolsFor(conversationId);

		const quote = (await tools.compute_exchange_quote?.execute({
			asset: "RUB",
			amount: 10_000,
			amountMode: "target_thb",
		})) as Record<string, unknown>;
		expect(quote.amountToThb).toBe(10_000);
		expect(quote.asset).toBe("RUB");

		const order = (await tools.create_exchange_order?.execute({
			asset: "RUB",
			amount: 10_000,
			amountMode: "target_thb",
			paymentMethod: "card_transfer",
			paymentRail: "tbank_card",
			sourceBank: "T-Bank",
			payoutMethod: "office_cash",
			payoutLocation: "Bangkok Asok",
			payoutDestination: { officeKey: "bangkok_asok" },
		})) as Record<string, unknown>;
		expect(order.status).toBe("awaiting_payment");
		expect(order.verificationId).toBeUndefined();

		const requisites = (await tools.fetch_exchange_requisites?.execute({})) as Record<
			string,
			unknown
		>;
		expect(requisites.kind).toBe("fiat");
		expect(requisites.detailsText).toContain("2200 7000 0000 4888");
		expect(requisites.instructions).toContain("Реквизиты действительны");

		const info = (await tools.get_exchange_business_info?.execute({})) as Record<
			string,
			unknown
		>;
		// Офисы зависят от котируемой валюты (дефолт PHP → Манила/Себу).
		expect(info.officeAddress).toContain(exchangeFixtureOffices()[0]?.label ?? "");
		expect(info.officeAddresses).toEqual(
			expect.arrayContaining([
				expect.stringContaining(exchangeFixtureOffices()[0]?.label ?? ""),
				expect.stringContaining(exchangeFixtureOffices()[1]?.label ?? ""),
			]),
		);
		expect(info.payoutMethods).toContain("Cardless ATM code");
		expect(info.kycPolicy).toContain("KYC is required");
	});

	it("lists only real configured directions and rejects unknown pair with alternatives", async () => {
		if (!sql || !appSql) return;
		await seedExchangeFixtures({
			db: appDb as Db,
			tenantId,
			masterKeyHex: MASTER_KEY,
			nowEpoch: NOW,
		});
		const conversationId = await createVerifiedConversation();
		const tools = toolsFor(conversationId);

		const list = (await tools.list_exchange_directions?.execute({})) as {
			quoteAsset: string;
			directions: Array<{ asset: string; kind: string; networks: string[] }>;
			display: string;
		};
		expect(list.quoteAsset).toBe("PHP");
		// Реальные направления PHP-набора — USDT/RUB/USD. BTC/ETH/EUR из старого
		// захардкоженного списка отсутствуют (это и был баг со скриншота).
		expect(list.directions.map((d) => d.asset).sort()).toEqual(["RUB", "USD", "USDT"]);
		const usdt = list.directions.find((d) => d.asset === "USDT");
		expect(usdt?.kind).toBe("crypto");
		expect(usdt?.networks).toEqual(expect.arrayContaining(["TRC20", "ERC20", "BEP20"]));
		expect(list.display).toContain("USDT");
		expect(list.display).not.toContain("BTC");

		// Неподдерживаемое направление больше не тупик: ошибка несёт альтернативы.
		const rejected = (await tools.compute_exchange_quote?.execute({
			asset: "BTC",
			amount: 1,
		})) as { error?: string; availableDirections?: Array<{ asset: string }> };
		expect(rejected.error).toContain("не обслуживается");
		expect(rejected.error).not.toContain("не продолжай");
		expect(rejected.availableDirections?.map((d) => d.asset)).toContain("USDT");
	});
});
