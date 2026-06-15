// Integration test: GET /billing/plan, /billing/plans + quota enforcement
// при channel create / KB upload.

import { NullEmbeddingClient } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  kbDocuments,
  llmUsageEvents,
  schema,
  stripeCustomers,
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
    // Free теперь эффективно безлимитен — кастомная обменка без SaaS-биллинга
    // (см. apps/api/src/lib/plans.ts: maxChannels=100 как «большой запас»).
    expect(body.plan.maxChannels).toBe(100);
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
    expect(body.plan.priceUsd).toBe(99);
  });

  it("starter plan + каналы сверх лимита → over_limit_channels status", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    // Starter limit = 3 канала; вставляем 4 → over limit. (Free теперь
    // эффективно безлимитен — кастомная обменка без SaaS-биллинга, см. plans.ts,
    // поэтому over-limit-логику проверяем на платном тарифе с конечным лимитом.)
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
      {
        tenantId,
        kind: "telegram_bot",
        externalId: "over3",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId,
        kind: "telegram_bot",
        externalId: "over4",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db
      .update(tenants)
      .set({ plan: "starter" })
      .where(eq(tenants.id, tenantId));

    const res = await authReq("/api/admin/billing/plan");
    const body = (await res.json()) as { usage: { channels: number }; status: string };
    expect(body.usage.channels).toBe(4);
    expect(body.status).toBe("over_limit_channels");

    // cleanup для следующих тестов
    await db.delete(channels).where(eq(channels.tenantId, tenantId));
  });

  it("starter plan + KB upload до limit → потом 402", async () => {
    if (!sql) return;
    // Starter limit = 500. Симулируем insert 500 docs прямо в БД (быстрее
    // upload x500). Free теперь без практического лимита (обменка без
    // SaaS-биллинга), поэтому quota-enforcement проверяем на Starter.
    await db
      .update(tenants)
      .set({ plan: "starter" })
      .where(eq(tenants.id, tenantId));
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 500 }, (_, i) => ({
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
        body: "Этот документ должен быть отвергнут — лимит starter=500.",
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
    expect(body.limit).toBe(500);
    expect(body.current).toBe(500);
    expect(body.plan).toBe("starter");
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

  it("GET /billing/usage → пустой report для fresh tenant", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/billing/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      periodDays: number;
      totals: { calls: number; errors: number; successRate: number };
      byPurpose: unknown[];
      byProvider: unknown[];
      thisMonth: { calls: number };
    };
    expect(body.periodDays).toBe(30);
    expect(body.totals.calls).toBe(0);
    expect(body.totals.successRate).toBe(1);
    expect(body.byPurpose).toEqual([]);
    expect(body.byProvider).toEqual([]);
    expect(body.thisMonth.calls).toBe(0);
  });

  it("GET /billing/usage с insert'нутыми events → aggregates корректно", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    // Insert 10 events: 8 chat openai success, 2 embed openai error.
    const rows = [
      ...Array.from({ length: 8 }, () => ({
        tenantId,
        purpose: "chat" as const,
        provider: "openai",
        model: "gpt-4o-mini",
        latencyMs: 500,
        success: true,
        promptTokens: 1000,
        completionTokens: 50,
        createdAt: now,
      })),
      ...Array.from({ length: 2 }, () => ({
        tenantId,
        purpose: "embed" as const,
        provider: "openai",
        model: "text-embedding-3-small",
        latencyMs: 100,
        success: false,
        errorKind: "EmbeddingApiError",
        // embed = input only → completionTokens остаётся null
        promptTokens: 200,
        createdAt: now,
      })),
    ];
    await db.insert(llmUsageEvents).values(rows);

    const res = await authReq("/api/admin/billing/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        calls: number;
        errors: number;
        successRate: number;
        avgLatencyMs: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
      byPurpose: Array<{
        purpose: string;
        calls: number;
        errors: number;
        promptTokens: number;
        completionTokens: number;
      }>;
      byProvider: Array<{ provider: string; calls: number }>;
      thisMonth: { calls: number; errors: number; promptTokens: number; completionTokens: number };
    };
    expect(body.totals.calls).toBe(10);
    expect(body.totals.errors).toBe(2);
    expect(body.totals.successRate).toBe(0.8);
    expect(body.totals.avgLatencyMs).toBeGreaterThan(0);
    // 8 chat * 500 + 2 embed * 100 = 4200, /10 = 420
    expect(body.totals.avgLatencyMs).toBe(420);
    // tokens: prompt = 8*1000 + 2*200 = 8400; completion = 8*50 = 400.
    expect(body.totals.promptTokens).toBe(8400);
    expect(body.totals.completionTokens).toBe(400);
    expect(body.totals.totalTokens).toBe(8800);

    const chat = body.byPurpose.find((p) => p.purpose === "chat");
    expect(chat?.calls).toBe(8);
    expect(chat?.errors).toBe(0);
    expect(chat?.promptTokens).toBe(8000);
    expect(chat?.completionTokens).toBe(400);
    const embed = body.byPurpose.find((p) => p.purpose === "embed");
    expect(embed?.calls).toBe(2);
    expect(embed?.errors).toBe(2);
    expect(embed?.promptTokens).toBe(400);
    expect(embed?.completionTokens).toBe(0);

    expect(body.byProvider[0]?.provider).toBe("openai");
    expect(body.byProvider[0]?.calls).toBe(10);

    expect(body.thisMonth.calls).toBe(10);
    expect(body.thisMonth.promptTokens).toBe(8400);
    expect(body.thisMonth.completionTokens).toBe(400);
  });

  it("GET /billing/usage?days=7 → custom period", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/billing/usage?days=7");
    const body = (await res.json()) as { periodDays: number };
    expect(body.periodDays).toBe(7);
  });

  it("GET /billing/usage?days=999 → clamped to 365", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/billing/usage?days=999");
    const body = (await res.json()) as { periodDays: number };
    expect(body.periodDays).toBe(365);
  });

  it("usage без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/billing/usage");
    expect(res.status).toBe(401);
  });
});

