// Integration test для admin-onboarding endpoint.
//
// Новые правила `done`:
//   - generic тенант: channel + chat LLM (KB и embed — НЕ требуются).
//   - exchange тенант (funnel slug='exchange'): + ≥1 активный курс + ≥1 реквизит.
//
// Изолированная PG; self-skip без DATABASE_URL.

import { setEncryptedSecret, withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  exchangeRates,
  funnels,
  kbDocuments,
  llmProviderConfigs,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminOnboardingRoutes } from "./admin-onboarding.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_onb_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-onb-flow-12345";
const MASTER_KEY = "a".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

interface StatusBody {
  channelConnected: boolean;
  chatLlmConfigured: boolean;
  hasKbDocuments: boolean;
  isExchange: boolean;
  funnelInstalled: boolean;
  activeRateCount: number;
  requisiteCount: number;
  channelKind?: string;
  channelExternalId?: string;
  chatProvider?: string;
  chatModel?: string;
  chatHasSecret?: boolean;
  done: boolean;
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
  // allowSignup:true — публичная регистрация по умолчанию закрыта; тесту нужен tenant.
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET, allowSignup: true }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminOnboardingRoutes({ db }));

  const sa = await signupReq("onb@demo.io");
  token = sa.token;
  tenantId = sa.tenantId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function signupReq(email: string): Promise<{ token: string; tenantId: number }> {
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "strong-pwd-12345" }),
  });
  const j = (await sa.json()) as { token: string; admin: { tenantId: number } };
  return { token: j.token, tenantId: j.admin.tenantId };
}

async function getStatus(tk: string): Promise<StatusBody> {
  const res = await app.request("/api/admin/onboarding-status", {
    headers: { Authorization: `Bearer ${tk}` },
  });
  return (await res.json()) as StatusBody;
}

const NOW = Math.floor(Date.now() / 1000);

async function insertChannel(tid: number, externalId = "testbot_42") {
  await withTenant(db, tid, (tx) =>
    tx.insert(channels).values({
      tenantId: tid,
      kind: "telegram_bot",
      externalId,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function insertChatLlm(tid: number) {
  await setEncryptedSecret({
    db,
    tenantId: tid,
    key: "llm_chat_apikey",
    value: "sk-test",
    masterKeyHex: MASTER_KEY,
    nowEpoch: NOW,
  });
  await withTenant(db, tid, (tx) =>
    tx.insert(llmProviderConfigs).values({
      tenantId: tid,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      secretRef: "llm_chat_apikey",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function insertExchangeFunnel(tid: number) {
  await withTenant(db, tid, (tx) =>
    tx.insert(funnels).values({
      tenantId: tid,
      slug: "exchange",
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function insertActiveRate(tid: number) {
  await withTenant(db, tid, (tx) =>
    tx.insert(exchangeRates).values({
      tenantId: tid,
      asset: "USDT",
      network: "trc20",
      baseRate: 36.5,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function insertRequisite(tid: number) {
  await setEncryptedSecret({
    db,
    tenantId: tid,
    key: "exchange_wallet_usdt_trc20",
    value: "TXyz...",
    masterKeyHex: MASTER_KEY,
    nowEpoch: NOW,
  });
}

describe("admin-onboarding-status — auth + generic", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/onboarding-status");
    expect(res.status).toBe(401);
  });

  it("fresh tenant → all false, done=false", async () => {
    if (!sql) return;
    const body = await getStatus(token);
    expect(body.channelConnected).toBe(false);
    expect(body.chatLlmConfigured).toBe(false);
    expect(body.hasKbDocuments).toBe(false);
    expect(body.isExchange).toBe(false);
    expect(body.done).toBe(false);
  });

  it("insert chat LLM → chatLlmConfigured=true, done still false (нет канала)", async () => {
    if (!sql) return;
    await insertChatLlm(tenantId);
    const body = await getStatus(token);
    expect(body.chatLlmConfigured).toBe(true);
    expect(body.chatProvider).toBe("openai");
    expect(body.chatHasSecret).toBe(true);
    expect(body.done).toBe(false);
  });

  it("insert channel → generic tenant done=true (KB НЕ требуется)", async () => {
    if (!sql) return;
    await insertChannel(tenantId);
    const body = await getStatus(token);
    expect(body.channelConnected).toBe(true);
    expect(body.channelExternalId).toBe("testbot_42");
    expect(body.hasKbDocuments).toBe(false);
    expect(body.done).toBe(true); // generic: channel + chat достаточно
  });

  it("paused channel НЕ считается active", async () => {
    if (!sql) return;
    await db
      .update(channels)
      .set({ status: "paused", updatedAt: NOW })
      .where(eq(channels.tenantId, tenantId));
    const before = await getStatus(token);
    expect(before.channelConnected).toBe(false);
    expect(before.done).toBe(false);
    await db
      .update(channels)
      .set({ status: "active", updatedAt: NOW })
      .where(eq(channels.tenantId, tenantId));
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/onboarding-status", {
      headers: { Authorization: "Bearer not-a-valid-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("admin-onboarding-status — exchange gating", () => {
  it("exchange: воронка + канал + chat, без курса → НЕ done", async () => {
    if (!sql) return;
    const t = await signupReq("onb-ex-norate@demo.io");
    await insertExchangeFunnel(t.tenantId);
    await insertChannel(t.tenantId, "exbot_1");
    await insertChatLlm(t.tenantId);
    await insertRequisite(t.tenantId);
    const body = await getStatus(t.token);
    expect(body.isExchange).toBe(true);
    expect(body.funnelInstalled).toBe(true);
    expect(body.activeRateCount).toBe(0);
    expect(body.done).toBe(false);
  });

  it("exchange: курс есть, реквизита нет → НЕ done", async () => {
    if (!sql) return;
    const t = await signupReq("onb-ex-noreq@demo.io");
    await insertExchangeFunnel(t.tenantId);
    await insertChannel(t.tenantId, "exbot_2");
    await insertChatLlm(t.tenantId);
    await insertActiveRate(t.tenantId);
    const body = await getStatus(t.token);
    expect(body.isExchange).toBe(true);
    expect(body.activeRateCount).toBe(1);
    expect(body.requisiteCount).toBe(0);
    expect(body.done).toBe(false);
  });

  it("exchange: канал + chat + воронка + курс + реквизит → done", async () => {
    if (!sql) return;
    const t = await signupReq("onb-ex-full@demo.io");
    await insertExchangeFunnel(t.tenantId);
    await insertChannel(t.tenantId, "exbot_3");
    await insertChatLlm(t.tenantId);
    await insertActiveRate(t.tenantId);
    await insertRequisite(t.tenantId);
    const body = await getStatus(t.token);
    expect(body.isExchange).toBe(true);
    expect(body.activeRateCount).toBe(1);
    expect(body.requisiteCount).toBe(1);
    expect(body.done).toBe(true);
  });

  it("kbDocuments не требуется для done (generic)", async () => {
    if (!sql) return;
    await db.insert(kbDocuments).values({
      tenantId,
      source: "test-source",
      title: "Test doc",
      contentHash: "hash-123",
      createdAt: NOW,
    });
    const body = await getStatus(token);
    expect(body.hasKbDocuments).toBe(true);
    expect(body.done).toBe(true);
  });
});
