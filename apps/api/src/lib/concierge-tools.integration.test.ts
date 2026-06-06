/**
 * Integration test для concierge agentic tools (Фаза 2 — трекинг статуса гостем).
 * Прогоняет DB-путь против изолированной БД: isConciergeTenant, listOpenRequests
 * и сам tool (resolve contactId из conversationId → открытые запросы).
 *
 * Без DATABASE_URL — мягкий skip (как прочие *.integration.test.ts).
 */

import {
  applyAllMigrations,
  contacts,
  conversations,
  createIsolatedDb,
  funnels,
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
  isConciergeTenant,
  listOpenRequests,
  makeConciergeRequestsTool,
} from "./concierge-tools.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ctools_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-concierge-tools-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
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

  const app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: drizzle generic in test harness
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ctools@demo.io", password: "strong-pwd-12345" }),
  });
  tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;

  await applyFunnelStages(db as never, tenantId, SEED_TEMPLATES.concierge!, "concierge");
  // Помечаем воронку как concierge_v1 (как делает install-endpoint) — гейт isConciergeTenant.
  await db
    .update(funnels)
    .set({ verticalTemplateId: "concierge_v1" })
    .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)));

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
  it("isConciergeTenant = true для воронки concierge_v1", async () => {
    if (!sql) return;
    expect(await isConciergeTenant(db as never, tenantId)).toBe(true);
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
