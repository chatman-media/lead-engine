/**
 * applyClassifiedStage — обновляет conversations.current_stage только при смене
 * стадии (idempotent), уважает tenant. Требует DATABASE_URL; иначе skip.
 */
import { applyAllMigrations, createIsolatedDb, schema, tryConnectToPg } from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { applyClassifiedStage } from "./stage-classifier.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_stage_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let convId = 0;
let enabled = false;

// current_stage — text без CHECK; типизирован как FunnelStage, в тесте кастуем.
const ST = (s: string) => s as never;

async function stageOf(id: number): Promise<string | null> {
  const [row] = await db
    .select({ s: schema.conversations.currentStage })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id));
  return row?.s ?? null;
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  const now = Math.floor(Date.now() / 1000);
  const [t] = await db.insert(schema.tenants).values({ slug: `stage-${now}` }).returning({ id: schema.tenants.id });
  tenantId = t!.id;
  const [c] = await db.insert(schema.contacts).values({ tenantId }).returning({ id: schema.contacts.id });
  const [conv] = await db
    .insert(schema.conversations)
    .values({ tenantId, userId: c!.id, source: "bot", mode: "ai" })
    .returning({ id: schema.conversations.id });
  convId = conv!.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("applyClassifiedStage", () => {
  it("новая стадия отличается → обновляет, возвращает true", async () => {
    if (!enabled) return;
    expect(await applyClassifiedStage({ db, tenantId, conversationId: convId, newStage: ST("qualified") })).toBe(true);
    expect(await stageOf(convId)).toBe("qualified");
  });

  it("та же стадия → false (idempotent, без UPDATE)", async () => {
    if (!enabled) return;
    expect(await applyClassifiedStage({ db, tenantId, conversationId: convId, newStage: ST("qualified") })).toBe(false);
  });

  it("newStage null → false", async () => {
    if (!enabled) return;
    expect(await applyClassifiedStage({ db, tenantId, conversationId: convId, newStage: null })).toBe(false);
  });

  it("несуществующий conversationId → false", async () => {
    if (!enabled) return;
    expect(await applyClassifiedStage({ db, tenantId, conversationId: 999_999, newStage: ST("x") })).toBe(false);
  });

  it("чужой тенант → false (строка не видна)", async () => {
    if (!enabled) return;
    expect(
      await applyClassifiedStage({ db, tenantId: tenantId + 99_999, conversationId: convId, newStage: ST("won") }),
    ).toBe(false);
    expect(await stageOf(convId)).toBe("qualified"); // не изменилось
  });
});
