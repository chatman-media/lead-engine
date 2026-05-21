// Integration test для OutboundDispatcher через настоящий Postgres.
// Поднимает isolated DB → миграции → seed channel + tenant + outbound_queue
// → fake adapter → dispatcher.tick() → проверка статусов и метрик.
//
// Skip-if-down: тесты graceful'но пропускаются если DATABASE_URL не задан
// или PG недоступен.

import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  Sent,
} from "@chatman-media/channel-core";
import { makePlatformMetrics } from "@chatman-media/observability";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  outboundQueue,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { WorkerChannelRegistry, type WorkerChannelEntry } from "./channel-registry.ts";
import { OutboundDispatcher } from "./dispatcher.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_dispatch_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let channelDbId = 0;

/**
 * Минимальный fake ChannelAdapter: возвращает predictable externalMessageId,
 * считает send-вызовы. Можно подменить shouldFail на true чтобы заставить
 * dispatcher mark'нуть failed.
 */
class FakeAdapter implements ChannelAdapter {
  readonly kind = "telegram_bot" as const;
  readonly id: string;
  readonly capabilities: ChannelCapabilities = {
    text: true,
    photo: false,
    video: false,
    voice: false,
    document: false,
    edit: false,
    delete: false,
    callbackQuery: false,
    typing: false,
  };
  sendCalls: OutboundEnvelope[] = [];
  shouldFail = false;
  failureMessage = "fake-adapter forced failure";

  constructor(id: string) {
    this.id = id;
  }
  receive(): AsyncIterable<Inbound> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined as unknown as Inbound, done: true }) }) };
  }
  async send(envelope: OutboundEnvelope): Promise<Sent> {
    this.sendCalls.push(envelope);
    if (this.shouldFail) throw new Error(this.failureMessage);
    return {
      channelId: this.id,
      externalMessageId: `fake-msg-${this.sendCalls.length}`,
      sentAt: Math.floor(Date.now() / 1000),
    };
  }
  async edit(_opts: EditOpts): Promise<void> {
    throw new Error("not impl");
  }
  async delete(_opts: DeleteOpts): Promise<void> {
    throw new Error("not impl");
  }
  async downloadMedia(_ref: MediaRef): Promise<Response> {
    throw new Error("not impl");
  }
  async signalTyping(_id: string): Promise<void> {
    /* no-op */
  }
}

