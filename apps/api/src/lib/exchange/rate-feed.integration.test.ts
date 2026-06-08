/**
 * rate-feed: рыночный фид base_rate. Транспорт (FX open.er-api + Binance) через
 * мок globalThis.fetch; refreshTenantRates/refreshAllActiveTenants — на изол-БД.
 * Чистые функции (isRateSane / renderRateCardMessage / isRefreshDue) — напрямую.
 *
 * ВАЖНО: getFxPerUsd кэширует FX на процесс — тест «bad FX» идёт ПЕРВЫМ, пока
 * кэш пуст; последующие успешные фетчи его наполняют.
 */
import { applyAllMigrations, createIsolatedDb, schema, tryConnectToPg } from "@chatman-media/storage";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import {
  buildDefaultRateCardProposal,
  fetchMarketBaseRate,
  fetchMarketThbPerUnit,
  isRateSane,
  isRefreshDue,
  refreshAllActiveTenants,
  refreshTenantRates,
  renderRateCardMessage,
} from "./rate-feed.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Мок: FX-эндпоинт → заданные rates; Binance → заданная цена. */
function mockFetch(opts: { fx?: Record<string, number> | "bad"; binance?: Record<string, string> }) {
  globalThis.fetch = (async (url: string) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "open.er-api.com") {
      const body =
        opts.fx === "bad"
          ? { result: "error" }
          : { result: "success", rates: opts.fx ?? { THB: 35, RUB: 90, EUR: 0.9 } };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (parsed.hostname === "api.binance.com") {
      const m = parsed.searchParams.get("symbol")?.match(/^(\w+?)USDT$/);
      const sym = m?.[1] ?? "BTC";
      return {
        ok: true,
        status: 200,
        json: async () => ({ price: opts.binance?.[sym] ?? "60000" }),
      } as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

describe("fetchMarketThbPerUnit — FX error (кэш пуст, идёт первым)", () => {
  it("плохой ответ FX → throw", async () => {
    mockFetch({ fx: "bad" });
    await expect(fetchMarketThbPerUnit("USDT")).rejects.toThrow(/FX feed: bad response/);
  });
});

describe("isRateSane", () => {
  it("первичная установка (prev<=0) → true", () => {
    expect(isRateSane(0, 36)).toBe(true);
  });
  it("next невалиден → false", () => {
    expect(isRateSane(36, 0)).toBe(false);
    expect(isRateSane(36, Number.NaN)).toBe(false);
  });
  it("в пределах maxDeviation → true, вне → false", () => {
    expect(isRateSane(100, 130, 0.5)).toBe(true);
    expect(isRateSane(100, 160, 0.5)).toBe(false);
  });
});

describe("isRefreshDue", () => {
  it("never refreshed → true; в пределах интервала → false", () => {
    expect(isRefreshDue(1000, undefined, 180)).toBe(true);
    expect(isRefreshDue(1000, 900, 180)).toBe(false);
    expect(isRefreshDue(1000, 800, 180)).toBe(true);
  });
});

describe("fetchMarketThbPerUnit / fetchMarketBaseRate", () => {
  it("USDT/USD → THB per USD", async () => {
    mockFetch({ fx: { THB: 35, RUB: 90, EUR: 0.9 } });
    expect(await fetchMarketThbPerUnit("usdt")).toBe(35);
    expect(await fetchMarketThbPerUnit("USD")).toBe(35);
  });
  it("EUR/RUB → конвертация через USD", async () => {
    mockFetch({ fx: { THB: 35, RUB: 90, EUR: 0.9 } });
    expect(await fetchMarketThbPerUnit("EUR")).toBeCloseTo(35 / 0.9, 4);
    expect(await fetchMarketThbPerUnit("RUB")).toBeCloseTo(35 / 90, 6);
  });
  it("BTC/ETH → Binance × THB", async () => {
    mockFetch({ fx: { THB: 35 }, binance: { BTC: "60000", ETH: "3000" } });
    expect(await fetchMarketThbPerUnit("BTC")).toBe(60000 * 35);
    expect(await fetchMarketThbPerUnit("ETH")).toBe(3000 * 35);
  });
  it("неподдержанный актив → null", async () => {
    mockFetch({ fx: { THB: 35, RUB: 90, EUR: 0.9 } });
    expect(await fetchMarketThbPerUnit("DOGE")).toBeNull();
  });
  it("fetchMarketBaseRate divide → 1/thbPerUnit", async () => {
    mockFetch({ fx: { THB: 35, RUB: 90 } });
    const div = await fetchMarketBaseRate("RUB", "divide");
    expect(div).toBeCloseTo(90 / 35, 4); // 1 / (35/90)
    const mul = await fetchMarketBaseRate("USDT", "multiply");
    expect(mul).toBe(35);
  });
});

describe("renderRateCardMessage", () => {
  it("RUB + USDT секции с тирами", () => {
    const msg = renderRateCardMessage([
      {
        asset: "RUB",
        network: "",
        quoteMode: "divide",
        marketRate: 2.5,
        tiers: [{ minThb: 2000, maxThb: 3000, displayRate: 2.6, deviationPct: 4, formula: "" }],
        message: "",
      },
      {
        asset: "USDT",
        network: "trc20",
        quoteMode: "multiply",
        marketRate: 31,
        tiers: [{ minThb: 2000, maxThb: null, displayRate: 31.4, deviationPct: 1, formula: "" }],
        message: "",
      },
    ]);
    expect(msg).toContain("АКТУАЛЬНЫЙ КУРС");
    expect(msg).toContain("RUB // Баты");
    expect(msg).toContain("USDT // Баты");
    expect(msg).toContain("2.6");
  });
});

describe("buildDefaultRateCardProposal", () => {
  it("строит RUB(divide) + USDT(multiply) предложения с message", async () => {
    mockFetch({ fx: { THB: 35, RUB: 90 } });
    const proposals = await buildDefaultRateCardProposal();
    expect(proposals.map((p) => p.asset).sort()).toEqual(["RUB", "USDT"]);
    expect(proposals[0]!.tiers.length).toBeGreaterThan(0);
    expect(proposals[0]!.message).toContain("АКТУАЛЬНЫЙ КУРС");
  });
});

// ── refreshTenantRates / refreshAllActiveTenants (integration) ───────────────
const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ratefeed_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "storage", "migrations");
let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantId = 0;
let autoRateId = 0;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);
  const [t] = await db
    .insert(schema.tenants)
    .values({ slug: `ratefeed-${n}`, status: "active" })
    .returning({ id: schema.tenants.id });
  tenantId = t!.id;
  // BTC auto-курс: Binance НЕ кэшируется (в отличие от FX), поэтому можно менять
  // рыночную цену между тестами через мок.
  const [r] = await db
    .insert(schema.exchangeRates)
    .values({
      tenantId,
      asset: "BTC",
      quoteAsset: "THB",
      network: "",
      baseRate: 2_000_000,
      quoteMode: "multiply",
      autoUpdate: true,
      isActive: true,
      createdAt: n,
      updatedAt: n,
    })
    .returning({ id: schema.exchangeRates.id });
  autoRateId = r!.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
});

