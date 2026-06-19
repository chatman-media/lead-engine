import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  createIsolatedDb,
  exchangeOrders,
  exchangePayoutPoints,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { listActivePayoutPoints } from "./payout-points.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_payout_points_${Math.random().toString(36).slice(2, 10)}`;
const appRoleName = `app_payout_points_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-payout-points";
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
const NOW = Math.floor(Date.parse("2026-06-20T08:00:00Z") / 1000);

let sql: Sql | null = null;
let appSql: Sql | null = null;
let appDb: PostgresJsDatabase<typeof schema>;
let tenantA = 0;
let tenantB = 0;

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
  const ownerDb = drizzle(sql, { schema });

  const parsed = new URL(testUrl);
  parsed.username = appRoleName;
  parsed.password = appRolePass;
  appSql = postgres(parsed.toString(), { max: 2, onnotice: () => {} });
  appDb = drizzle(appSql, { schema });

  const rows = await ownerDb
    .insert(tenants)
    .values([
      { slug: "payout-points-a", plan: "free", status: "active", createdAt: NOW, updatedAt: NOW },
      { slug: "payout-points-b", plan: "free", status: "active", createdAt: NOW, updatedAt: NOW },
    ])
    .returning({ id: tenants.id });
  tenantA = rows[0]?.id ?? 0;
  tenantB = rows[1]?.id ?? 0;
  if (!tenantA || !tenantB) throw new Error("tenant insert failed");
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

async function seedPointsForTenantA() {
  await withTenant(appDb as Db, tenantA, async (tx) => {
    await tx.insert(exchangePayoutPoints).values([
      {
        tenantId: tenantA,
        kind: "atm",
        code: "scb_asok",
        label: "SCB Asok",
        bankName: "SCB",
        quoteAsset: "THB",
        denomination: 100,
        perWithdrawalMax: 30_000,
        codeTtlSec: 1800,
        city: "Bangkok",
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        tenantId: tenantA,
        kind: "courier_zone",
        code: "bkk_sukhumvit",
        label: "Sukhumvit delivery",
        quoteAsset: "THB",
        feeFixed: 300,
        feePct: 0,
        city: "Bangkok",
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        tenantId: tenantA,
        kind: "atm",
        code: "bdo_makati",
        label: "BDO Makati (disabled)",
        bankName: "BDO",
        quoteAsset: "PHP",
        denomination: 100,
        isActive: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });
}

describe("exchange payout points catalog", () => {
  it("lists active points, filters by kind and currency, excludes inactive", async () => {
    if (!sql || !appSql) return;
    await seedPointsForTenantA();

    const all = await listActivePayoutPoints(appDb as Db, tenantA);
    // Неактивная точка (bdo_makati) исключена.
    expect(all.map((p) => p.code).sort()).toEqual(["bkk_sukhumvit", "scb_asok"]);

    const atm = all.find((p) => p.code === "scb_asok");
    expect(atm?.kind).toBe("atm");
    expect(atm?.denomination).toBe(100);
    expect(atm?.perWithdrawalMax).toBe(30_000);
    expect(atm?.codeTtlSec).toBe(1800);

    const courier = all.find((p) => p.code === "bkk_sukhumvit");
    expect(courier?.kind).toBe("courier_zone");
    expect(courier?.feeFixed).toBe(300);

    const onlyAtm = await listActivePayoutPoints(appDb as Db, tenantA, { kind: "atm" });
    expect(onlyAtm.map((p) => p.code)).toEqual(["scb_asok"]);

    const onlyThb = await listActivePayoutPoints(appDb as Db, tenantA, { quoteAsset: "THB" });
    expect(onlyThb.map((p) => p.code).sort()).toEqual(["bkk_sukhumvit", "scb_asok"]);
  });

  it("isolates points per tenant under non-bypass RLS", async () => {
    if (!sql || !appSql) return;
    const other = await listActivePayoutPoints(appDb as Db, tenantB);
    expect(other).toEqual([]);
  });

  it("links an exchange order to a payout point via payout_point_id", async () => {
    if (!sql || !appSql) return;
    const linked = await withTenant(appDb as Db, tenantA, async (tx) => {
      const [point] = await tx
        .select({ id: exchangePayoutPoints.id })
        .from(exchangePayoutPoints)
        .where(
          and(
            eq(exchangePayoutPoints.tenantId, tenantA),
            eq(exchangePayoutPoints.code, "scb_asok"),
          ),
        )
        .limit(1);
      if (!point) throw new Error("seed point missing");
      const [order] = await tx
        .insert(exchangeOrders)
        .values({
          tenantId: tenantA,
          direction: "USDT->THB",
          assetFrom: "USDT",
          amountFrom: 100,
          rate: 36,
          amountToThb: 3600,
          payoutMethod: "cardless_atm",
          payoutPointId: point.id,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning({ id: exchangeOrders.id, payoutPointId: exchangeOrders.payoutPointId });
      return { pointId: point.id, order };
    });
    expect(linked.order?.payoutPointId).toBe(linked.pointId);
  });
});