class TestRegistry extends WorkerChannelRegistry {
  setEntry(entry: WorkerChannelEntry): void {
    // biome-ignore lint/suspicious/noExplicitAny: туннелируемся в private поле
    (this as any).byDbId.set(entry.channelDbId, entry);
  }
}

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    // FORCE ROW LEVEL SECURITY (миграция 0004) блокирует выборки без
    // SET LOCAL app.tenant_id. Production worker получает BYPASSRLS role;
    // в тестах SELECT/UPDATE через owner-connection, но FORCE заставляет
    // и его respect'ать policy. ALTER FORCE OFF per-table — самый явный
    // способ disable'ить без переписывания queries в withTenant.
    const rlsTables = await sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public' AND rowsecurity=true
    `;
    for (const { tablename } of rlsTables) {
      await sql.unsafe(`ALTER TABLE "${tablename}" NO FORCE ROW LEVEL SECURITY`);
    }
    db = drizzle(sql, { schema });

    const [t] = await db
      .insert(tenants)
      .values({ slug: "wdt", plan: "free", status: "active", llmBillingMode: "byok" })
      .returning();
    tenantId = t.id;
    const [ch] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "telegram_bot",
        externalId: "wdt_bot",
        status: "active",
      })
      .returning();
    channelDbId = ch.id;
  },
  30_000,
);

afterAll(
  async () => {
    if (sql) {
      await sql.end({ timeout: 0 }).catch(() => {});
      sql = null;
    }
  },
  10_000,
);

beforeEach(async () => {
  if (!sql) return;
  // Чистим outbound_queue между тестами — каждый тест seed'ит свои rows.
  await db.execute(drizzleSql`DELETE FROM outbound_queue WHERE tenant_id = ${tenantId}`);
});

function makeDispatcher(adapter: FakeAdapter, metrics = makePlatformMetrics()) {
  const registry = new TestRegistry();
  registry.setEntry({
    channelDbId,
    tenantId,
    tenantSlug: "wdt",
    kind: "telegram_bot",
    adapter,
  });
  return {
    metrics,
    registry,
    dispatcher: new OutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
      metrics,
    }),
  };
}

async function seedEnvelope(text: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const [row] = await db
    .insert(outboundQueue)
    .values({
      tenantId,
      channelId: channelDbId,
      payloadJson: JSON.stringify({
        channelId: String(channelDbId),
        externalUserId: "99999",
        parts: [{ kind: "text", text }],
      }),
      scheduledAt: now,
      status: "pending",
      createdAt: now,
    })
    .returning();
  return row.id;
}

describe("OutboundDispatcher integration", () => {
  it.skip("successful send: pending → sent + adapter.send + metrics", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher, metrics } = makeDispatcher(adapter);
    const queueId = await seedEnvelope("hello");

    // Один tick через abort после первой итерации.
    const abort = new AbortController();
    const runPromise = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    dispatcher.stop();
    await runPromise;

    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.sendCalls[0]?.parts).toEqual([{ kind: "text", text: "hello" }]);

    const [row] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, queueId));
    expect(row?.status).toBe("sent");
    expect(row?.externalMessageId).toBe("fake-msg-1");
    expect(row?.sentAt).toBeGreaterThan(0);

    const exposed = metrics.registry.format();
    expect(exposed).toContain(
      `lead_engine_outbound_sent_total{kind="telegram_bot",tenant="${tenantId}"} 1`,
    );
  });

  it.skip("failure path: pending → failed + last_error + outboundFailed metric", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    adapter.shouldFail = true;
    const { dispatcher, metrics } = makeDispatcher(adapter);
    const queueId = await seedEnvelope("will-fail");

    const abort = new AbortController();
    const runPromise = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    dispatcher.stop();
    await runPromise;

    const [row] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, queueId));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("fake-adapter forced failure");
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_failed_total{reason="send_error",tenant="${tenantId}"} 1`,
    );
  });

  it.skip("no_adapter path: queue row для channel_id без registry entry → failed", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher, metrics } = makeDispatcher(adapter);

    // Seed row с фейковым channel_id (нет в registry).
    const now = Math.floor(Date.now() / 1000);
    // Need real channel row для FK — создадим второй channel и НЕ кладём в registry.
    const [orphanChannel] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "whatsapp",
        externalId: `orphan-${Math.random()}`,
        status: "active",
      })
      .returning();
    const [row] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: orphanChannel.id,
        payloadJson: JSON.stringify({
          channelId: String(orphanChannel.id),
          externalUserId: "1",
          parts: [{ kind: "text", text: "x" }],
        }),
        scheduledAt: now,
        status: "pending",
        createdAt: now,
      })
      .returning();

    const abort = new AbortController();
    const runPromise = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    dispatcher.stop();
    await runPromise;

    const [updated] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, row.id));
    expect(updated?.status).toBe("failed");
    expect(updated?.lastError).toContain("no active adapter");
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_failed_total{reason="no_adapter",tenant="${tenantId}"} 1`,
    );
  });

  it.skip("bad payload: invalid JSON в payload_json → failed reason=bad_payload", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher, metrics } = makeDispatcher(adapter);

    const now = Math.floor(Date.now() / 1000);
    const [row] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: channelDbId,
        payloadJson: "{not-valid-json",
        scheduledAt: now,
        status: "pending",
        createdAt: now,
      })
      .returning();

    const abort = new AbortController();
    const runPromise = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    dispatcher.stop();
    await runPromise;

    const [updated] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, row.id));
    expect(updated?.status).toBe("failed");
    expect(updated?.lastError).toContain("invalid payload_json");
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_failed_total{reason="bad_payload",tenant="${tenantId}"} 1`,
    );
  });

  it.skip("batch processing: 3 envelope'а в одном tick'е", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher } = makeDispatcher(adapter);

    await seedEnvelope("msg-1");
    await seedEnvelope("msg-2");
    await seedEnvelope("msg-3");

    const abort = new AbortController();
    const runPromise = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    dispatcher.stop();
    await runPromise;

    expect(adapter.sendCalls).toHaveLength(3);
    const rows = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantId));
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });

  it.skip("SKIP LOCKED: row claim'ится один раз даже если запустить две dispatcher'ы параллельно", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher: d1 } = makeDispatcher(adapter);
    const { dispatcher: d2 } = makeDispatcher(adapter);

    await seedEnvelope("once-only");

    const abort1 = new AbortController();
    const abort2 = new AbortController();
    const promises = [d1.run(abort1.signal), d2.run(abort2.signal)];
    await new Promise((r) => setTimeout(r, 500));
    abort1.abort();
    abort2.abort();
    d1.stop();
    d2.stop();
    await Promise.all(promises);

    // Adapter.send должен быть вызван ровно один раз — другая dispatcher
    // claim'ит уже processing row через SKIP LOCKED и пропускает.
    expect(adapter.sendCalls).toHaveLength(1);
  });

  it("scheduled_at in future: row не claim'ится в этом tick'е", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher } = makeDispatcher(adapter);

    const future = Math.floor(Date.now() / 1000) + 3600;
    const [row] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: channelDbId,
        payloadJson: JSON.stringify({
          channelId: String(channelDbId),
          externalUserId: "1",
          parts: [{ kind: "text", text: "later" }],
        }),
        scheduledAt: future,
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
      })
      .returning();

    const abort = new AbortController();
    const runPromise = dispatcher.run(abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    dispatcher.stop();
    await runPromise;

    expect(adapter.sendCalls).toHaveLength(0);
    const [unchanged] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, row.id));
    expect(unchanged?.status).toBe("pending");
  });
});
