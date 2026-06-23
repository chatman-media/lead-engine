// Integration test для admin-diagnostics. Sequences:
//   1. fresh tenant — все checks fail/warn
//   2. add chat config → llm.chat=pass
//   3. add channel → channel.telegram pass (fake getMe)
//   4. add embed config → llm.embed=pass

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  llmProviderConfigs,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminDiagnosticsRoutes } from "./admin-diagnostics.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_diag_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-diag-flow-12345";
const MASTER_KEY = "a".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

const fakeTelegramFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = url.match(/\/bot([^/]+)\/getMe/);
  const tok = m?.[1] ?? "";
  if (tok.startsWith("9999")) {
    return new Response(
      JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({
      ok: true,
      result: { id: 42, is_bot: true, first_name: "Diag Bot", username: "diagbot" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

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
  app.route(
    "/",
    makeAdminDiagnosticsRoutes({
      db,
      masterKeyHex: MASTER_KEY,
      fetchImpl: fakeTelegramFetch,
    }),
  );

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "diag@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  token = sba.token;
  tenantId = sba.admin.tenantId;
}, 30_000);

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

type Status = "pass" | "warn" | "fail" | "skip";
interface CheckResp {
  checks: Array<{ name: string; status: Status; message?: string; latencyMs?: number }>;
  summary: { overall: Status; passed: number; failed: number; warned: number };
}

describe("admin-diagnostics", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/diagnostics");
    expect(res.status).toBe(401);
  });

  it("fresh tenant → channel fail, llm.chat fail, llm.embed warn", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/diagnostics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CheckResp;
    expect(body.summary.overall).toBe("fail");
    expect(body.checks.find((c) => c.name === "channel.telegram")?.status).toBe("fail");
    expect(body.checks.find((c) => c.name === "llm.chat")?.status).toBe("fail");
    expect(body.checks.find((c) => c.name === "llm.embed")?.status).toBe("warn");
  });

  it("add chat config → llm.chat pass", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId,
      key: "llm_chat_apikey",
      value: "sk-diag-test",
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

    const body = (await (await authReq("/api/admin/diagnostics")).json()) as CheckResp;
    const chat = body.checks.find((c) => c.name === "llm.chat")!;
    expect(chat.status).toBe("pass");
    expect(chat.message).toContain("openai");
    expect(chat.message).toContain("gpt-4o-mini");
  });

  it("add channel + valid token → channel.telegram pass", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId,
      key: "channel_telegram_bot_diagbot",
      value: "1234567890:valid-token-with-required-30-chars",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await db.insert(channels).values({
      tenantId,
      kind: "telegram_bot",
      externalId: "diagbot",
      credentialsRef: "channel_telegram_bot_diagbot",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const body = (await (await authReq("/api/admin/diagnostics")).json()) as CheckResp;
    const chan = body.checks.find((c) => c.name === "channel.telegram")!;
    expect(chan.status).toBe("pass");
    expect(chan.message).toContain("diagbot");
  });

  it("add embed config → llm.embed pass + summary overall=pass", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId,
      key: "llm_embed_apikey",
      value: "sk-diag-embed",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await db.insert(llmProviderConfigs).values({
      tenantId,
      purpose: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      secretRef: "llm_embed_apikey",
      embedDim: 1536,
      createdAt: now,
      updatedAt: now,
    });

    const body = (await (await authReq("/api/admin/diagnostics")).json()) as CheckResp;
    expect(body.summary.overall).toBe("pass");
    expect(body.summary.failed).toBe(0);
    const embed = body.checks.find((c) => c.name === "llm.embed")!;
    expect(embed.status).toBe("pass");
    expect(embed.message).toContain("1536");
  });

  it("rotate token → next run shows fresh latency", async () => {
    if (!sql) return;
    const res = await authReq("/api/admin/diagnostics");
    const body = (await res.json()) as CheckResp & {
      checks: Array<{ name: string; latencyMs?: number }>;
    };
    const chan = body.checks.find((c) => c.name === "channel.telegram")!;
    // latencyMs = Math.round(performance.now() - start): на быстром раннере
    // проверка укладывается в <0.5 мс и округляется в 0 — это валидно. Поэтому
    // проверяем, что латентность записана и в разумных пределах [0, 5000), а не
    // строго > 0 (иначе тест флейкает в CI, см. падение на быстром runner'е).
    expect(chan.latencyMs).toBeGreaterThanOrEqual(0);
    expect(chan.latencyMs).toBeLessThan(5000);
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/diagnostics", {
      headers: { Authorization: "Bearer bad" },
    });
    expect(res.status).toBe(401);
  });
});
