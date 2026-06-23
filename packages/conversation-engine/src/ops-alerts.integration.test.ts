/**
 * Маршрутизация операционных алертов владельцу (#145):
 *   critical → Telegram + email; warning → Telegram (email только fallback);
 *   Telegram упал / не настроен → email-fallback; cooldown давит дубликаты.
 */
import {
  admins,
  applyAllMigrations,
  createIsolatedDb,
  operatorSettings,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  type OpsAlert,
  OpsAlertRouter,
  type OpsEmailSender,
  type OpsTelegramSender,
} from "./ops-alerts.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ops_alerts_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "storage",
  "migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantWith = 0; // тенант с привязанным Telegram
let tenantNoTg = 0; // тенант без operator_settings
let enabled = false;

class FakeTelegram implements OpsTelegramSender {
  sends: Array<{ chatId: string; text: string }> = [];
  mode: "ok" | "fail" = "ok";
  async send(chatId: string, text: string): Promise<void> {
    if (this.mode === "fail") throw new Error("tg down");
    this.sends.push({ chatId, text });
  }
}
class FakeEmail implements OpsEmailSender {
  sends: Array<{ to: string; subject: string; html: string }> = [];
  async send(opts: { to: string; subject: string; html: string }): Promise<void> {
    this.sends.push(opts);
  }
}

const baseAlert = (tenantId: number, over: Partial<OpsAlert>): OpsAlert => ({
  tenantId,
  kind: "order_stuck",
  severity: "warning",
  title: "Заголовок",
  detail: "Детали",
  dedupKey: "k",
  ...over,
});

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
  const [t1] = await db
    .insert(schema.tenants)
    .values({ slug: `ops-w-${now}` })
    .returning({ id: schema.tenants.id });
  const [t2] = await db
    .insert(schema.tenants)
    .values({ slug: `ops-n-${now}` })
    .returning({ id: schema.tenants.id });
  tenantWith = t1!.id;
  tenantNoTg = t2!.id;

  const [a1] = await db
    .insert(admins)
    .values({
      tenantId: tenantWith,
      email: `owner-${now}@test.io`,
      passwordHash: "x",
      role: "superadmin",
    })
    .returning({ id: admins.id });
  await db.insert(admins).values({
    tenantId: tenantNoTg,
    email: `owner2-${now}@test.io`,
    passwordHash: "x",
    role: "superadmin",
  });
  await db.insert(operatorSettings).values({
    adminId: a1!.id,
    tenantId: tenantWith,
    telegramChatId: "555",
    notifyOnAssignedOnly: false,
  });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

function makeRouter(tg: OpsTelegramSender | null, email: OpsEmailSender) {
  return new OpsAlertRouter({ db, botToken: "", appUrl: "http://x", telegram: tg, email });
}

describe("OpsAlertRouter", () => {
  it("critical → Telegram + email", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    const email = new FakeEmail();
    await makeRouter(tg, email).emit(
      baseAlert(tenantWith, { severity: "critical", dedupKey: "c1" }),
    );
    expect(tg.sends.length).toBe(1);
    expect(email.sends.length).toBe(1);
    expect(email.sends[0]!.to).toContain("owner-");
  });

  it("warning + Telegram доставлен → email НЕ шлём", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    const email = new FakeEmail();
    await makeRouter(tg, email).emit(
      baseAlert(tenantWith, { severity: "warning", dedupKey: "w1" }),
    );
    expect(tg.sends.length).toBe(1);
    expect(email.sends.length).toBe(0);
  });

  it("warning + Telegram упал → email fallback", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    tg.mode = "fail";
    const email = new FakeEmail();
    await makeRouter(tg, email).emit(
      baseAlert(tenantWith, { severity: "warning", dedupKey: "w2" }),
    );
    expect(tg.sends.length).toBe(0);
    expect(email.sends.length).toBe(1);
  });

  it("Telegram не привязан → email fallback", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    const email = new FakeEmail();
    await makeRouter(tg, email).emit(
      baseAlert(tenantNoTg, { severity: "warning", dedupKey: "n1" }),
    );
    expect(tg.sends.length).toBe(0);
    expect(email.sends.length).toBe(1);
  });

  it("cooldown давит дубликат того же dedupKey", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    const email = new FakeEmail();
    const router = makeRouter(tg, email);
    const a = baseAlert(tenantWith, { severity: "critical", dedupKey: "dup" });
    await router.emit(a);
    await router.emit(a);
    expect(tg.sends.length).toBe(1);
    expect(email.sends.length).toBe(1);
  });
});
