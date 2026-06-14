/**
 * CheckinSweeper: lifecycle (run/stop/abort/error) + интеграция sweep'а
 * (overdue-лид с активным каналом → check-in в outbound_queue + last_checkin_at).
 * Интеграция требует DATABASE_URL; без него — graceful-skip.
 */
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  funnels,
  leads,
  outboundQueue,
  schema,
  stageDefinitions,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { resolve } from "node:path";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { CheckinSweeper } from "./checkin-sweep.ts";

// ── lifecycle (без БД) ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test stub
const stubDb = { select: () => ({ from: () => ({ where: async () => [] }) }) } as any;
const setSweep = (s: CheckinSweeper, fn: () => Promise<void>) => {
  (s as unknown as { sweep: () => Promise<void> }).sweep = fn;
};

describe("CheckinSweeper lifecycle", () => {
  it("stop() останавливает цикл", async () => {
    const s = new CheckinSweeper(stubDb, { intervalMs: 50 });
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
    const s = new CheckinSweeper(stubDb, { intervalMs: 50 });
    setSweep(s, async () => {});
    const ctrl = new AbortController();
    const p = s.run(ctrl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await p;
    expect(true).toBe(true);
  });

  it("ошибка sweep ловится и не валит цикл", async () => {
    const s = new CheckinSweeper(stubDb, { intervalMs: 20 });
    const spy = mock(() => {});
    const orig = console.error;
    console.error = spy;
    let calls = 0;
    setSweep(s, async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    });
    try {
      const p = s.run();
      await new Promise((r) => setTimeout(r, 55));
      s.stop();
      await p;
    } finally {
      console.error = orig;
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── интеграция sweep'а ──────────────────────────────────────────────────────

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_checkin_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let leadId = 0;
let enabled = false;

const runSweep = (s: CheckinSweeper) => (s as unknown as { sweep: () => Promise<void> }).sweep();

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

  const [t] = await db.insert(tenants).values({ slug: `chk-${now}` }).returning({ id: tenants.id });
  tenantId = t!.id;
  const [f] = await db.insert(funnels).values({ tenantId, slug: `f-${now}` }).returning({ id: funnels.id });
  const [st] = await db
    .insert(stageDefinitions)
    .values({ tenantId, funnelId: f!.id, slug: "active", displayName: "Active", kind: "active", checkinIntervalDays: 1 })
    .returning({ id: stageDefinitions.id });
  const [c] = await db.insert(contacts).values({ tenantId }).returning({ id: contacts.id });
  // updated_at 2 дня назад → overdue при interval=1
  const [l] = await db
    .insert(leads)
    .values({ tenantId, userId: c!.id, stageDefinitionId: st!.id, updatedAt: now - 2 * 86400 })
    .returning({ id: leads.id });
  leadId = l!.id;
  const [ch] = await db
    .insert(channels)
    .values({ tenantId, kind: "telegram_bot", externalId: `bot-${now}`, status: "active" })
    .returning({ id: channels.id });
  await db.insert(channelIdentities).values({ contactId: c!.id, channelId: ch!.id, externalUserId: "tg-1" });
  await db.insert(conversations).values({ tenantId, userId: c!.id, source: "bot", mode: "ai" });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("CheckinSweeper.sweep (интеграция)", () => {
  it("overdue-лид → check-in в очередь + last_checkin_at; повтор идемпотентен", async () => {
    if (!enabled) return;
    const sweeper = new CheckinSweeper(db, { intervalMs: 1, messageText: "ping" });
    await runSweep(sweeper);

    const queued = await db.select().from(outboundQueue).where(eq(outboundQueue.tenantId, tenantId));
    expect(queued.length).toBe(1);
    expect(queued[0]!.payloadJson).toContain("ping");

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead?.lastCheckinAt).not.toBeNull();

    // второй проход: last_checkin_at = now → больше не overdue → без новых сообщений
    await runSweep(sweeper);
    const after = await db.select().from(outboundQueue).where(eq(outboundQueue.tenantId, tenantId));
    expect(after.length).toBe(1);
  });

  it("нет overdue-лидов у другого (пустого) тенанта → без отправок", async () => {
    if (!enabled) return;
    const now = Math.floor(Date.now() / 1000);
    const [t2] = await db.insert(tenants).values({ slug: `chk-empty-${now}` }).returning({ id: tenants.id });
    const sweeper = new CheckinSweeper(db, { intervalMs: 1 });
    await runSweep(sweeper);
    const q = await db.select().from(outboundQueue).where(eq(outboundQueue.tenantId, t2!.id));
    expect(q.length).toBe(0);
  });

  it("лид overdue по updatedAt, но с активным диалогом → чек-ин пропускается", async () => {
    if (!enabled) return;
    const now = Math.floor(Date.now() / 1000);
    const [t] = await db
      .insert(tenants)
      .values({ slug: `chk-active-${now}` })
      .returning({ id: tenants.id });
    const tid = t!.id;
    const [f] = await db
      .insert(funnels)
      .values({ tenantId: tid, slug: `f-a-${now}` })
      .returning({ id: funnels.id });
    const [st] = await db
      .insert(stageDefinitions)
      .values({
        tenantId: tid,
        funnelId: f!.id,
        slug: "active",
        displayName: "Active",
        kind: "active",
        checkinIntervalDays: 1,
      })
      .returning({ id: stageDefinitions.id });
    const [c] = await db.insert(contacts).values({ tenantId: tid }).returning({ id: contacts.id });
    await db
      .insert(leads)
      .values({ tenantId: tid, userId: c!.id, stageDefinitionId: st!.id, updatedAt: now - 2 * 86400 });
    const [ch] = await db
      .insert(channels)
      .values({ tenantId: tid, kind: "telegram_bot", externalId: `bot-a-${now}`, status: "active" })
      .returning({ id: channels.id });
    await db.insert(channelIdentities).values({ contactId: c!.id, channelId: ch!.id, externalUserId: "tg-a" });
    // Диалог со СВЕЖИМ сообщением — клиент в живой переписке.
    await db
      .insert(conversations)
      .values({ tenantId: tid, userId: c!.id, source: "bot", mode: "ai", lastMessageAt: now });

    const sweeper = new CheckinSweeper(db, { intervalMs: 1, messageText: "ping" });
    await runSweep(sweeper);

    const q = await db.select().from(outboundQueue).where(eq(outboundQueue.tenantId, tid));
    expect(q.length).toBe(0);
  });
});
