// Integration test для admin-onboarding endpoint. Sequence:
//   1. fresh tenant → status: всё false, done=false
//   2. insert chat config → chatLlmConfigured=true
//   3. insert channel → channelConnected=true
//   4. insert kb_document → hasKbDocuments=true, done=true (когда все три)

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
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
    app.route("/", makeAdminOnboardingRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "onb@demo.io", password: "strong-pwd-12345" }),
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
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin-onboarding-status", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/onboarding-status");
    expect(res.status).toBe(401);
  });

  it("fresh tenant → all false, done=false", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/onboarding-status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channelConnected: boolean;
      chatLlmConfigured: boolean;
      hasKbDocuments: boolean;
      done: boolean;
    };
    expect(body.channelConnected).toBe(false);
    expect(body.chatLlmConfigured).toBe(false);
    expect(body.hasKbDocuments).toBe(false);
    expect(body.done).toBe(false);
  });

  it("insert chat LLM config → chatLlmConfigured=true, done still false", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId,
      key: "llm_chat_apikey",
      value: "sk-test",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await db.insert(llmProviderConfigs).values({
      tenantId,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      secretRef: "llm_chat_apikey",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authReq("/api/admin/onboarding-status");
    const body = (await res.json()) as {
      chatLlmConfigured: boolean;
      chatProvider: string;
      chatModel: string;
      chatHasSecret: boolean;
      done: boolean;
    };
    expect(body.chatLlmConfigured).toBe(true);
    expect(body.chatProvider).toBe("openai");
    expect(body.chatModel).toBe("gpt-4o-mini");
    expect(body.chatHasSecret).toBe(true);
    expect(body.done).toBe(false);
  });

  it("insert active channel → channelConnected=true, externalId returned", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await db.insert(channels).values({
      tenantId,
      kind: "telegram_bot",
      externalId: "testbot_42",
      credentialsRef: "channel_telegram_bot_testbot_42",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authReq("/api/admin/onboarding-status");
    const body = (await res.json()) as {
      channelConnected: boolean;
      channelKind: string;
      channelExternalId: string;
      done: boolean;
    };
    expect(body.channelConnected).toBe(true);
    expect(body.channelKind).toBe("telegram_bot");
    expect(body.channelExternalId).toBe("testbot_42");
    expect(body.done).toBe(false); // KB пуст
  });

  it("paused channel НЕ считается active", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(channels)
      .set({ status: "paused", updatedAt: now })
      .where(eq(channels.tenantId, tenantId));
    const beforeRes = await authReq("/api/admin/onboarding-status");
    const before = (await beforeRes.json()) as { channelConnected: boolean };
    expect(before.channelConnected).toBe(false);
    await db
      .update(channels)
      .set({ status: "active", updatedAt: now })
      .where(eq(channels.tenantId, tenantId));
  });

  it("insert kb_document → hasKbDocuments=true, done=true (all three)", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await db.insert(kbDocuments).values({
      tenantId,
      source: "test-source",
      title: "Test doc",
      contentHash: "hash-123",
      createdAt: now,
    });
    const res = await authReq("/api/admin/onboarding-status");
    const body = (await res.json()) as {
      channelConnected: boolean;
      chatLlmConfigured: boolean;
      hasKbDocuments: boolean;
      done: boolean;
    };
    expect(body.hasKbDocuments).toBe(true);
    expect(body.channelConnected).toBe(true);
    expect(body.chatLlmConfigured).toBe(true);
    expect(body.done).toBe(true);
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/onboarding-status", {
      headers: { Authorization: "Bearer not-a-valid-token" },
    });
    expect(res.status).toBe(401);
  });
});
