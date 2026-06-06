// Integration test for the Dialog Simulator route (admin-sim). Real
// processInbound pipeline; persona ChatClient + replyStrategy faked. Covers
// personas / start (guards + happy) / self_play conversation creation / delete.

import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  conversations,
  createIsolatedDb,
  messages,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminSimRoutes } from "./admin-sim.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_sim_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-sim-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono; // persona+reply настроены
let appNoChat: Hono; // persona-resolver вернёт null
let token = "";
let tenantId = 0;

// Фейковый persona-клиент: всегда выдаёт реплику клиента (диалог стопается
// по maxTurns в тестах).
const fakePersona = {
  complete: async () => "Здравствуйте, хочу обменять 500 USDT на баты",
};

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
      makeAdminSimRoutes({
        db,
        // biome-ignore lint/suspicious/noExplicitAny: reply-strategy fake
        replyStrategy: {
          generate: async () => [
            { channelId: "x", externalUserId: "u", parts: [{ kind: "text", text: "Курс 36.5, подтверждаете?" }] },
          ],
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: chat-client fake
        resolveSimChat: () => fakePersona as any,
      }),
    );

    appNoChat = new Hono();
    appNoChat.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    appNoChat.route("/", makeAdminSimRoutes({ db, replyStrategy: null, resolveSimChat: () => null }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sim@demo.io", password: "strong-pwd-12345" }),
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

const START = "/api/admin/sim/start";

describe("admin-sim dialog simulator", () => {
  it("GET /personas → список персон", async () => {
    if (!sql) return;
    const res = await req("GET", "/api/admin/sim/personas");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { personas: unknown[] }).personas.length).toBeGreaterThan(0);
  });

  it("POST /start без personaId/brief → 400", async () => {
    if (!sql) return;
    expect((await req("POST", START, {})).status).toBe(400);
  });

  it("POST /start без chat LLM → 400", async () => {
    if (!sql) return;
    const res = await req("POST", START, { personaId: "exchange_usdt" }, appNoChat);
    expect(res.status).toBe(400);
  });

  it("POST /start без активного канала → 400", async () => {
    if (!sql) return;
    expect((await req("POST", START, { personaId: "exchange_usdt", maxTurns: 1 })).status).toBe(400);
  });

  it("POST /start (happy) → self_play диалог с user+assistant", async () => {
    if (!sql) return;
    await withTenant(db, tenantId, async (tx) =>
      tx.insert(channels).values({ tenantId, kind: "telegram_bot", externalId: "@simbot", status: "active" }),
    );
    const res = await req("POST", START, { personaId: "exchange_usdt", maxTurns: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversationId: number };
    expect(body.conversationId).toBeGreaterThan(0);

    // Диалог помечен self_play.
    const conv = await withTenant(db, tenantId, async (tx) =>
      tx
        .select({ source: conversations.source })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, body.conversationId)))
        .limit(1),
    );
    expect(conv[0]?.source).toBe("self_play");

    // Есть реплика клиента (user) и ответ бота (assistant).
    const msgs = await withTenant(db, tenantId, async (tx) =>
      tx
        .select({ role: messages.role, text: messages.text })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, body.conversationId))),
    );
    const roles = msgs.map((m) => m.role).sort();
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(msgs.find((m) => m.role === "assistant")?.text).toContain("Курс");
  });

  it("DELETE /sim/:id → удаляет self_play диалог", async () => {
    if (!sql) return;
    const start = await req("POST", START, { personaId: "exchange_rub", maxTurns: 1 });
    const { conversationId } = (await start.json()) as { conversationId: number };
    const del = await req("DELETE", `/api/admin/sim/${conversationId}`);
    expect(del.status).toBe(200);
    const left = await withTenant(db, tenantId, async (tx) =>
      tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId))),
    );
    expect(left.length).toBe(0);
  });

  it("POST /stream → активный поток, отмена убирает его", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/sim/stream", {
      count: 3,
      intervalSec: 5,
      maxTurns: 1,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { streamId: string; count: number; intervalSec: number };
    expect(body.count).toBe(3);
    expect(body.intervalSec).toBe(5);
    expect(body.streamId).toMatch(/^str_/);

    // Поток виден среди активных (первый клиент уже запущен, ещё 2 в очереди).
    const list = (await (await req("GET", "/api/admin/sim/streams")).json()) as {
      streams: Array<{ id: string; total: number }>;
    };
    expect(list.streams.some((s) => s.id === body.streamId)).toBe(true);

    // Отмена очищает таймеры оставшихся клиентов.
    const del = await req("DELETE", `/api/admin/sim/stream/${body.streamId}`);
    expect(del.status).toBe(200);
    const after = (await (await req("GET", "/api/admin/sim/streams")).json()) as {
      streams: Array<{ id: string }>;
    };
    expect(after.streams.some((s) => s.id === body.streamId)).toBe(false);
  });

  it("DELETE /streams → kill-switch: гасит все потоки тенанта", async () => {
    if (!sql) return;
    await req("POST", "/api/admin/sim/stream", { count: 3, intervalSec: 5, maxTurns: 1 });
    await req("POST", "/api/admin/sim/stream", { count: 3, intervalSec: 5, maxTurns: 1 });
    const del = await req("DELETE", "/api/admin/sim/streams");
    expect(del.status).toBe(200);
    const list = (await (await req("GET", "/api/admin/sim/streams")).json()) as {
      streams: unknown[];
    };
    expect(list.streams.length).toBe(0);
  });
});
