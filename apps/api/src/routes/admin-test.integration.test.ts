// Integration test for the Bot Tester route (admin-test). Real processInbound
// pipeline (Inbound built directly, no adapter); replyStrategy faked in a 2nd
// app. Covers scenarios / session / send (guards + happy with & without reply).
// Coverage epic #187 — apps/api untested routes.

import { type ReplyStrategy, withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import type { PhotoProcessor } from "../lib/photo-processor.ts";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminTestRoutes } from "./admin-test.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_bottest_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-bottest-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono; // без replyStrategy
let appReply: Hono; // с фейковым replyStrategy
let appMedia: Hono; // с фейковым photoProcessor
let token = "";
let tenantId = 0;
const mediaProcessorCalls: Array<{ externalRef: string; caption: string | null; bytes: number }> = [];

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
    app.route("/", makeAdminTestRoutes({ db }));

    appReply = new Hono();
    appReply.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    const replyStrategy: ReplyStrategy = {
      generate: async () => [
        { channelId: "x", externalUserId: "u", parts: [{ kind: "text", text: "бот ответ" }] },
      ],
    };
    appReply.route(
      "/",
      makeAdminTestRoutes({
        db,
        replyStrategy,
      }),
    );

    appMedia = new Hono();
    appMedia.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    const photoProcessor: PhotoProcessor = {
      async process({ inbound, adapter }) {
        const part = inbound.parts.find((item) => item.kind === "photo");
        if (part?.kind !== "photo") throw new Error("expected photo part");
        const res = await adapter.downloadMedia(part.mediaRef);
        const bytes = await res.arrayBuffer();
        mediaProcessorCalls.push({
          externalRef: part.mediaRef.externalRef,
          caption: part.caption ?? null,
          bytes: bytes.byteLength,
        });
      },
    };
    appMedia.route("/", makeAdminTestRoutes({ db, photoProcessor }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bottest@demo.io", password: "strong-pwd-12345" }),
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

async function req(method: string, path: string, body?: unknown, instance?: Hono): Promise<Response> {
  return (instance ?? app).request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const SEND = "/api/admin/test/send";
const SESSION = "/api/admin/test/session";

describe("admin-test bot-tester", () => {
  it("GET /scenarios → список сценариев", async () => {
    if (!sql) return;
    const res = await req("GET", "/api/admin/test/scenarios");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scenarios: Array<{
        id: string;
        steps: Array<{ mediaUrl?: string; mediaType?: string; caption?: string }>;
      }>;
    };
    expect(body.scenarios.length).toBeGreaterThan(0);
    expect(
      body.scenarios
        .find((scenario) => scenario.id === "exchange_rub")
        ?.steps.some((step) => step.mediaUrl === "asset:receipt-sber.png" && step.mediaType === "photo"),
    ).toBe(true);
    expect(
      body.scenarios
        .find((scenario) => scenario.id === "exchange_kyc_passport")
        ?.steps.some((step) => step.mediaUrl === "asset:passport-demo.png" && step.caption),
    ).toBe(true);
  });

  it("POST /send без text/media → 400", async () => {
    if (!sql) return;
    expect((await req("POST", SEND, {})).status).toBe(400);
  });

  it("POST /send без активного канала → 400; DELETE /session без канала → ok+note", async () => {
    if (!sql) return;
    expect((await req("POST", SEND, { text: "привет" })).status).toBe(400);
    const del = await req("DELETE", SESSION);
    expect(del.status).toBe(200);
    expect(((await del.json()) as { note?: string }).note).toBeDefined();
  });

  it("POST /send (есть канал, без replyStrategy) → 200 + placeholder", async () => {
    if (!sql) return;
    await withTenant(db, tenantId, async (tx) =>
      tx.insert(channels).values({ tenantId, kind: "telegram_bot", externalId: "@bottest", status: "active" }),
    );
    const res = await req("POST", SEND, { text: "привет, хочу обмен" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parts: Array<{ text?: string }>; conversationId: number };
    expect(body.conversationId).toBeGreaterThan(0);
    expect(body.parts[0]?.text).toContain("replyStrategy");
  });

  it("POST /send с replyStrategy → 200 + ответ бота", async () => {
    if (!sql) return;
    const res = await req("POST", SEND, { text: "ещё сообщение" }, appReply);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parts: Array<{ kind: string; text: string }> };
    expect(body.parts).toEqual([{ kind: "text", text: "бот ответ" }]);
  });

  it("POST /send битый JSON → 400; media-сообщение → 200", async () => {
    if (!sql) return;
    const bad = await app.request(SEND, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const media = await req("POST", SEND, { mediaUrl: "https://x.io/i.jpg", mediaType: "photo", caption: "чек" });
    expect(media.status).toBe(200);
  });

  it("POST /send asset photo → photoProcessor получает локальный демо-файл", async () => {
    if (!sql) return;
    await withTenant(db, tenantId, async (tx) =>
      tx.insert(channels).values({ tenantId, kind: "telegram_bot", externalId: "@bottest-media", status: "active" }),
    );
    mediaProcessorCalls.length = 0;

    const media = await req(
      "POST",
      SEND,
      {
        mediaUrl: "asset:receipt-sber.png",
        mediaType: "photo",
        caption: "Оплатил, вот чек",
      },
      appMedia,
    );

    expect(media.status).toBe(200);
    expect(mediaProcessorCalls).toHaveLength(1);
    expect(mediaProcessorCalls[0]?.externalRef).toBe("asset:receipt-sber.png");
    expect(mediaProcessorCalls[0]?.caption).toBe("Оплатил, вот чек");
    expect(mediaProcessorCalls[0]?.bytes).toBeGreaterThan(1000);
  });

  it("DELETE /session (есть канал+контакт) → ok", async () => {
    if (!sql) return;
    expect((await req("DELETE", SESSION)).status).toBe(200);
  });
});