describe("refreshTenantRates", () => {
  it("обновляет auto-курс рыночным значением (в пределах sanity)", async () => {
    if (!enabled) return;
    // BTC 60000 × THB 35 = 2_100_000; prev 2_000_000 → +5% (в пределах 50%)
    mockFetch({ fx: { THB: 35 }, binance: { BTC: "60000" } });
    const res = await refreshTenantRates(db, tenantId);
    expect(res.updated).toBe(1);
    const [row] = await db
      .select({ baseRate: schema.exchangeRates.baseRate })
      .from(schema.exchangeRates)
      .where(eq(schema.exchangeRates.id, autoRateId));
    expect(Number(row!.baseRate)).toBe(2_100_000);
  });

  it("резкое отклонение → skipped + onAnomaly", async () => {
    if (!enabled) return;
    // BTC 200000 × 35 = 7_000_000 vs prev 2_100_000 → >50% откл.
    mockFetch({ fx: { THB: 35 }, binance: { BTC: "200000" } });
    const anomalies: Array<{ asset: string }> = [];
    const warns: string[] = [];
    const res = await refreshTenantRates(db, tenantId, { warn: (m) => warns.push(m) }, (a) =>
      anomalies.push(a),
    );
    expect(res.skipped).toBe(1);
    expect(res.updated).toBe(0);
    expect(anomalies.some((a) => a.asset === "BTC")).toBe(true);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("тенант без auto-курсов → нулевой результат", async () => {
    if (!enabled) return;
    const [t2] = await db
      .insert(schema.tenants)
      .values({ slug: `ratefeed-empty-${n}`, status: "active" })
      .returning({ id: schema.tenants.id });
    const res = await refreshTenantRates(db, t2!.id);
    expect(res).toEqual({ updated: 0, skipped: 0, failed: 0 });
  });

  it("fetch падает → failed++", async () => {
    if (!enabled) return;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await refreshTenantRates(db, tenantId, { warn: () => {} });
    expect(res.failed).toBe(1);
  });
});

describe("refreshAllActiveTenants", () => {
  it("проходит по активным тенантам без исключений", async () => {
    if (!enabled) return;
    mockFetch({ fx: { THB: 35 } });
    const infos: string[] = [];
    await refreshAllActiveTenants(db, { info: (m) => infos.push(m), warn: () => {} });
    expect(true).toBe(true); // не бросило
  });
});
