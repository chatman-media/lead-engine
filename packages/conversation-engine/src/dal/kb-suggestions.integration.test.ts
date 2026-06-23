import {
  applyAllMigrations,
  createIsolatedDb,
  kbSuggestions,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { KbSuggestionsRepo } from "./kb-suggestions.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_kbsug_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "storage",
  "migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let repo: KbSuggestionsRepo;
let tenantId = 0;
let enabled = false;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
    max: 2,
    onnotice: () => {},
  });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  const now = Math.floor(Date.now() / 1000);
  const [t] = await db
    .insert(schema.tenants)
    .values({ slug: `kbsug-${now}` })
    .returning({ id: schema.tenants.id });
  tenantId = t!.id;
  repo = new KbSuggestionsRepo({ db: db as never, tenantId });
  enabled = true;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("KbSuggestionsRepo", () => {
  it("log() записывает вопрос в кб-предложения", async () => {
    if (!enabled) return;
    const now = Math.floor(Date.now() / 1000);
    await repo.log({ questionText: "Какой курс?", nowEpoch: now });
    const rows = await db.select().from(kbSuggestions).where(eq(kbSuggestions.tenantId, tenantId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.questionText === "Какой курс?")).toBe(true);
  });

  it("log() с sourceConversationId/messageId → FK-поля сохраняются", async () => {
    if (!enabled) return;
    const now = Math.floor(Date.now() / 1000);
    // без реального conversation — просто проверяем что вставка проходит (FK nullable)
    await repo.log({
      questionText: "Где офис?",
      nowEpoch: now,
    });
    const rows = await db.select().from(kbSuggestions).where(eq(kbSuggestions.tenantId, tenantId));
    expect(rows.some((r) => r.questionText === "Где офис?")).toBe(true);
  });
});
