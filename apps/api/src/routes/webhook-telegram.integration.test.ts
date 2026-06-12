// Integration test for the Telegram webhook. Real TelegramBotAdapter (parses
// the update, no API calls) + a minimal ChannelRegistry stub + the real
// processInbound pipeline (persists, deferReply, no reply strategy).
// Coverage epic #187 — apps/api untested routes.

import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  messages,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeAuthRoutes } from "./auth.ts";
import { makeTelegramWebhookRoutes } from "./webhook-telegram.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_tgwh_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-tgwh-flow-12345";
const TG_SECRET = "tg-webhook-secret-xyz";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
// Mutable registry entry — stub reads it lazily so routes can be registered
// before signup (Hono freezes the router after the first request).
let entry: Record<string, unknown> | null = null;
let appFull: Hono; // вариант со всеми опц. зависимостями (rate-limit/reply/field-extract)
let rlAllow = true;
let fieldExtractCalled = false;
let appFullEvents: string[] = [];

async function post(slug: string, body: unknown, secret: string | null, instance?: Hono): Promise<Response> {
  return (instance ?? app).request(`/webhook/telegram/${slug}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function tgUpdate(text: string, fromId = 7): unknown {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      chat: { id: fromId, type: "private" },
      from: { id: fromId, username: "kate" },
      date: 1700000000,
      text,
    },
  };
}

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
    const channelsStub = {
      getTelegramBotsByTenant: (slug: string) => (slug === "demo" && entry ? [entry] : []),
      // biome-ignore lint/suspicious/noExplicitAny: minimal ChannelRegistry stub
    } as any;
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeTelegramWebhookRoutes({ db: db as any, channels: channelsStub, webhookSecret: TG_SECRET }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tgwh@demo.io", password: "strong-pwd-12345" }),
    });
    tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;

    const channelDbId = await withTenant(db, tenantId, async (tx) => {
      const [ch] = await tx
        .insert(channels)
        .values({ tenantId, kind: "telegram_bot", externalId: "@demobot", status: "active" })
        .returning();
      return ch!.id;
    });

    const adapter = new TelegramBotAdapter({ id: String(channelDbId), token: "TKN", fetch: globalThis.fetch });
    entry = {
      tenantId,
      tenantSlug: "demo",
      channelDbId,
      kind: "telegram_bot",
      externalId: "@demobot",
      tenantPlan: "free",
      adapter,
    };

    appFull = new Hono();
    appFull.route(
      "/",
      makeTelegramWebhookRoutes({
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
        db: db as any,
        channels: channelsStub,
        webhookSecret: TG_SECRET,
        // biome-ignore lint/suspicious/noExplicitAny: rate-limiter fake
        rateLimiter: { check: () => (rlAllow ? { allowed: true } : { allowed: false, reason: "test", retryAfterSec: 30 }) } as any,
        // biome-ignore lint/suspicious/noExplicitAny: reply-strategy fake
        replyStrategy: { generate: async () => { appFullEvents.push("reply"); return []; } } as any,
        // biome-ignore lint/suspicious/noExplicitAny: field-extractor fake
        fieldExtractor: { extract: async () => { fieldExtractCalled = true; appFullEvents.push("field"); } } as any,
        // biome-ignore lint/suspicious/noExplicitAny: service catalog fake
        serviceCatalogRuntime: {
          extract: async () => {
            appFullEvents.push("catalog");
            return { created: [], skipped: [] };
          },
        } as any,
      }),
    );
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("webhook-telegram", () => {
  it("неверный secret → 401", async () => {
    if (!sql) return;
    expect((await post("demo", tgUpdate("hi"), "wrong")).status).toBe(401);
    expect((await post("demo", tgUpdate("hi"), null)).status).toBe(401);
  });

  it("неизвестный slug (нет канала) → 404", async () => {
    if (!sql) return;
    expect((await post("nope", tgUpdate("hi"), TG_SECRET)).status).toBe(404);
  });

  it("валидный secret + битый JSON → 400", async () => {
    if (!sql) return;
    expect((await post("demo", "{not json", TG_SECRET)).status).toBe(400);
  });

  it("валидный апдейт → processInbound persist → 200 + сообщение в БД", async () => {
    if (!sql) return;
    const res = await post("demo", tgUpdate("привет, обмен USDT"), TG_SECRET);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: boolean; result?: { persisted?: boolean } };
    expect(body.processed).toBe(true);
    expect(body.result?.persisted).toBe(true);

    const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.tenantId, tenantId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("rate-limit deny → 429", async () => {
    if (!sql) return;
    rlAllow = false;
    expect((await post("demo", tgUpdate("hi"), TG_SECRET, appFull)).status).toBe(429);
    rlAllow = true;
  });

  it("со всеми опц. зависимостями: 200 + field-extractor вызван", async () => {
    if (!sql) return;
    fieldExtractCalled = false;
    appFullEvents = [];
    const res = await post("demo", tgUpdate("обмен 1000 usdt"), TG_SECRET, appFull);
    expect(res.status).toBe(200);
    expect(fieldExtractCalled).toBe(true);
    expect(appFullEvents).toEqual(["field", "catalog", "reply"]);
  });
});

describe("webhook-telegram — callback_query (concierge service buttons)", () => {
  it("callback_query с srv: prefix → 200 (конвертируется в text-сообщение)", async () => {
    if (!sql) return;
    const cbUpdate = {
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: "cq123",
        from: { id: 7, username: "kate" },
        chat_instance: "ci1",
        data: "srv:transfer",
        message: {
          message_id: 1,
          date: 1700000000,
          chat: { id: 7, type: "private" },
        },
      },
    };
    const res = await post("demo", cbUpdate, TG_SECRET);
    expect(res.status).toBe(200);
  });

  it("callback_query без srv: prefix → 200 (не конвертируется, обрабатывается как есть)", async () => {
    if (!sql) return;
    const cbUpdate = {
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: "cq456",
        from: { id: 7, username: "kate" },
        chat_instance: "ci2",
        data: "other:data",
        message: {
          message_id: 2,
          date: 1700000000,
          chat: { id: 7, type: "private" },
        },
      },
    };
    const res = await post("demo", cbUpdate, TG_SECRET);
    expect(res.status).toBe(200);
  });
});
