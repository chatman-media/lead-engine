// Integration tests для POST /api/admin/outreach.
//
// Схема теста:
//   - Signup → создаём channel (web, status=active)
//   - Создаём два контакта: один с channel_identity, другой без
//   - Создаём stage_definition + два лида (один в стадии, один нет)
//   - POST outreach by leadIds → enqueued=1 (у кого есть identity), skipped=1
//   - POST outreach by stageSlug → enqueued=1
//   - POST outreach с scheduledAt в будущем → scheduledAt в ответе
//   - Валидация: text required, leadIds или stageSlug required

import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  createIsolatedDb,
  funnels,
  leads,
  outboundQueue,
  schema,
  stageDefinitions,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminOutreachRoutes } from "./admin-outreach.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_outreach_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-outreach-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;

// Созданные в beforeAll
let leadWithChannel = 0;    // лид с channel_identity → должен быть enqueued
let leadWithoutChannel = 0; // лид без channel_identity → skipped
let stageId = 0;            // stage_definition.id

const now = Math.floor(Date.now() / 1000);

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 3, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql, { schema });

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route("/", makeAdminOutreachRoutes({ db }));

    // Signup
    const signupRes = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "outreach-test@demo.io", password: "strong-pwd-12345" }),
    });
    const signup = (await signupRes.json()) as { token: string; admin: { tenantId: number } };
    token = signup.token;
    tenantId = signup.admin.tenantId;

    // Создаём telegram_bot channel (status=active).
    // source="bot" — единственное значение для bot-initiated каналов.
    // "web" и "whatsapp" тоже маппятся на "bot" (см. admin-outreach.ts).
    const [channel] = await db.insert(channels).values({
      tenantId,
      kind: "telegram_bot",
      externalId: "bot-test-12345",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: channels.id });

    // Контакт 1: с channel identity
    const [contact1] = await db.insert(contacts).values({ tenantId, createdAt: now, updatedAt: now }).returning({ id: contacts.id });
    await db.insert(channelIdentities).values({
      contactId: contact1!.id,
      channelId: channel!.id,
      externalUserId: "user-111",
      createdAt: now,
    });

    // Контакт 2: без channel identity (будет skipped)
    const [contact2] = await db.insert(contacts).values({ tenantId, createdAt: now, updatedAt: now }).returning({ id: contacts.id });

    // Funnel (обязателен для stage_definitions)
    const [funnel] = await db.insert(funnels).values({
      tenantId,
      slug: "test-funnel",
      stagesJson: "[]",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: funnels.id });

    // Stage definition
    const [stage] = await db.insert(stageDefinitions).values({
      tenantId,
      funnelId: funnel!.id,
      slug: "test-stage",
      displayName: "Тест",
      kind: "active",
      position: 1,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: stageDefinitions.id });
    stageId = stage!.id;

    // Лид 1: привязан к contact1 (с каналом), в stage
    const [lead1] = await db.insert(leads).values({
      tenantId,
      userId: contact1!.id,
      state: "test-stage",
      stageDefinitionId: stageId,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: leads.id });
    leadWithChannel = lead1!.id;

    // Лид 2: привязан к contact2 (без канала), не в stage
    const [lead2] = await db.insert(leads).values({
      tenantId,
      userId: contact2!.id,
      state: "other",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: leads.id });
    leadWithoutChannel = lead2!.id;
  },
  30_000,
);

afterAll(async () => {
  if (sql) { await sql.end({ timeout: 0 }).catch(() => {}); sql = null; }
}, 10_000);

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/outreach — валидация", () => {
  it("без text → 400", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", { leadIds: [leadWithChannel] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/text/i);
  });

  it("без leadIds и stageSlug → 400", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", { text: "Привет" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/leadIds|stageSlug/i);
  });

  it("пустой text → 400", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", { text: "  ", leadIds: [leadWithChannel] });
    expect(res.status).toBe(400);
  });

  it("без токена → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Привет", leadIds: [leadWithChannel] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/outreach — by leadIds", () => {
  it("лид с каналом → enqueued=1, лид без канала → skipped=1", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", {
      text: "Привет из рассылки!",
      leadIds: [leadWithChannel, leadWithoutChannel],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; skipped: number; scheduledAt: null };
    expect(body.enqueued).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.scheduledAt).toBeNull();
  });

  it("запись появляется в outbound_queue", async () => {
    if (!sql) return;
    const queue = await db.select().from(outboundQueue).where(eq(outboundQueue.tenantId, tenantId));
    expect(queue.length).toBeGreaterThan(0);
    const entry = queue[queue.length - 1]!;
    const payload = JSON.parse(entry.payloadJson) as { parts: Array<{ text: string }> };
    expect(payload.parts[0]?.text).toBe("Привет из рассылки!");
  });

  it("несуществующие leadIds → enqueued=0, skipped=0", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", {
      text: "Кому-то",
      leadIds: [999999, 999998],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(0);
  });

  it("пустой массив leadIds → 400", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", { text: "Текст", leadIds: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/outreach — by stageSlug", () => {
  it("stageSlug с лидом в стадии → enqueued=1", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", {
      text: "Сообщение по стадии",
      stageSlug: "test-stage",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(1);
  });

  it("несуществующий stageSlug → enqueued=0, skipped=0", async () => {
    if (!sql) return;
    const res = await post("/api/admin/outreach", {
      text: "Кому-то",
      stageSlug: "no-such-stage",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(0);
  });
});

describe("POST /api/admin/outreach — web channel kind", () => {
  it("web channel identity → enqueued=1 (маппится на source='bot')", async () => {
    if (!sql) return;
    const [webChannel] = await db.insert(channels).values({
      tenantId,
      kind: "web",
      externalId: "web-test-99999",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: channels.id });
    const [webContact] = await db.insert(contacts).values({ tenantId, createdAt: now, updatedAt: now }).returning({ id: contacts.id });
    await db.insert(channelIdentities).values({
      contactId: webContact!.id,
      channelId: webChannel!.id,
      externalUserId: "web-user-999",
      createdAt: now,
    });
    const [webLead] = await db.insert(leads).values({
      tenantId,
      userId: webContact!.id,
      state: "new",
      createdAt: now,
      updatedAt: now,
    }).returning({ id: leads.id });

    const res = await post("/api/admin/outreach", {
      text: "Привет из web-канала!",
      leadIds: [webLead!.id],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(1);
    expect(body.skipped).toBe(0);
  });
});

describe("POST /api/admin/outreach — scheduledAt", () => {
  it("scheduledAt в будущем → возвращается в ответе", async () => {
    if (!sql) return;
    const futureEpoch = Math.floor(Date.now() / 1000) + 3600; // +1 час
    const res = await post("/api/admin/outreach", {
      text: "Отложенное сообщение",
      leadIds: [leadWithChannel],
      scheduledAt: futureEpoch,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enqueued: number; scheduledAt: number | null };
    expect(body.enqueued).toBe(1);
    expect(body.scheduledAt).toBe(futureEpoch);
  });

  it("scheduledAt в прошлом → трактуется как немедленная отправка (scheduledAt=null)", async () => {
    if (!sql) return;
    const pastEpoch = Math.floor(Date.now() / 1000) - 3600; // -1 час
    const res = await post("/api/admin/outreach", {
      text: "Устаревшее",
      leadIds: [leadWithChannel],
      scheduledAt: pastEpoch,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduledAt: null };
    expect(body.scheduledAt).toBeNull();
  });
});
