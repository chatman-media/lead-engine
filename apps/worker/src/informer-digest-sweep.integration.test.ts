/**
 * Интеграционно проверяем путь дайджеста InformerDigestSweeper.sweepTenant:
 * due → собрать pending-строки ленты, отправить сводку, пометить строки
 * digested и проштамповать informer_last_digest_at; not-due → молчим.
 * Требует DATABASE_URL; без него — graceful-skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  adminNotifications,
  admins,
  applyAllMigrations,
  createIsolatedDb,
  operatorSettings,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { type InformerDigestSender, InformerDigestSweeper } from "./informer-digest-sweep.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_inf_digest_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let adminId = 0;
let enabled = false;

class FakeSender implements InformerDigestSender {
  sends: Array<{ chatId: string; html: string }> = [];
  async send(chatId: string, html: string): Promise<void> {
    this.sends.push({ chatId, html });
  }
}

function makeSweeper(sender: InformerDigestSender) {
  return new InformerDigestSweeper(db, { intervalMs: 1, botToken: "", sender });
}

async function seedPending(
  dedup: string,
  over: Partial<typeof adminNotifications.$inferInsert> = {},
) {
  await db.insert(adminNotifications).values({
    tenantId,
    adminId,
    topic: "leads",
    severity: "info",
    kind: "stage_changed",
    title: `T-${dedup}`,
    body: "",
    dedupKey: dedup,
    ...over,
  });
}

async function setDigest(fields: Partial<typeof operatorSettings.$inferInsert>) {
  await db.update(operatorSettings).set(fields).where(eq(operatorSettings.tenantId, tenantId));
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;

  const now = Math.floor(Date.now() / 1000);
  const [t] = await db
    .insert(schema.tenants)
    .values({ slug: `inf-dig-${now}` })
    .returning({ id: schema.tenants.id });
  tenantId = t!.id;
  const [a] = await db
    .insert(admins)
    .values({ tenantId, email: `owner-${now}@test.io`, passwordHash: "x", role: "superadmin" })
    .returning({ id: admins.id });
  adminId = a!.id;
  // Дайджест daily, час 0 UTC, ещё не слали → due в любой час.
  await db.insert(operatorSettings).values({
    adminId,
    tenantId,
    telegramChatId: "999",
    notifyOnAssignedOnly: false,
    informerDigest: "daily",
    informerDigestHour: 0,
    informerTz: "UTC",
  });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("InformerDigestSweeper.sweepTenant", () => {
  it("due + есть pending → шлёт сводку, метит digested, штампует last_digest", async () => {
    if (!enabled) return;
    await seedPending("d1", {
      severity: "critical",
      kind: "channel_down",
      topic: "system",
      title: "Канал упал",
    });
    await seedPending("d2");
    // уже доставленную в реалтайм строку в дайджест НЕ берём
    await seedPending("d3", { deliveredAt: 1, title: "Уже доставлено" });

    const sender = new FakeSender();
    const now = Math.floor(Date.now() / 1000);
    await makeSweeper(sender).sweepTenant(tenantId, now);

    expect(sender.sends.length).toBe(1);
    expect(sender.sends[0]!.chatId).toBe("999");
    expect(sender.sends[0]!.html).toContain("Сводка");
    expect(sender.sends[0]!.html).toContain("Канал упал"); // важное вынесено

    const rows = await db
      .select()
      .from(adminNotifications)
      .where(eq(adminNotifications.tenantId, tenantId));
    const byKey = (k: string) => rows.find((r) => r.dedupKey === k);
    expect(byKey("d1")?.digestBatchId).toBe(now); // вошло в батч
    expect(byKey("d2")?.digestBatchId).toBe(now);
    expect(byKey("d3")?.digestBatchId).toBeNull(); // доставленную не трогаем

    const [s] = await db
      .select()
      .from(operatorSettings)
      .where(eq(operatorSettings.adminId, adminId));
    expect(s?.informerLastDigestAt).toBe(now);
  });

  it("digest=off → ничего не шлём, pending не трогаем", async () => {
    if (!enabled) return;
    await setDigest({ informerDigest: "off", informerLastDigestAt: null });
    await seedPending("off1");

    const sender = new FakeSender();
    await makeSweeper(sender).sweepTenant(tenantId, Math.floor(Date.now() / 1000));

    expect(sender.sends.length).toBe(0);
    const [row] = await db
      .select()
      .from(adminNotifications)
      .where(
        and(eq(adminNotifications.tenantId, tenantId), eq(adminNotifications.dedupKey, "off1")),
      );
    expect(row?.digestBatchId).toBeNull();
  });

  it("due, но pending пуст → ничего не шлём", async () => {
    if (!enabled) return;
    // due, но всё, что было, уже сведено → pending пуст
    await setDigest({ informerDigest: "daily", informerLastDigestAt: null });
    await db
      .update(adminNotifications)
      .set({ digestBatchId: 1 })
      .where(eq(adminNotifications.tenantId, tenantId));

    const sender = new FakeSender();
    await makeSweeper(sender).sweepTenant(tenantId, Math.floor(Date.now() / 1000));
    expect(sender.sends.length).toBe(0);
  });
});
