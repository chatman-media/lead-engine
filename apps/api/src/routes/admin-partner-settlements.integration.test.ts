import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminPartnersRoutes } from "./admin-partners.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_settlements_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-settlements-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

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
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminPartnersRoutes({ db }));

  const signup = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "settlements@demo.io", password: "strong-pwd-12345" }),
  });
  token = ((await signup.json()) as { token: string }).token;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

async function jsonReq(path: string, method: string, body: unknown): Promise<Response> {
  return authReq(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createPartner(name: string): Promise<number> {
  const res = await jsonReq("/api/admin/partners", "POST", { name, defaultCommissionPct: 10 });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: number } }).item.id;
}

async function createDeal(
  partnerId: number,
  grossAmount: number,
  commissionPct: number,
  currency = "THB",
): Promise<number> {
  const res = await jsonReq("/api/admin/partner-deals", "POST", {
    partnerId,
    grossAmount,
    currency,
    commissionPct,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: number } }).item.id;
}

async function completeDeal(dealId: number): Promise<void> {
  const res = await jsonReq(`/api/admin/partner-deals/${dealId}`, "PATCH", {
    status: "completed",
  });
  expect(res.status).toBe(200);
}

async function createCompletedDeal(
  partnerId: number,
  grossAmount: number,
  commissionPct: number,
  currency = "THB",
): Promise<number> {
  const dealId = await createDeal(partnerId, grossAmount, commissionPct, currency);
  await completeDeal(dealId);
  return dealId;
}

function currentPeriod(): { periodStart: number; periodEnd: number } {
  const now = Math.floor(Date.now() / 1000);
  return { periodStart: now - 3600, periodEnd: now + 3600 };
}

async function listDeals(): Promise<
  Array<{ id: number; status: string; settledAt: number | null }>
> {
  const res = await authReq("/api/admin/partner-deals");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Array<{ id: number; status: string; settledAt: number | null }> })
    .items;
}

describe("admin partner settlements", () => {
  it("aggregates completed deals into a draft and pays it out", async () => {
    if (!sql) return;

    const partnerId = await createPartner("Settlement Partner A");
    const dealA = await createCompletedDeal(partnerId, 100_000, 10); // 10_000
    const dealB = await createCompletedDeal(partnerId, 50_000, 20); // 10_000
    // Не completed — не должна попасть в settlement.
    const dealPending = await createDeal(partnerId, 70_000, 10);

    const period = currentPeriod();
    const createRes = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      ...period,
      notes: "June payout",
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      item: {
        id: number;
        status: string;
        totalGross: number;
        totalCommission: number;
        currency: string;
        notes: string | null;
      };
      dealsCount: number;
    };
    expect(created.item.status).toBe("draft");
    expect(created.item.totalGross).toBe(150_000);
    expect(created.item.totalCommission).toBe(20_000);
    expect(created.item.currency).toBe("THB");
    expect(created.item.notes).toBe("June payout");
    expect(created.dealsCount).toBe(2);
    const settlementId = created.item.id;

    // Сделки захвачены — повторный settlement за тот же период пуст.
    const dupRes = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      ...period,
    });
    expect(dupRes.status).toBe(409);

    const listRes = await authReq(`/api/admin/partner-settlements?partnerId=${partnerId}`);
    expect(listRes.status).toBe(200);
    const listed = ((await listRes.json()) as {
      items: Array<{ id: number; partnerName: string; dealsCount: number }>;
    }).items;
    expect(listed.length).toBe(1);
    expect(listed[0]!.partnerName).toBe("Settlement Partner A");
    expect(listed[0]!.dealsCount).toBe(2);

    const issueRes = await jsonReq(`/api/admin/partner-settlements/${settlementId}`, "PATCH", {
      status: "issued",
    });
    expect(issueRes.status).toBe(200);
    expect(((await issueRes.json()) as { item: { status: string } }).item.status).toBe("issued");

    const payRes = await jsonReq(`/api/admin/partner-settlements/${settlementId}`, "PATCH", {
      status: "paid",
    });
    expect(payRes.status).toBe(200);
    const paid = ((await payRes.json()) as { item: { status: string; paidAt: number | null } })
      .item;
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBeGreaterThan(0);

    // Сделки внутри settlement'а помечены settled, остальные не тронуты.
    const deals = await listDeals();
    const byId = new Map(deals.map((d) => [d.id, d]));
    expect(byId.get(dealA)!.status).toBe("settled");
    expect(byId.get(dealA)!.settledAt).toBeGreaterThan(0);
    expect(byId.get(dealB)!.status).toBe("settled");
    expect(byId.get(dealPending)!.status).toBe("sent");

    // paid — терминальный статус.
    const reissueRes = await jsonReq(`/api/admin/partner-settlements/${settlementId}`, "PATCH", {
      status: "issued",
    });
    expect(reissueRes.status).toBe(409);
  });

  it("cancelling a settlement releases its deals for a later period", async () => {
    if (!sql) return;

    const partnerId = await createPartner("Settlement Partner B");
    const dealId = await createCompletedDeal(partnerId, 30_000, 10);
    const period = currentPeriod();

    const createRes = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      ...period,
    });
    expect(createRes.status).toBe(201);
    const settlementId = ((await createRes.json()) as { item: { id: number } }).item.id;

    const cancelRes = await jsonReq(`/api/admin/partner-settlements/${settlementId}`, "PATCH", {
      status: "cancelled",
    });
    expect(cancelRes.status).toBe(200);

    // Сделка снова свободна — новый settlement её подбирает.
    const retryRes = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      ...period,
    });
    expect(retryRes.status).toBe(201);
    const retry = (await retryRes.json()) as { item: { totalCommission: number }; dealsCount: number };
    expect(retry.dealsCount).toBe(1);
    expect(retry.item.totalCommission).toBe(3_000);

    const deals = await listDeals();
    expect(deals.find((d) => d.id === dealId)!.status).toBe("completed");
  });

  it("validates input, partner existence, currencies and transitions", async () => {
    if (!sql) return;

    const partnerId = await createPartner("Settlement Partner C");
    const period = currentPeriod();

    const noPartner = await jsonReq("/api/admin/partner-settlements", "POST", { ...period });
    expect(noPartner.status).toBe(400);

    const badPeriod = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      periodStart: period.periodEnd,
      periodEnd: period.periodStart,
    });
    expect(badPeriod.status).toBe(400);

    const ghostPartner = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId: 999_999,
      ...period,
    });
    expect(ghostPartner.status).toBe(404);

    const noDeals = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      ...period,
    });
    expect(noDeals.status).toBe(409);

    await createCompletedDeal(partnerId, 10_000, 10, "THB");
    await createCompletedDeal(partnerId, 500, 10, "USD");
    const mixed = await jsonReq("/api/admin/partner-settlements", "POST", {
      partnerId,
      ...period,
    });
    expect(mixed.status).toBe(409);
    expect(((await mixed.json()) as { currencies: string[] }).currencies.sort()).toEqual([
      "THB",
      "USD",
    ]);

    const badId = await jsonReq("/api/admin/partner-settlements/not-a-number", "PATCH", {
      status: "issued",
    });
    expect(badId.status).toBe(400);

    const ghostId = await jsonReq("/api/admin/partner-settlements/999999", "PATCH", {
      status: "issued",
    });
    expect(ghostId.status).toBe(404);
  });
});
