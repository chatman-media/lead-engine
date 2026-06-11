/**
 * AdminInformer.emit() — матрица доставки: порог важности × тема × мут × дедуп,
 * запись ленты (admin_notifications) и delivered_at. Требует DATABASE_URL
 * (owner-роль); без него тесты graceful-skip'аются.
 */
import {
  adminNotifications,
  admins,
  applyAllMigrations,
  createIsolatedDb,
  operatorSettings,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { AdminInformer, type InformerEvent } from "./admin-informer.ts";
import type { InformerPrefs } from "./dal/notifications.ts";
import type { OpsEmailSender, OpsTelegramSender } from "./ops-alerts.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_informer_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantWith = 0; // владелец с привязанным Telegram
let tenantNoTg = 0; // владелец без telegram
let ownerAdminId = 0;
let enabled = false;

class FakeTelegram implements OpsTelegramSender {
  sends: Array<{ chatId: string; text: string }> = [];
  async send(chatId: string, text: string): Promise<void> {
    this.sends.push({ chatId, text });
  }
}
class FakeEmail implements OpsEmailSender {
  sends: Array<{ to: string; subject: string; html: string }> = [];
  async send(opts: { to: string; subject: string; html: string }): Promise<void> {
    this.sends.push(opts);
  }
}

function makeInformer(
  tg: OpsTelegramSender | null,
  email: OpsEmailSender,
  realtime?: ConstructorParameters<typeof AdminInformer>[0]["realtime"],
) {
  return new AdminInformer({ db, botToken: "", appUrl: "http://x", telegram: tg, email, cooldownSec: 3600, realtime });
}

const ev = (tenantId: number, over: Partial<InformerEvent>): InformerEvent => ({
  tenantId,
  topic: "orders",
  severity: "important",
  kind: "test",
  title: "T",
  detail: "D",
  dedupKey: "k",
  ...over,
});

async function setOwner(tenantId: number, prefs: InformerPrefs): Promise<void> {
  await db
    .update(operatorSettings)
    .set({ informerTopics: null, informerMutedUntil: null, informerLevel: "important", ...prefs })
    .where(eq(operatorSettings.tenantId, tenantId));
}

async function lastRow(tenantId: number, dedupKey: string) {
  const rows = await db
    .select()
    .from(adminNotifications)
    .where(and(eq(adminNotifications.tenantId, tenantId), eq(adminNotifications.dedupKey, dedupKey)))
    .orderBy(desc(adminNotifications.id))
    .limit(1);
  return rows[0];
}

async function rowCount(tenantId: number, dedupKey: string): Promise<number> {
  const rows = await db
    .select()
    .from(adminNotifications)
    .where(and(eq(adminNotifications.tenantId, tenantId), eq(adminNotifications.dedupKey, dedupKey)));
  return rows.length;
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
  const [t1] = await db.insert(schema.tenants).values({ slug: `inf-w-${now}` }).returning({ id: schema.tenants.id });
  const [t2] = await db.insert(schema.tenants).values({ slug: `inf-n-${now}` }).returning({ id: schema.tenants.id });
  tenantWith = t1!.id;
  tenantNoTg = t2!.id;

  const [a1] = await db
    .insert(admins)
    .values({ tenantId: tenantWith, email: `owner-${now}@test.io`, passwordHash: "x", role: "superadmin" })
    .returning({ id: admins.id });
  ownerAdminId = a1!.id;
  await db.insert(admins).values({
    tenantId: tenantNoTg, email: `owner2-${now}@test.io`, passwordHash: "x", role: "superadmin",
  });
  await db.insert(operatorSettings).values({
    adminId: ownerAdminId, tenantId: tenantWith, telegramChatId: "555", notifyOnAssignedOnly: false,
  });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("AdminInformer.emit", () => {
  it("important @ level important → реалтайм + ledger delivered", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "important" });
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emit(ev(tenantWith, { dedupKey: "imp" }));
    expect(tg.sends.length).toBe(1);
    expect(tg.sends[0]!.chatId).toBe("555");
    const row = await lastRow(tenantWith, "imp");
    expect(row?.deliveredAt).not.toBeNull();
  });

  it("info @ level important → НЕ реалтайм, ledger ждёт дайджеста", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "important" });
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emit(ev(tenantWith, { severity: "info", dedupKey: "inf" }));
    expect(tg.sends.length).toBe(0);
    const row = await lastRow(tenantWith, "inf");
    expect(row).toBeDefined();
    expect(row?.deliveredAt).toBeNull();
  });

  it("info @ level all → реалтайм", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "all" });
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emit(ev(tenantWith, { severity: "info", dedupKey: "all1" }));
    expect(tg.sends.length).toBe(1);
  });

  it("critical @ level silent → Telegram молчит, но email-гарантия + ledger delivered", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "silent" });
    const tg = new FakeTelegram();
    const email = new FakeEmail();
    await makeInformer(tg, email).emit(ev(tenantWith, { severity: "critical", dedupKey: "crit" }));
    expect(tg.sends.length).toBe(0);
    expect(email.sends.length).toBe(1);
    const row = await lastRow(tenantWith, "crit");
    expect(row?.deliveredAt).not.toBeNull();
  });

  it("тема выключена → событие отброшено (нет строки в ленте)", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "all", informerTopics: '{"orders":false}' });
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emit(ev(tenantWith, { topic: "orders", dedupKey: "topoff" }));
    expect(tg.sends.length).toBe(0);
    expect(await rowCount(tenantWith, "topoff")).toBe(0);
  });

  it("мут → реалтайм гасится, событие копится в дайджест", async () => {
    if (!enabled) return;
    const future = Math.floor(Date.now() / 1000) + 3600;
    await setOwner(tenantWith, { informerLevel: "important", informerMutedUntil: future });
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emit(ev(tenantWith, { severity: "important", dedupKey: "muted" }));
    expect(tg.sends.length).toBe(0);
    const row = await lastRow(tenantWith, "muted");
    expect(row?.deliveredAt).toBeNull();
  });

  it("persisted-дедуп давит повтор того же dedupKey", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "important" });
    const tg = new FakeTelegram();
    const informer = makeInformer(tg, new FakeEmail());
    const e = ev(tenantWith, { dedupKey: "dup" });
    await informer.emit(e);
    await informer.emit(e);
    expect(tg.sends.length).toBe(1);
    expect(await rowCount(tenantWith, "dup")).toBe(1);
  });

  it("нет Telegram + не critical → пропуск (нет строки)", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emit(ev(tenantNoTg, { severity: "important", dedupKey: "n-imp" }));
    expect(tg.sends.length).toBe(0);
    expect(await rowCount(tenantNoTg, "n-imp")).toBe(0);
  });

  it("нет Telegram + critical → email-гарантия + строка в ленте", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    const email = new FakeEmail();
    await makeInformer(tg, email).emit(ev(tenantNoTg, { severity: "critical", dedupKey: "n-crit" }));
    expect(tg.sends.length).toBe(0);
    expect(email.sends.length).toBe(1);
    expect(await rowCount(tenantNoTg, "n-crit")).toBe(1);
  });

  it("emitNotificationEvent: human_takeover → escalation/important, реалтайм + ledger", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "important" });
    const tg = new FakeTelegram();
    const realtime: Array<{ id: number; title: string; kind: string; readAt: number | null }> = [];
    await makeInformer(tg, new FakeEmail(), (event) => realtime.push(event)).emitNotificationEvent({
      tenantId: tenantWith,
      eventType: "human_takeover",
      leadId: 5,
      data: { displayName: "Иван" },
    });
    expect(tg.sends.length).toBe(1);
    const row = await lastRow(tenantWith, "human_takeover:5");
    expect(row?.topic).toBe("escalation");
    expect(row?.severity).toBe("important");
    expect(row?.kind).toBe("human_takeover");
    expect(realtime).toEqual([
      expect.objectContaining({
        id: row?.id,
        title: "Нужна помощь оператора",
        kind: "human_takeover",
        readAt: null,
      }),
    ]);
  });

  it("emitNotificationEvent: неизвестный eventType → ничего (нет строки)", async () => {
    if (!enabled) return;
    const tg = new FakeTelegram();
    await makeInformer(tg, new FakeEmail()).emitNotificationEvent({
      tenantId: tenantWith,
      eventType: "no_such_event",
      leadId: 7,
      data: {},
    });
    expect(tg.sends.length).toBe(0);
    expect(await rowCount(tenantWith, "no_such_event:7")).toBe(0);
  });

  it("resolveOwnerAdminId: владелец → adminId, чужой тенант → null", async () => {
    if (!enabled) return;
    const informer = makeInformer(null, new FakeEmail());
    expect(await informer.resolveOwnerAdminId(tenantWith)).toBe(ownerAdminId);
    expect(await informer.resolveOwnerAdminId(999_999)).toBeNull();
  });

  it("markNotificationDelivered падает → warn, доставка не ломается", async () => {
    if (!enabled) return;
    await setOwner(tenantWith, { informerLevel: "important" });
    const tg = new FakeTelegram();
    const warns: string[] = [];
    const informer = new AdminInformer({
      db,
      botToken: "",
      appUrl: "http://x",
      telegram: tg,
      email: new FakeEmail(),
      cooldownSec: 3600,
      log: { warn: (msg) => warns.push(String(msg)) },
    });
    // Пост-доставочный апдейт ленты идёт через приватный repo — ломаем его,
    // чтобы покрыть catch вокруг markNotificationDelivered.
    (
      informer as unknown as {
        repo: { markNotificationDelivered: () => Promise<void> };
      }
    ).repo = {
      markNotificationDelivered: async () => {
        throw new Error("ledger down");
      },
    };

    await informer.emit(ev(tenantWith, { dedupKey: "mark-fail" }));

    expect(tg.sends.length).toBe(1); // реалтайм ушёл
    expect(warns).toContain("[informer] mark delivered failed");
    const row = await lastRow(tenantWith, "mark-fail");
    expect(row?.deliveredAt).toBeNull(); // апдейт не прошёл, событие ждёт дайджеста
  });
});
