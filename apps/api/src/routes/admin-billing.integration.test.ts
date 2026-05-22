// Integration test: GET /billing/plan, /billing/plans + quota enforcement
// при channel create / KB upload.

import { NullEmbeddingClient } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  kbDocuments,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminBillingRoutes } from "./admin-billing.ts";
import { makeAdminKbRoutes } from "./admin-kb.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_bill_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-bill-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

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
    app.route("/", makeAdminBillingRoutes({ db }));
    // KB route — для quota test'а на upload
    const embedder = new NullEmbeddingClient(1536);
    app.route(
      "/",
      makeAdminKbRoutes({ db, resolveEmbedder: () => embedder }),
    );

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bill@demo.io", password: "strong-pwd-12345" }),
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

async function authReq(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

describe("admin-billing", () => {
  it("GET /billing/plan без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/billing/plan");
    expect(res.status).toBe(401);
  });

  it("fresh tenant → free plan, 0 usage, status ok", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/billing/plan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { kind: string; label: string; maxChannels: number };
      usage: { channels: number; kbDocuments: number };
      status: string;
    };
    expect(body.plan.kind).toBe("free");
    expect(body.plan.label).toBe("Free");
    expect(body.plan.maxChannels).toBe(1);
    expect(body.usage.channels).toBe(0);
    expect(body.usage.kbDocuments).toBe(0);
    expect(body.status).toBe("ok");
  });

  it("GET /billing/plans → returns 4 tiers", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/billing/plans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plans: Array<{ kind: string; priceUsd: number | null }>;
    };
    expect(body.plans).toHaveLength(4);
    const kinds = body.plans.map((p) => p.kind).sort();
    expect(kinds).toEqual(["enterprise", "free", "pro", "starter"]);
  });

  it("upgrade tenant to starter via DB → /billing/plan reflects new tier", async () => {
    if (!sql) return;
    await db
      .update(tenants)
      .set({ plan: "starter" })
      .where(eq(tenants.id, tenantId));
    const res = await authReq("/api/admin/billing/plan");
    const body = (await res.json()) as {
      plan: { kind: string; maxChannels: number; priceUsd: number };
    };
    expect(body.plan.kind).toBe("starter");
    expect(body.plan.maxChannels).toBe(3);
    expect(body.plan.priceUsd).toBe(49);
  });

  it("downgrade back to free + усиленный insert → over_limit_channels status", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    // Insert 2 каналов (free limit=1)
    await db.insert(channels).values([
      {
        tenantId,
        kind: "telegram_bot",
        externalId: "over1",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId,
        kind: "telegram_bot",
        externalId: "over2",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db
      .update(tenants)
      .set({ plan: "free" })
      .where(eq(tenants.id, tenantId));

    const res = await authReq("/api/admin/billing/plan");
    const body = (await res.json()) as { usage: { channels: number }; status: string };
    expect(body.usage.channels).toBe(2);
    expect(body.status).toBe("over_limit_channels");

    // cleanup для следующих тестов
    await db.delete(channels).where(eq(channels.tenantId, tenantId));
  });

  it("free plan + KB upload до limit → ok, потом 402", async () => {
    if (!sql) return;
    // Free limit = 50. Симулируем insert 50 docs прямо в БД (быстрее upload x50).
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 50 }, (_, i) => ({
      tenantId,
      source: `seed-${i}`,
      title: `Seed ${i}`,
      contentHash: `seed-hash-${i}`,
      createdAt: now,
    }));
    await db.insert(kbDocuments).values(rows);

    // Теперь upload новой → 402.
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Should be blocked",
        body: "Этот документ должен быть отвергнут — лимит free=50.",
      }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error: string;
      reason: string;
      limit: number;
      current: number;
      plan: string;
    };
    expect(body.error).toBe("quota_exceeded");
    expect(body.reason).toBe("max_kb_documents");
    expect(body.limit).toBe(50);
    expect(body.current).toBe(50);
    expect(body.plan).toBe("free");
  });

  it("upgrade в pro → previously-blocked upload должен пройти", async () => {
    if (!sql) return;
    await db
      .update(tenants)
      .set({ plan: "pro" })
      .where(eq(tenants.id, tenantId));
    const res = await authReq("/api/admin/kb/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Now allowed",
        body: "Pro план разрешает много документов.",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/billing/plan", {
      headers: { Authorization: "Bearer bad" },
    });
    expect(res.status).toBe(401);
  });
});
