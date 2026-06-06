/**
 * Integration test для concierge agentic tools (Фаза 2 — трекинг статуса гостем).
 * Прогоняет DB-путь против изолированной БД: tenantSupportsMultiRequest, listOpenRequests
 * и сам tool (resolve contactId из conversationId → открытые запросы).
 *
 * Без DATABASE_URL — мягкий skip (как прочие *.integration.test.ts).
 */

import {
  applyAllMigrations,
  contacts,
  conversations,
  createIsolatedDb,
  leads,
  schema,
  stageDefinitions,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { applyFunnelStages, SEED_TEMPLATES } from "../routes/admin-funnel.ts";
import { makeAuthRoutes } from "../routes/auth.ts";
import {
  listOpenRequests,
  makeConciergeRequestsTool,
  tenantSupportsMultiRequest,
} from "./concierge-tools.ts";
import { makeRequestContextResolver } from "../llm-bootstrap.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ctools_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-concierge-tools-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let contactId = 0;
let conversationId = 0;

async function stageId(slug: string): Promise<number> {
  const [s] = await db
    .select({ id: stageDefinitions.id })
    .from(stageDefinitions)
    .where(and(eq(stageDefinitions.tenantId, tenantId), eq(stageDefinitions.slug, slug)));
  return s!.id;
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
  // biome-ignore lint/suspicious/noExplicitAny: drizzle generic in test harness
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ctools@demo.io", password: "strong-pwd-12345" }),
  });
  tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;

  await applyFunnelStages(db as never, tenantId, SEED_TEMPLATES.concierge!, "concierge");
  // Воронку НЕ помечаем concierge_v1: гейт теперь capability-based (intake имеет
  // поле request_type), от template id не зависит — это и проверяет тест ниже.

  const [c] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
  contactId = c!.id;
  const [conv] = await db
    .insert(conversations)
    .values({ tenantId, userId: contactId, source: "bot" })
    .returning({ id: conversations.id });
  conversationId = conv!.id;

  // Открытый запрос: трансфер на стадии transfer_request.
  const now = Math.floor(Date.parse("2026-06-06T00:00:00Z") / 1000);
  await db.insert(leads).values({
    tenantId,
    userId: contactId,
    state: "transfer_request",
    stageDefinitionId: await stageId("transfer_request"),
    requestType: "transfer",
    createdAt: now,
    updatedAt: now,
  });
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("concierge tools (Фаза 2 — статус гостя)", () => {
  it("tenantSupportsMultiRequest = true для воронки с request_type на intake (без concierge_v1)", async () => {
    if (!sql) return;
    expect(await tenantSupportsMultiRequest(db as never, tenantId)).toBe(true);
  });

  it("tenantSupportsMultiRequest = false для линейной воронки (нет request_type на intake)", async () => {
    if (!sql) return;
    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ctools-linear@demo.io", password: "strong-pwd-12345" }),
    });
    const t2 = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;
    await applyFunnelStages(db as never, t2, SEED_TEMPLATES.saas!, "saas");
    expect(await tenantSupportsMultiRequest(db as never, t2)).toBe(false);
  });

  it("listOpenRequests возвращает тип + человекочитаемую стадию", async () => {
    if (!sql) return;
    const reqs = await listOpenRequests({ db: db as never, tenantId, contactId });
    expect(reqs).toEqual([{ type: "Трансфер", stage: "Трансфер: детали" }]);
  });

  it("tool list_my_requests резолвит contactId из conversationId", async () => {
    if (!sql) return;
    const tool = makeConciergeRequestsTool({ db: db as never, tenantId, conversationId });
    const out = (await tool.execute({})) as { requests: Array<{ type: string; stage: string }> };
    expect(out.requests).toEqual([{ type: "Трансфер", stage: "Трансфер: детали" }]);
  });

  it("терминальный запрос исключается из открытых", async () => {
    if (!sql) return;
    const completedId = await stageId("completed");
    const fresh = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
    const cid = fresh[0]!.id;
    const now = Math.floor(Date.parse("2026-06-06T01:00:00Z") / 1000);
    await db.insert(leads).values({
      tenantId,
      userId: cid,
      state: "completed",
      stageDefinitionId: completedId,
      requestType: "food",
      createdAt: now,
      updatedAt: now,
    });
    const reqs = await listOpenRequests({ db: db as never, tenantId, contactId: cid });
    expect(reqs).toEqual([]);
  });
});

describe("makeRequestContextResolver (R4 — request_type в промпт)", () => {
  it("1 открытый запрос → контекст с типом, без счётчика", async () => {
    if (!sql) return;
    const resolve = makeRequestContextResolver(db as never);
    const ctx = await resolve({ tenantId, contactId });
    expect(ctx).toContain("«Трансфер»");
    expect(ctx).not.toContain("Всего открытых");
  });

  it("несколько открытых → контекст со счётчиком", async () => {
    if (!sql) return;
    const [c] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
    const multiId = c!.id;
    const now = Math.floor(Date.parse("2026-06-06T02:00:00Z") / 1000);
    await db.insert(leads).values([
      { tenantId, userId: multiId, state: "transfer_request", stageDefinitionId: await stageId("transfer_request"), requestType: "transfer", createdAt: now, updatedAt: now },
      { tenantId, userId: multiId, state: "exchange_request", stageDefinitionId: await stageId("exchange_request"), requestType: "exchange", createdAt: now, updatedAt: now + 1 },
    ]);
    const resolve = makeRequestContextResolver(db as never);
    const ctx = await resolve({ tenantId, contactId: multiId });
    expect(ctx).toContain("Всего открытых запросов у гостя: 2");
  });

  it("нет открытых (только терминальный) → null", async () => {
    if (!sql) return;
    const [c] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
    const doneId = c!.id;
    const now = Math.floor(Date.parse("2026-06-06T03:00:00Z") / 1000);
    await db.insert(leads).values({ tenantId, userId: doneId, state: "completed", stageDefinitionId: await stageId("completed"), requestType: "food", createdAt: now, updatedAt: now });
    const resolve = makeRequestContextResolver(db as never);
    expect(await resolve({ tenantId, contactId: doneId })).toBe(null);
  });
});
