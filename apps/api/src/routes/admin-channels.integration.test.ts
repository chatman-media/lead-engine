// Integration test для admin-channels endpoints. Isolated PG → миграции →
// signup admin → POST create channel (с fake fetch для Telegram getMe) →
// list → delete. Проверяем что token encrypted в tenant_secrets и не
// возвращается через GET.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  schema,
  tenantSecrets,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { UserbotLoginStore } from "../lib/userbot-login-store.ts";
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
// Второй app с userbotLoginStore — чтобы пройти guard userbotEnabled() и
// добраться до валидации (phone/creds/loginId) без реального MTProto-логина.
let appUb: Hono;
let tokenA = "";
let tenantIdA = 0;
let tokenB = "";
let tenantIdB = 0;

// Tracking для setWebhook вызовов чтобы тест мог проверить что fetch был.
const setWebhookCalls: Array<{ token: string; url: string; secretToken?: string }> = [];

/**
 * Fake fetch для Telegram getMe + setWebhook + Meta Graph
 * `GET /<phone_number_id>` (для WhatsApp onboarding). Telegram: токен
 * `9999...` rejected, иначе bot returned. WhatsApp: phoneNumberId
 * начинающийся на `9999` → 404, accessToken `bad-` → 401.
 */
const fakeTelegramFetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // ── VK API intercept ─────────────────────────────────────────────────
  // Pattern: https://api.vk.com/method/groups.getById
  if (url.startsWith("https://api.vk.com/method/")) {
    const rawBody = init?.body;
    const form =
      rawBody instanceof URLSearchParams
        ? rawBody
        : new URLSearchParams(typeof rawBody === "string" ? rawBody : "");
    const token = form.get("access_token") ?? "";
    const groupId = form.get("group_id") ?? "";
    if (token.includes("bad-vk-token")) {
      return new Response(
        JSON.stringify({
          error: { error_code: 5, error_msg: "User authorization failed" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (groupId === "999999") {
      return new Response(
        JSON.stringify({ error: { error_code: 100, error_msg: "group not found" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        response: [
          {
            id: Number(groupId),
            name: "Acme VK",
            screen_name: "acme_vk",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  // ── WhatsApp Meta Graph intercept ────────────────────────────────────
  // Pattern: https://graph.facebook.com/v18.0/<phone_number_id>
  if (url.startsWith("https://graph.facebook.com/")) {
    const headers = init?.headers as Record<string, string> | undefined;
    const auth = headers?.authorization ?? headers?.Authorization ?? "";
    if (auth.includes("bad-token")) {
      return new Response(
        JSON.stringify({ error: { code: 190, message: "Invalid OAuth access token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    // ── Facebook Messenger page-info: GET /me?fields=id,name ──────────────
    // Token `unexpected-id` → Graph returns a non-numeric id (→ 502 in route).
    if (url.includes("/me?fields=id,name")) {
      if (auth.includes("unexpected-id")) {
        return new Response(JSON.stringify({ id: "not-a-number", name: "X" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "112233445566", name: "Acme Page" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const m = url.match(/\/v\d+\.\d+\/(\d+)$/);
    const phoneId = m?.[1] ?? "";
    if (phoneId.startsWith("9999")) {
      return new Response(
        JSON.stringify({ error: { code: 100, message: "Unsupported get request" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: phoneId,
        verified_name: "Acme Demo",
        display_phone_number: "+1 555-0100",
        quality_rating: "GREEN",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
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
    makeAdminChannelsRoutes({
      db,
      masterKeyHex: MASTER_KEY_HEX,
      fetchImpl: fakeTelegramFetch,
      publicUrl: "https://api.example.test",
      webhookSecret: "test-webhook-secret-12345",
      whatsappVerifyToken: "test-wa-verify-token",
    }),
  );

  // Userbot-enabled app: login-store задан, но MTProto-кредов НЕТ (ни env,
  // ни tenant_secrets) — /start доходит до 400 creds_required без сети.
  appUb = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  appUb.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  appUb.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  appUb.route(
    "/",
    makeAdminChannelsRoutes({
      db,
      masterKeyHex: MASTER_KEY_HEX,
      fetchImpl: fakeTelegramFetch,
      userbotLoginStore: new UserbotLoginStore(),
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
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(token: string, path: string, init: RequestInit = {}): Promise<Response> {
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
      .where(and(eq(channels.tenantId, tenantIdA), eq(channels.kind, "telegram_bot")));
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

describe("admin-channels POST /whatsapp", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumberId: "1", accessToken: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("без phoneNumberId → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: "valid-token" }),
    });
    expect(res.status).toBe(400);
  });

  it("без accessToken → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumberId: "1234567890" }),
    });
    expect(res.status).toBe(400);
  });

  it("invalid phoneNumberId format → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumberId: "abc", accessToken: "tok" }),
    });
    expect(res.status).toBe(400);
  });

  it("invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  it("bad-token (Meta 401) → 401", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: "1234567890",
        accessToken: "bad-token-here",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("non-existent phoneNumberId (9999...) → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: "9999999999",
        accessToken: "good-token",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("valid token + phone → channel created + encrypted + webhookSetupHint", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: "1234567890",
        accessToken: "EAAJZBgoodtoken",
        businessAccountId: "987654321098765",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      id: number;
      updated: boolean;
      phoneNumberId: string;
      verifiedName?: string;
      webhookSetupHint?: { url: string; verifyToken: string };
    };
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(false);
    expect(body.phoneNumberId).toBe("1234567890");
    expect(body.verifiedName).toBe("Acme Demo");
    // Webhook hint содержит публичный URL + verify_token.
    expect(body.webhookSetupHint).toBeDefined();
    expect(body.webhookSetupHint!.url).toMatch(/\/webhook\/whatsapp\//);
    expect(body.webhookSetupHint!.verifyToken).toBe("test-wa-verify-token");

    // Raw access token не в response.
    expect(JSON.stringify(body)).not.toContain("EAAJZBgoodtoken");
  });

  it("re-POST same phoneNumberId → updated=true (token rotation)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: "1234567890",
        accessToken: "EAAJZBrotated-token",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean };
    expect(body.updated).toBe(true);
  });

  it("GET /channels → WhatsApp канал в списке с hasCredentials=true", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels");
    const body = (await res.json()) as {
      items: Array<{ kind: string; externalId: string; hasCredentials: boolean }>;
    };
    const wa = body.items.find((i) => i.kind === "whatsapp");
    expect(wa).toBeDefined();
    expect(wa!.externalId).toBe("1234567890");
    expect(wa!.hasCredentials).toBe(true);
  });
});

describe("admin-channels POST /web + GET /web/snippet", () => {
  it("POST /web без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/channels/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("POST /web invalid externalId → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "ab" }), // too short
    });
    expect(res.status).toBe(400);
  });

  it("POST /web без body → создаёт канал с tenant.slug как externalId + snippet", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      id: number;
      updated: boolean;
      externalId: string;
      snippet: { html: string; wsUrl: string; demoUrl: string };
    };
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(false);
    expect(body.externalId.length).toBeGreaterThan(0);
    expect(body.snippet.html).toContain("<script");
    expect(body.snippet.html).toContain(body.externalId);
    expect(body.snippet.wsUrl).toMatch(/^wss?:\/\//);
    expect(body.snippet.wsUrl).toContain("/ws/");
    expect(body.snippet.demoUrl).toContain("/demo/web-chat.html");
  });

  it("POST /web с brandName + primaryColor → metadata + snippet с data-attrs", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brandName: "Acme Support",
        primaryColor: "#6aa6ff",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: boolean;
      brandName?: string;
      primaryColor?: string;
      snippet: { html: string };
    };
    expect(body.updated).toBe(true); // существующий с предыдущего теста
    expect(body.brandName).toBe("Acme Support");
    expect(body.primaryColor).toBe("#6aa6ff");
    expect(body.snippet.html).toContain('data-brand="Acme Support"');
    expect(body.snippet.html).toContain('data-color="#6aa6ff"');
  });

  it("POST /web с невалидным primaryColor → игнорируется (не в snippet)", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primaryColor: "not-a-hex" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snippet: { html: string } };
    expect(body.snippet.html).not.toContain("data-color=");
  });

  it("GET /web/snippet → возвращает свежий snippet для активного канала", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web/snippet");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      externalId: string;
      snippet: { html: string };
    };
    expect(body.ok).toBe(true);
    expect(body.snippet.html).toContain("<script");
  });

  it("GET /web/snippet для tenant'а без web-канала → 404", async () => {
    if (!sql) return;
    // tenantA активирует только Telegram в этих тестах
    const res = await authReq(tokenA, "/api/admin/channels/web/snippet");
    expect(res.status).toBe(404);
  });

  it("POST /web invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });

  it("snippet НЕ leak'ит чувствительные данные", async () => {
    if (!sql) return;
    const res = await authReq(tokenB, "/api/admin/channels/web/snippet");
    const body = (await res.json()) as { snippet: { html: string; wsUrl: string } };
    // Master key / API keys / etc — НЕ в snippet
    expect(body.snippet.html).not.toMatch(/sk-|api_key|secret/i);
    expect(body.snippet.wsUrl).not.toMatch(/sk-|api_key|secret/i);
  });
});

describe("POST /api/admin/channels/facebook", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/channels/facebook", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });

  it("без pageAccessToken → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyToken: "vt" }),
    });
    expect(res.status).toBe(400);
  });

  it("Meta отклонил токен (bad-token) → 401", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageAccessToken: "bad-token-xyz" }),
    });
    expect(res.status).toBe(401);
  });

  it("Meta вернула не-числовой page id → 502", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageAccessToken: "unexpected-id-token" }),
    });
    expect(res.status).toBe(502);
  });

  it("happy: создаёт facebook-канал, шифрует токен + verify/appSecret", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageAccessToken: "EAAG-good-page-token",
        verifyToken: "my-verify",
        appSecret: "my-app-secret",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pageId: string; pageName?: string };
    expect(body.ok).toBe(true);
    expect(body.pageId).toBe("112233445566");
    expect(body.pageName).toBe("Acme Page");
    // канал создан
    const chRows = await db
      .select({ kind: channels.kind, externalId: channels.externalId })
      .from(channels)
      .where(and(eq(channels.tenantId, tenantIdA), eq(channels.kind, "facebook")));
    expect(chRows.some((r) => r.externalId === "112233445566")).toBe(true);
    // токен зашифрован в tenant_secrets
    const secrets = await db
      .select({ key: tenantSecrets.key })
      .from(tenantSecrets)
      .where(eq(tenantSecrets.tenantId, tenantIdA));
    const keys = secrets.map((s) => s.key);
    expect(keys.some((k) => k.startsWith("channel_facebook_"))).toBe(true);
  });
});

