// Integration test for admin-dashboard aggregate. Isolated DB + real auth.
// Coverage epic #187 — apps/api untested routes.

import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  createIsolatedDb,
  funnels,
  schema,
  stageDefinitions,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminDashboardRoutes } from "./admin-dashboard.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_dash_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-dashboard-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

const URL_PATH = "/api/admin/dashboard";

beforeAll(
  async () => {
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
    app.route("/", makeAdminDashboardRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dash@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
    token = sba.token;
    tenantId = sba.admin.tenantId;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function get(withAuth = true): Promise<Response> {
  return app.request(URL_PATH, {
    headers: withAuth ? { Authorization: `Bearer ${token}` } : {},
  });
}

interface Dash {
  leads: { total: number; byStage: Array<{ slug: string; count: number }> };
  conversations: { open: number; escalated: number; today: number };
  messages: { last7days: number };
}

describe("admin-dashboard", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    expect((await get(false)).status).toBe(401);
  });

  it("пустой тенант → нули + byStage []", async () => {
    if (!sql) return;
    const res = await get();
    expect(res.status).toBe(200);
    const d = (await res.json()) as Dash;
    expect(d.leads.total).toBe(0);
    expect(d.leads.byStage).toEqual([]);
    expect(d.conversations).toEqual({ open: 0, escalated: 0, today: 0 });
    expect(d.messages.last7days).toBe(0);
  });

  it("со стадией → byStage содержит запись (count 0)", async () => {
    if (!sql) return;
    await withTenant(db, tenantId, async (tx) => {
      const [f] = await tx
        .insert(funnels)
        .values({ tenantId, slug: "f1", isActive: true })
        .returning();
      await tx.insert(stageDefinitions).values({
        tenantId,
        funnelId: f!.id,
        slug: "intake",
        displayName: "Заявка",
        kind: "intake",
        position: 0,
      });
    });

    const d = (await (await get()).json()) as Dash;
    expect(d.leads.byStage.length).toBe(1);
    expect(d.leads.byStage[0]?.slug).toBe("intake");
    expect(d.leads.byStage[0]?.count).toBe(0);
  });
});
