/**
 * Интеграционно проверяем, что guardrail реально блокирует плохую котировку
 * через ПОЛНЫЙ путь computeQuote (включая tier.deviationPct, который раньше
 * обходил любые проверки), и не мешает легальным котировкам.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  createIsolatedDb,
  exchangeRates,
  exchangeRateTiers,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { computeQuote } from "./rates.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_guardrails_${Math.random().toString(36).slice(2, 10)}`;
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
let tenantId = 0;
let enabled = false;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;

  const now = Math.floor(Date.now() / 1000);
  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: `guardrails-${now}` })
    .returning({ id: schema.tenants.id });
  tenantId = tenant!.id;

  await withTenant(db, tenantId, async (tx) => {
    await tx.insert(exchangeRates).values([
      // USDT — база 31.5, маржа 0; курс задаётся тарифом ниже.
      {
        tenantId,
        asset: "USDT",
        quoteAsset: "THB",
        network: "trc20",
        baseRate: 31.5,
        quoteMode: "multiply",
        marginPct: 0,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      // BTC — базовая формула с абсурдной маржой 80% → eff далеко от base.
      {
        tenantId,
        asset: "BTC",
        quoteAsset: "THB",
        network: "",
        baseRate: 1000,
        quoteMode: "multiply",
        marginPct: 80,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      // RUB — нормальная маржа 2%.
      {
        tenantId,
        asset: "RUB",
        quoteAsset: "THB",
        network: "",
        baseRate: 2.55,
        quoteMode: "divide",
        marginPct: 2,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // Битый тариф USDT: отклонение −68% при рынке 31.5 (кейс «10 вместо 35»).
    await tx.insert(exchangeRateTiers).values({
      tenantId,
      asset: "USDT",
      quoteAsset: "THB",
      network: "trc20",
      rangeBasis: "target_thb",
      minAmount: 0,
      maxAmount: null,
      marketRate: 31.5,
      displayRate: 10,
      deviationPct: -68,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("guardrail в computeQuote", () => {
  it("блокирует битый tier.deviationPct (10 при рынке 31.5)", async () => {
    if (!enabled) return;
    const q = await computeQuote(db, tenantId, { asset: "USDT", amount: 100 });
    expect(q.ok).toBe(false);
    if (!q.ok) {
      expect(q.guard?.tripped).toBe(true);
      expect(q.guard?.reason).toBe("implausible_deviation");
    }
  });

  it("блокирует абсурдную маржу в базовой формуле (BTC, 80%)", async () => {
    if (!enabled) return;
    const q = await computeQuote(db, tenantId, { asset: "BTC", amount: 1 });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.guard?.tripped).toBe(true);
  });

  it("пропускает легальную котировку (RUB, маржа 2%)", async () => {
    if (!enabled) return;
    const q = await computeQuote(db, tenantId, { asset: "RUB", amount: 2550 });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.amountToThb).toBeGreaterThan(0);
  });

  it("после починки тарифа (deviationPct под 31) котировка проходит", async () => {
    if (!enabled) return;
    await withTenant(db, tenantId, async (tx) => {
      await tx
        .update(exchangeRateTiers)
        .set({ displayRate: 31, deviationPct: -1.5873 })
        .where(and(eq(exchangeRateTiers.tenantId, tenantId), eq(exchangeRateTiers.asset, "USDT")));
    });
    const q = await computeQuote(db, tenantId, { asset: "USDT", amount: 100 });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.rate).toBeCloseTo(31, 5);
  });

  it("tier считает курс от свежего baseRate и сохранённого отклонения", async () => {
    if (!enabled) return;
    await withTenant(db, tenantId, async (tx) => {
      await tx
        .update(exchangeRates)
        .set({ baseRate: 40 })
        .where(and(eq(exchangeRates.tenantId, tenantId), eq(exchangeRates.asset, "USDT")));
      await tx
        .update(exchangeRateTiers)
        .set({ displayRate: 31, deviationPct: 5 })
        .where(and(eq(exchangeRateTiers.tenantId, tenantId), eq(exchangeRateTiers.asset, "USDT")));
    });
    const q = await computeQuote(db, tenantId, { asset: "USDT", amount: 100 });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.rate).toBe(42);
  });
});
