// Integration tests for GET /api/admin/roi — auth, empty-tenant shape,
// period clamping, real metric computation (fast reply, leads), tenant isolation.

import {
  applyAllMigrations,
  contacts,
  conversations,
  createIsolatedDb,
  leads,
  messages,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminRoiRoutes } from "./admin-roi.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_roi_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-roi-flow-1234567890";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantA = 0;
let tokenB = "";
let tenantB = 0;

async function authReq(token: string, path: string): Promise<Response> {
  return await app.request(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminRoiRoutes({ db }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "roi-a@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  tokenA = sba.token;
  tenantA = sba.admin.tenantId;

  const sb = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "roi-b@demo.io", password: "strong-pwd-12345" }),
  });
  const sbb = (await sb.json()) as { token: string; admin: { tenantId: number } };
  tokenB = sbb.token;
  tenantB = sbb.admin.tenantId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
});

interface RoiBody {
  periodDays: number;
  leadsReceived: number;
  fastReply: { answered: number; within30: number; rate: number | null; thresholdSeconds: number };
  savedLeads: number;
  handoffs: number;
  conversions: { won: number; lost: number };
  funnel: Array<{ phase: string; leads: number }>;
  unassigned: number;
}

describe("GET /api/admin/roi", () => {
  it("without auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/roi");
    expect(res.status).toBe(401);
  });

  it("empty tenant → zeroed metrics with 7-phase funnel", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/roi");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RoiBody;
    expect(body.periodDays).toBe(30);
    expect(body.leadsReceived).toBe(0);
    expect(body.fastReply.answered).toBe(0);
    expect(body.fastReply.rate).toBeNull();
    expect(body.fastReply.thresholdSeconds).toBe(30);
    expect(body.handoffs).toBe(0);
    expect(body.conversions).toEqual({ won: 0, lost: 0 });
    expect(body.funnel).toHaveLength(7);
    expect(body.funnel[0]?.phase).toBe("capture");
  });

  it("period query is parsed and clamped", async () => {
    if (!sql) return;
    const clamped = (await (await authReq(tokenA, "/api/admin/roi?period=9999")).json()) as RoiBody;
    expect(clamped.periodDays).toBe(365);
    const custom = (await (await authReq(tokenA, "/api/admin/roi?period=7")).json()) as RoiBody;
    expect(custom.periodDays).toBe(7);
    const fallback = (await (await authReq(tokenA, "/api/admin/roi?period=abc")).json()) as RoiBody;
    expect(fallback.periodDays).toBe(30);
  });

  it("computes leadsReceived + fast-reply rate from real data", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);

    const [contact] = await db
      .insert(contacts)
      .values({ tenantId: tenantA, displayName: "Лид Тестовый" })
      .returning({ id: contacts.id });
    const contactId = contact!.id;

    const [conv] = await db
      .insert(conversations)
      .values({ tenantId: tenantA, userId: contactId, source: "userbot", mode: "ai" })
      .returning({ id: conversations.id });
    const convId = conv!.id;

    // user message, then assistant reply 10s later → within 30s threshold
    await db.insert(messages).values([
      { tenantId: tenantA, conversationId: convId, role: "user", text: "привет", createdAt: now - 100 },
      { tenantId: tenantA, conversationId: convId, role: "assistant", text: "здравствуйте!", createdAt: now - 90 },
    ]);

    await db
      .insert(leads)
      .values({ tenantId: tenantA, userId: contactId, state: "intake_pending", createdAt: now - 100 });

    const body = (await (await authReq(tokenA, "/api/admin/roi")).json()) as RoiBody;
    expect(body.leadsReceived).toBe(1);
    expect(body.fastReply.answered).toBe(1);
    expect(body.fastReply.within30).toBe(1);
    expect(body.fastReply.rate).toBe(100);
    expect(typeof body.savedLeads).toBe("number");
  });

  it("tenant B does not see tenant A's data (isolation)", async () => {
    if (!sql) return;
    const body = (await (await authReq(tokenB, "/api/admin/roi")).json()) as RoiBody;
    expect(body.leadsReceived).toBe(0);
    expect(body.fastReply.answered).toBe(0);
    expect(tenantA).not.toBe(tenantB);
  });
});