describe("POST /api/admin/channels/vk", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/channels/vk", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/vk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });

  it("без confirmationCode → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/vk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: "123456", accessToken: "vk-good-token" }),
    });
    expect(res.status).toBe(400);
  });

  it("VK отклонил токен → 401", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/vk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "123456",
        accessToken: "bad-vk-token",
        confirmationCode: "confirm-123",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("VK не нашёл группу → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/vk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "999999",
        accessToken: "vk-good-token",
        confirmationCode: "confirm-123",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("happy: создаёт vk-канал, шифрует токен + callback secrets", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/vk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "123456",
        accessToken: "vk-good-token",
        confirmationCode: "confirm-123",
        secretKey: "secret-123",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      groupId: string;
      groupName?: string;
      screenName?: string;
      webhookSetupHint?: { url: string; confirmationCode: string; eventTypes: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.groupId).toBe("123456");
    expect(body.groupName).toBe("Acme VK");
    expect(body.screenName).toBe("acme_vk");
    expect(body.webhookSetupHint?.url).toContain("/webhook/vk/");
    expect(body.webhookSetupHint?.confirmationCode).toBe("confirm-123");
    expect(body.webhookSetupHint?.eventTypes).toEqual(["message_new"]);

    const chRows = await db
      .select({ kind: channels.kind, externalId: channels.externalId })
      .from(channels)
      .where(and(eq(channels.tenantId, tenantIdA), eq(channels.kind, "vk")));
    expect(chRows.some((r) => r.externalId === "123456")).toBe(true);

    const secrets = await db
      .select({ key: tenantSecrets.key })
      .from(tenantSecrets)
      .where(eq(tenantSecrets.tenantId, tenantIdA));
    const keys = secrets.map((s) => s.key);
    expect(keys).toContain("channel_vk_123456");
    expect(keys).toContain("vk_confirmation_code");
    expect(keys).toContain("vk_secret_key");
  });
});

