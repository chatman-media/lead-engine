/**
 * ExchangePaymentSweeper: lifecycle + интеграция sweep'а.
 *   - awaiting_payment + rate_expires_at<now + last_reminder_at IS NULL → напоминание
 *     (outbound) + last_reminder_at=now;
 *   - last_reminder_at!=NULL + после грейса → status='expired'.
 * Интеграция требует DATABASE_URL; без него — graceful-skip.
 */
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  createIsolatedDb,
  exchangeOrders,
  outboundQueue,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { ExchangePaymentSweeper } from "./exchange-payment-sweep.ts";

// biome-ignore lint/suspicious/noExplicitAny: test stub
const stubDb = { select: () => ({ from: () => ({ where: async () => [] }) }) } as any;
const setSweep = (s: ExchangePaymentSweeper, fn: () => Promise<void>) => {
  (s as unknown as { sweep: () => Promise<void> }).sweep = fn;
};

describe("ExchangePaymentSweeper lifecycle", () => {
  it("stop() останавливает цикл", async () => {
    const s = new ExchangePaymentSweeper(stubDb, { intervalMs: 50 });
    let ran = 0;
    setSweep(s, async () => {
      ran++;
    });
    const p = s.run();
    await new Promise((r) => setTimeout(r, 10));
    s.stop();
    await p;
    expect(ran).toBeGreaterThanOrEqual(1);
  });

  it("AbortSignal останавливает цикл", async () => {
    const s = new ExchangePaymentSweeper(stubDb, { intervalMs: 50 });
    setSweep(s, async () => {});
    const ctrl = new AbortController();
    const p = s.run(ctrl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await p;
    expect(true).toBe(true);
  });

  it("ошибка sweep ловится", async () => {
    const s = new ExchangePaymentSweeper(stubDb, { intervalMs: 20 });
    const spy = mock(() => {});
    const orig = console.error;
    console.error = spy;
    let calls = 0;
    setSweep(s, async () => {
      calls++;
      if (calls === 1) throw new Error("x");
    });
    try {
      const p = s.run();
      await new Promise((r) => setTimeout(r, 55));
      s.stop();
      await p;
    } finally {
      console.error = orig;
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exchpay_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let contactId = 0;
let enabled = false;

const runSweep = (s: ExchangePaymentSweeper) => (s as unknown as { sweep: () => Promise<void> }).sweep();

async function makeOrder(over: Partial<typeof exchangeOrders.$inferInsert>): Promise<number> {
  const [o] = await db
    .insert(exchangeOrders)
    .values({
      tenantId,
      contactId,
      direction: "crypto_to_thb",
      assetFrom: "USDT",
      amountFrom: 100,
      rate: 35,
      amountToThb: 3500,
      status: "awaiting_payment",
      ...over,
    })
    .returning({ id: exchangeOrders.id });
  return o!.id;
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
  const [t] = await db.insert(tenants).values({ slug: `exch-${now}` }).returning({ id: tenants.id });
  tenantId = t!.id;
  const [c] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
  contactId = c!.id;
  const [ch] = await db
    .insert(channels)
    .values({ tenantId, kind: "telegram_bot", externalId: `bot-${now}`, status: "active" })
    .returning({ id: channels.id });
  await db.insert(channelIdentities).values({ contactId, channelId: ch!.id, externalUserId: "tg-1" });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ExchangePaymentSweeper.sweep (интеграция)", () => {
  it("истёкшая котировка, ещё не напоминали → напоминание + last_reminder_at", async () => {
    if (!enabled) return;
    const now = Math.floor(Date.now() / 1000);
    const orderId = await makeOrder({ rateExpiresAt: now - 100, lastReminderAt: null });
    await runSweep(new ExchangePaymentSweeper(db, { intervalMs: 1, reminderText: "expired-soon" }));

    const [o] = await db.select().from(exchangeOrders).where(eq(exchangeOrders.id, orderId));
    expect(o?.lastReminderAt).not.toBeNull();
    expect(o?.status).toBe("awaiting_payment"); // ещё не expired
    const q = await db.select().from(outboundQueue).where(eq(outboundQueue.tenantId, tenantId));
    expect(q.some((r) => r.payloadJson.includes("expired-soon"))).toBe(true);
  });

  it("после напоминания и грейса → status expired", async () => {
    if (!enabled) return;
    const now = Math.floor(Date.now() / 1000);
    const orderId = await makeOrder({ rateExpiresAt: now - 700, lastReminderAt: now - 650 });
    await runSweep(new ExchangePaymentSweeper(db, { intervalMs: 1 }));
    const [o] = await db.select().from(exchangeOrders).where(eq(exchangeOrders.id, orderId));
    expect(o?.status).toBe("expired");
  });
});
