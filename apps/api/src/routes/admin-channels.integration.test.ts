// Integration test для admin-channels endpoints. Isolated PG → миграции →
// signup admin → POST create channel (с fake fetch для Telegram getMe) →
// list → delete. Проверяем что token encrypted в tenant_secrets и не
// возвращается через GET.

import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  schema,
  tenantSecrets,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminChannelsRoutes } from "./admin-channels.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_chan_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-channels-flow-12345";
const MASTER_KEY_HEX = "a".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantIdA = 0;
let tokenB = "";
let tenantIdB = 0;

// Tracking для setWebhook вызовов чтобы тест мог проверить что fetch был.
const setWebhookCalls: Array<{ token: string; url: string; secretToken?: string }> = [];

/**
 * Fake fetch для Telegram getMe + setWebhook. Возвращает фиксированного
 * bot'а для "good" токенов, 401 если число-часть начинается на "9999".
 * setWebhook records запрос в setWebhookCalls для assertion'ов.
 */
const fakeTelegramFetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // setWebhook intercept
  if (url.includes("/setWebhook")) {
    const tokenMatch = url.match(/\/bot([^/]+)\/setWebhook/);
    const bodyStr = init?.body ? String(init.body) : "{}";
    const body = JSON.parse(bodyStr) as {
      url?: string;
      secret_token?: string;
    };
    setWebhookCalls.push({
      token: tokenMatch?.[1] ?? "",
      url: body.url ?? "",
      ...(body.secret_token ? { secretToken: body.secret_token } : {}),
    });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  // Token живёт в URL: /bot<TOKEN>/getMe
  const m = url.match(/\/bot([^/]+)\/getMe/);
  const token = m?.[1] ?? "";
  if (token.startsWith("9999")) {
    return new Response(
      JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  // Derive bot username from token: last 8 chars → "_bot_<x>"
  const username = `testbot_${token.slice(-6).replace(/[^a-z0-9_]/gi, "x")}`;
  return new Response(
    JSON.stringify({
      ok: true,
      result: {
        id: 12345,
        is_bot: true,
        first_name: "Test Bot",
        username,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

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
    app.route(
      "/",
      makeAdminChannelsRoutes({
        db,
        masterKeyHex: MASTER_KEY_HEX,
        fetchImpl: fakeTelegramFetch,
        publicUrl: "https://api.example.test",
        webhookSecret: "test-webhook-secret-12345",
      }),
    );

    // Tenant A
    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "chan-a@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
    tokenA = sba.token;
    tenantIdA = sba.admin.tenantId;

    // Tenant B (cross-tenant isolation)
    const sb = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "chan-b@demo.io", password: "strong-pwd-12345" }),
    });
    const sbb = (await sb.json()) as { token: string; admin: { tenantId: number } };
    tokenB = sbb.token;
    tenantIdB = sbb.admin.tenantId;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin-channels CRUD", () => {
  it("GET без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/channels");
    expect(res.status).toBe(401);
  });

  it("GET с auth, нет channels → empty list", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("POST с invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST без botToken → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST с malformed token (no colon) → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "not-a-valid-format" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST с rejected token (fake Telegram 401) → 401", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "9999999999:abcdefghijklmnopqrstuvwxyz123456" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST с valid token → создаёт channel + encrypted token + auto-setWebhook", async () => {
    if (!sql) return;
    setWebhookCalls.length = 0;
    const goodToken = "1234567890:abcdefghijklmnopqrstuvwxyz123456ABCD";
    const res = await authReq(tokenA, "/api/admin/channels/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: goodToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      id: number;
      updated: boolean;
      username: string;
      botId: number;
      webhookSet: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(false);
    expect(body.id).toBeGreaterThan(0);
    expect(body.username).toMatch(/^testbot_/);
    expect(body.botId).toBe(12345);
    // Auto-setWebhook fired.
    expect(body.webhookSet).toBe(true);
    expect(setWebhookCalls.length).toBe(1);
    const call = setWebhookCalls[0]!;
    expect(call.token).toBe(goodToken);
    expect(call.url).toMatch(/^https:\/\/api\.example\.test\/webhook\/telegram\//);
    expect(call.secretToken).toBe("test-webhook-secret-12345");

    // Verify channel row.
    const [chan] = await db
      .select()
      .from(channels)
      .where(
        and(eq(channels.tenantId, tenantIdA), eq(channels.kind, "telegram_bot")),
      );
    expect(chan).toBeDefined();
    expect(chan!.credentialsRef).toBe(`channel_telegram_bot_${body.username}`);
    expect(chan!.status).toBe("active");

    // Verify secret encrypted in tenant_secrets.
    const [secret] = await db
      .select()
      .from(tenantSecrets)
      .where(
        and(
          eq(tenantSecrets.tenantId, tenantIdA),
          eq(tenantSecrets.key, `channel_telegram_bot_${body.username}`),
        ),
      );
    expect(secret).toBeDefined();
    expect(secret!.encryptedValue).not.toBe(goodToken); // encrypted
    expect(secret!.encryptedValue.length).toBeGreaterThan(20);
  });

  it("GET после insert → list содержит channel с hasCredentials=true (без secret_ref value)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        kind: string;
        externalId: string;
        status: string;
        hasCredentials: boolean;
      }>;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const tg = body.items.find((i) => i.kind === "telegram_bot");
    expect(tg).toBeDefined();
    expect(tg!.hasCredentials).toBe(true);
    // Response не содержит raw secret_ref value
    expect(JSON.stringify(body)).not.toContain("1234567890:abcdef");
  });

  it("POST с тем же ботом → re-encrypts (updated=true)", async () => {
    if (!sql) return;
    const goodToken = "1234567890:abcdefghijklmnopqrstuvwxyz123456ABCD";
    const res = await authReq(tokenA, "/api/admin/channels/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: goodToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean };
    expect(body.updated).toBe(true);
  });

  it("cross-tenant isolation: B не видит channel A", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
    expect(tenantIdA).not.toBe(tenantIdB);
  });

  it("DELETE → row удаляется, tenant_secrets row остаётся", async () => {
    if (!sql) return;
    const list = await (await authReq(tokenA, "/api/admin/channels")).json();
    // biome-ignore lint/suspicious/noExplicitAny: test
    const id = (list as any).items[0].id;
    const res = await authReq(tokenA, `/api/admin/channels/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const chanRows = await db
      .select()
      .from(channels)
      .where(and(eq(channels.tenantId, tenantIdA), eq(channels.id, id)));
    expect(chanRows).toHaveLength(0);

    // tenant_secrets row сохраняется.
    const secretRows = await db
      .select()
      .from(tenantSecrets)
      .where(eq(tenantSecrets.tenantId, tenantIdA));
    expect(secretRows.length).toBeGreaterThan(0);
  });

  it("DELETE несуществующий id → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/999999", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE invalid id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/not-a-number", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/channels", {
      headers: { Authorization: "Bearer not-a-valid-token" },
    });
    expect(res.status).toBe(401);
  });
});
