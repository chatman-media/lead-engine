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
const dbName = `lead_engine_partners_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-partners-flow-12345";

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
    body: JSON.stringify({ email: "partners@demo.io", password: "strong-pwd-12345" }),
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

describe("admin partners ledger", () => {
  it("creates partner, service, deal and computes commission on close", async () => {
    if (!sql) return;

    const partnerRes = await authReq("/api/admin/partners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agency Phuket", defaultCommissionPct: 12 }),
    });
    expect(partnerRes.status).toBe(201);
    const partner = ((await partnerRes.json()) as { item: { id: number } }).item;

    const serviceRes = await authReq("/api/admin/partner-services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partnerId: partner.id, name: "Property deal", commissionPct: 15 }),
    });
    expect(serviceRes.status).toBe(201);
    const service = ((await serviceRes.json()) as { item: { id: number } }).item;

    const dealRes = await authReq("/api/admin/partner-deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        partnerId: partner.id,
        serviceId: service.id,
        grossAmount: 100_000,
        currency: "THB",
        commissionPct: 15,
      }),
    });
    expect(dealRes.status).toBe(201);
    const deal = ((await dealRes.json()) as { item: { id: number; commissionAmount: number } }).item;
    expect(deal.commissionAmount).toBe(15_000);

    const closeRes = await authReq(`/api/admin/partner-deals/${deal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", grossAmount: 120_000, commissionPct: 10 }),
    });
    expect(closeRes.status).toBe(200);
    const closed = ((await closeRes.json()) as {
      item: { status: string; grossAmount: number; commissionAmount: number; completedAt: number | null };
    }).item;
    expect(closed.status).toBe("completed");
    expect(closed.grossAmount).toBe(120_000);
    expect(closed.commissionAmount).toBe(12_000);
    expect(closed.completedAt).toBeTruthy();

    const listRes = await authReq("/api/admin/partners");
    const list = (await listRes.json()) as { items: Array<{ dealsCount: number; commissionTotal: number }> };
    expect(list.items[0]?.dealsCount).toBe(1);
    expect(list.items[0]?.commissionTotal).toBe(12_000);
  });
});
