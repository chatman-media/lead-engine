/**
 * Интеграционно проверяем, что operations-watcher ловит каждый сигнал
 * (устаревший фид, зависшая заявка, упавший канал, всплеск оборота) и не
 * дублирует алерты в пределах cooldown.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  exchangeOrders,
  exchangeRates,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  type OpsAlert,
  type OpsAlertSink,
  OperationsWatchSweeper,
  type OpsWatchThresholds,
} from "./ops-watch-sweep.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ops_watch_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

const THRESHOLDS: OpsWatchThresholds = {
  feedStaleMin: 20,
  stuckOrderMin: 45,
  volumeSpikeThb: 1000,
  alertCooldownMin: 60,
};

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let enabled = false;
let now = 0;

class CapturingSink implements OpsAlertSink {
  readonly alerts: OpsAlert[] = [];
  async emit(alert: OpsAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });

  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  now = Math.floor(Date.now() / 1000);

  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: `ops-watch-${now}` })
    .returning({ id: schema.tenants.id });
  tenantId = tenant!.id;

  await withTenant(db, tenantId, async (tx) => {
    // Устаревший auto-курс (фид встал).
    await tx.insert(exchangeRates).values({
      tenantId,
      asset: "USDT",
      quoteAsset: "THB",
      network: "trc20",
      baseRate: 31.5,
      quoteMode: "multiply",
      autoUpdate: true,
      isActive: true,
      createdAt: now - 7200,
      updatedAt: now - (THRESHOLDS.feedStaleMin + 10) * 60,
    });
    // Зависшая заявка (оплачена, выдачи нет).
    await tx.insert(exchangeOrders).values({
      tenantId,
      direction: "USDT->THB",
      assetFrom: "USDT",
      network: "trc20",
      amountFrom: 100,
      rate: 31,
      amountToThb: 3100,
      status: "paid",
      createdAt: now - 7200,
      updatedAt: now - (THRESHOLDS.stuckOrderMin + 5) * 60,
    });
    // Свежая завершённая заявка — для всплеска оборота.
    await tx.insert(exchangeOrders).values({
      tenantId,
      direction: "USDT->THB",
      assetFrom: "USDT",
      network: "trc20",
      amountFrom: 200,
      rate: 31,
      amountToThb: 5000,
      status: "completed",
      createdAt: now - 600,
      updatedAt: now - 600,
      completedAt: now - 600,
    });
    // Упавший канал.
    await tx.insert(channels).values({
      tenantId,
      kind: "telegram_bot",
      externalId: "mock-tg",
      status: "error",
      createdAt: now,
      updatedAt: now,
    });
  });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("OperationsWatchSweeper", () => {
  it("ловит все четыре сигнала за один проход", async () => {
    if (!enabled) return;
    const sink = new CapturingSink();
    const sweeper = new OperationsWatchSweeper(db, {
      intervalMs: 1000,
      sink,
      thresholds: THRESHOLDS,
    });
    await sweeper.sweepTenant(tenantId, now);

    const kinds = new Set(sink.alerts.map((a) => a.kind));
    expect(kinds.has("rate_feed_stale")).toBe(true);
    expect(kinds.has("order_stuck")).toBe(true);
    expect(kinds.has("channel_down")).toBe(true);
    expect(kinds.has("volume_spike")).toBe(true);
    // критичность зависших заявок и упавших каналов
    expect(sink.alerts.find((a) => a.kind === "order_stuck")?.severity).toBe("critical");
    expect(sink.alerts.find((a) => a.kind === "channel_down")?.severity).toBe("critical");
  });

  it("не дублирует алерты в пределах cooldown (анти-шторм)", async () => {
    if (!enabled) return;
    const sink = new CapturingSink();
    const sweeper = new OperationsWatchSweeper(db, {
      intervalMs: 1000,
      sink,
      thresholds: THRESHOLDS,
    });
    await sweeper.sweepTenant(tenantId, now);
    const firstCount = sink.alerts.length;
    expect(firstCount).toBeGreaterThan(0);
    // повторный проход в ту же секунду — cooldown давит всё
    await sweeper.sweepTenant(tenantId, now + 5);
    expect(sink.alerts.length).toBe(firstCount);
  });

  it("свежий фид не роняет rate_feed_stale", async () => {
    if (!enabled) return;
    const loose: OpsWatchThresholds = { ...THRESHOLDS, feedStaleMin: 100000 };
    const sink = new CapturingSink();
    const sweeper = new OperationsWatchSweeper(db, { intervalMs: 1000, sink, thresholds: loose });
    await sweeper.sweepTenant(tenantId, now);
    expect(sink.alerts.some((a) => a.kind === "rate_feed_stale")).toBe(false);
  });
});