// ── Stripe checkout / portal — fake Stripe fetch ─────────────────────────

const stripeCalls: Array<{ url: string; body: string }> = [];
const fakeStripeFetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const bodyStr = init?.body ? String(init.body) : "";
  stripeCalls.push({ url, body: bodyStr });

  // Auth check — каждый запрос должен иметь Bearer.
  const headers = init?.headers as Record<string, string> | undefined;
  const auth = headers?.authorization ?? headers?.Authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth.includes("bad-key")) {
    return new Response(
      JSON.stringify({ error: { code: "api_key_invalid", message: "Bad key" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  if (url.includes("/v1/customers")) {
    return new Response(
      JSON.stringify({ id: `cus_${Math.random().toString(36).slice(2, 12)}`, email: "x@y" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.includes("/v1/checkout/sessions")) {
    const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
    return new Response(
      JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.includes("/v1/billing_portal/sessions")) {
    const id = `bps_${Math.random().toString(36).slice(2, 12)}`;
    return new Response(
      JSON.stringify({ id, url: `https://billing.stripe.com/p/session/${id}` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

let appWithStripe: Hono;
let tokenStripe = "";
let tenantIdStripe = 0;
let sqlStripe: Sql | null = null;
const stripeDbName = `lead_engine_billstripe_${Math.random().toString(36).slice(2, 10)}`;
let dbStripe: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: stripeDbName });
  sqlStripe = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sqlStripe, migrationsDir);
  dbStripe = drizzle(sqlStripe, { schema });

  appWithStripe = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  appWithStripe.route("/", makeAuthRoutes({ db: dbStripe as any, secret: SECRET }));
  appWithStripe.use(
    "/api/admin/*",
    makeRequireAuth({ db: dbStripe as never, secret: SECRET }),
  );
  appWithStripe.route(
    "/",
    makeAdminBillingRoutes({
      db: dbStripe,
      stripe: {
        secretKey: "sk_test_fake",
        priceMap: {
          starter: "price_starter_test",
          pro: "price_pro_test",
        },
        successUrl: "https://app.test/dashboard?success",
        cancelUrl: "https://app.test/dashboard?cancel",
      },
      fetchImpl: fakeStripeFetch,
    }),
  );

  const sa = await appWithStripe.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "stripe@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  tokenStripe = sba.token;
  tenantIdStripe = sba.admin.tenantId;
}, 30_000);

afterAll(async () => {
  if (sqlStripe) {
    await sqlStripe.end({ timeout: 0 }).catch(() => {});
    sqlStripe = null;
  }
}, 10_000);

async function stripeReq(path: string, init: RequestInit = {}): Promise<Response> {
  return await appWithStripe.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tokenStripe}` },
  });
}

describe("admin-billing /checkout + /portal", () => {
  it("POST /checkout без auth → 401", async () => {
    if (!sqlStripe) return;
    const res = await appWithStripe.request("/api/admin/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter" }),
    });
    expect(res.status).toBe(401);
  });

  it("/billing/plans включает stripeEnabled=true", async () => {
    if (!sqlStripe) return;
    const res = await stripeReq("/api/admin/billing/plans");
    const body = (await res.json()) as { stripeEnabled: boolean };
    expect(body.stripeEnabled).toBe(true);
  });

  it("invalid plan → 400", async () => {
    if (!sqlStripe) return;
    const res = await stripeReq("/api/admin/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "free" }),
    });
    expect(res.status).toBe(400);
  });

  it("invalid json → 400", async () => {
    if (!sqlStripe) return;
    const res = await stripeReq("/api/admin/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });

  it("valid /checkout starter → создаёт customer + session, возвращает URL", async () => {
    if (!sqlStripe) return;
    stripeCalls.length = 0;
    const res = await stripeReq("/api/admin/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; url: string; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.url).toContain("checkout.stripe.com");
    expect(body.sessionId).toMatch(/^cs_test_/);

    // Stripe API called: customers + checkout sessions
    const calls = stripeCalls.map((c) => c.url);
    expect(calls.some((u) => u.includes("/v1/customers"))).toBe(true);
    expect(calls.some((u) => u.includes("/v1/checkout/sessions"))).toBe(true);

    // Form-encoded body должен содержать price + tenant_id + trial.
    const checkoutCall = stripeCalls.find((c) => c.url.includes("/checkout/sessions"));
    expect(checkoutCall!.body).toContain("price_starter_test");
    expect(checkoutCall!.body).toContain("trial_period_days");
    expect(checkoutCall!.body).toContain(`client_reference_id=${tenantIdStripe}`);

    // stripe_customers row persisted.
    const [cust] = await dbStripe
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.tenantId, tenantIdStripe));
    expect(cust).toBeDefined();
    expect(cust!.stripeCustomerId).toMatch(/^cus_/);
  });

  it("second /checkout reuses existing customer (не дёргает /v1/customers)", async () => {
    if (!sqlStripe) return;
    stripeCalls.length = 0;
    const res = await stripeReq("/api/admin/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(200);
    const customerCalls = stripeCalls.filter((c) => c.url.endsWith("/v1/customers"));
    expect(customerCalls.length).toBe(0); // НЕ создан второй customer
  });

  it("POST /portal без существующего customer → 404", async () => {
    if (!sqlStripe) return;
    // Tenant 2 без checkout — /portal fail'нет.
    const sa = await appWithStripe.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "stripe-b@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string };
    const res = await appWithStripe.request("/api/admin/billing/portal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sba.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("POST /portal после checkout → возвращает portal URL", async () => {
    if (!sqlStripe) return;
    const res = await stripeReq("/api/admin/billing/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("billing.stripe.com");
  });

  it("если STRIPE_SECRET_KEY не задан → /checkout 503", async () => {
    if (!sqlStripe) return;
    // Отдельный app instance без stripe config.
    const appNoStripe = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    appNoStripe.route("/", makeAuthRoutes({ db: dbStripe as any, secret: SECRET }));
    appNoStripe.use(
      "/api/admin/*",
      makeRequireAuth({ db: dbStripe as never, secret: SECRET }),
    );
    appNoStripe.route("/", makeAdminBillingRoutes({ db: dbStripe }));

    const res = await appNoStripe.request("/api/admin/billing/checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenStripe}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ plan: "starter" }),
    });
    expect(res.status).toBe(503);
  });
});