describe("DELETE /api/admin/channels/:id", () => {
  it("invalid id → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/abc", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("несуществующий канал → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/99999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("happy: удаляет канал tenant A", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [ch] = await db
      .insert(channels)
      .values({
        tenantId: tenantIdA,
        kind: "telegram_bot",
        externalId: "to-delete",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });
    const res = await authReq(tokenA, `/api/admin/channels/${ch!.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted: number };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1);
  });
});

describe("userbot routes — guards", () => {
  it("start: login-store не задан → 503", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/channels/userbot/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+79991234567" }),
    });
    expect(res.status).toBe(503);
  });

  it("verify / 2fa: login-store не задан → 503", async () => {
    if (!sql) return;
    for (const path of ["verify", "2fa"]) {
      const res = await authReq(tokenA, `/api/admin/channels/userbot/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: "x", code: "1", password: "p" }),
      });
      expect(res.status).toBe(503);
    }
  });

  async function ubReq(path: string, body: unknown): Promise<Response> {
    return appUb.request(`/api/admin/channels/userbot/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify(body),
    });
  }

  it("start: невалидный телефон → 400 phone_invalid", async () => {
    if (!sql) return;
    const res = await ubReq("start", { phone: "abc" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("phone_invalid");
  });

  it("start: apiId без apiHash → 400 creds_invalid", async () => {
    if (!sql) return;
    const res = await ubReq("start", { phone: "+79991234567", apiId: 123 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("userbot_creds_invalid");
  });

  it("start: валидный телефон, но кредов нет нигде → 400 creds_required", async () => {
    if (!sql) return;
    const res = await ubReq("start", { phone: "+79991234567" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("userbot_creds_required");
  });

  it("verify: нет loginId/code → 400", async () => {
    if (!sql) return;
    const res = await ubReq("verify", { loginId: "" });
    expect(res.status).toBe(400);
  });

  it("verify: неизвестный loginId → 410 login_expired", async () => {
    if (!sql) return;
    const res = await ubReq("verify", { loginId: "nope", code: "12345" });
    expect(res.status).toBe(410);
  });

  it("2fa: нет loginId/password → 400", async () => {
    if (!sql) return;
    const res = await ubReq("2fa", { loginId: "x" });
    expect(res.status).toBe(400);
  });

  it("2fa: неизвестный loginId → 410", async () => {
    if (!sql) return;
    const res = await ubReq("2fa", { loginId: "nope", password: "secret" });
    expect(res.status).toBe(410);
  });
});
