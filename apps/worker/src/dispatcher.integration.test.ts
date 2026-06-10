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
  readonly kind: "telegram_bot" | "whatsapp";
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

  constructor(id: string, kind: "telegram_bot" | "whatsapp" = "telegram_bot") {
    this.id = id;
    this.kind = kind;
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
    if (!t) throw new Error("seed: tenants insert returned no row");
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
    if (!ch) throw new Error("seed: channels insert returned no row");
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

function makeDispatcher(
  adapter: FakeAdapter,
  metrics = makePlatformMetrics(),
  dispatcherOpts: { claimKinds?: string[] } = {},
) {
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
      ...(dispatcherOpts.claimKinds ? { claimKinds: dispatcherOpts.claimKinds } : {}),
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
  if (!row) throw new Error("seedEnvelope: insert returned no row");
  return row.id;
}

describe("OutboundDispatcher integration", () => {
  it("successful send: pending → sent + adapter.send + metrics", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher, metrics } = makeDispatcher(adapter);
    const queueId = await seedEnvelope("hello");

    // Один tick через abort после первой итерации.
    // Прямой tick() обходит run/abort/sleep race в тестах.
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

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

  it("failure path: pending → failed + last_error + outboundFailed metric", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    adapter.shouldFail = true;
    const { dispatcher, metrics } = makeDispatcher(adapter);
    const queueId = await seedEnvelope("will-fail");

    // Прямой tick() обходит run/abort/sleep race в тестах.
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

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

  it("no_adapter path: queue row для channel_id без registry entry → failed", async () => {
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
    if (!orphanChannel) throw new Error("seed: orphan channel insert returned no row");
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
    if (!row) throw new Error("seed: outbound row insert returned no row");

    // Прямой tick() обходит run/abort/sleep race в тестах.
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

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

  it("bad payload: invalid JSON в payload_json → failed reason=bad_payload", async () => {
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
    if (!row) throw new Error("seed: outbound row insert returned no row");

    // Прямой tick() обходит run/abort/sleep race в тестах.
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

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

  it("WhatsApp requires approved template for cold provider outreach", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [waChannel] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "whatsapp",
        externalId: `wa-${Math.random()}`,
        status: "active",
      })
      .returning();
    if (!waChannel) throw new Error("seed: whatsapp channel insert returned no row");

    const [contact] = await db
      .insert(schema.contacts)
      .values({ tenantId, displayName: "Provider customer", createdAt: now, updatedAt: now })
      .returning({ id: schema.contacts.id });
    if (!contact) throw new Error("seed: contact insert returned no row");
    const [order] = await db
      .insert(schema.serviceOrders)
      .values({
        tenantId,
        customerContactId: contact.id,
        requestType: "massage",
        status: "awaiting_provider",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.serviceOrders.id });
    if (!order) throw new Error("seed: service order insert returned no row");

    const [queueRow] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: waChannel.id,
        payloadJson: JSON.stringify({
          channelId: String(waChannel.id),
          externalUserId: "66999999999",
          parts: [{ kind: "text", text: "cold provider ping" }],
          transport: { whatsapp: { requiresTemplate: true } },
        }),
        scheduledAt: now,
        status: "pending",
        createdAt: now,
      })
      .returning();
    if (!queueRow) throw new Error("seed: outbound insert returned no row");
    const [providerRequest] = await db
      .insert(schema.providerRequests)
      .values({
        tenantId,
        orderId: order.id,
        channelId: waChannel.id,
        outboundQueueId: queueRow.id,
        status: "sent",
        createdAt: now,
        updatedAt: now,
        sentAt: now,
      })
      .returning({ id: schema.providerRequests.id });
    if (!providerRequest) throw new Error("seed: provider request insert returned no row");

    const adapter = new FakeAdapter(String(waChannel.id), "whatsapp");
    const notifications: Array<{ eventType: string; data: Record<string, unknown> }> = [];
    const registry = new TestRegistry();
    registry.setEntry({
      channelDbId: waChannel.id,
      tenantId,
      tenantSlug: "wdt",
      kind: "whatsapp",
      adapter,
    });
    const dispatcher = new OutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
      notifications: {
        notify: async (event: { eventType: string; data: Record<string, unknown> }) => {
          notifications.push(event);
        },
      } as never,
    });

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(adapter.sendCalls).toHaveLength(0);
    const [updatedQueue] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, queueRow.id));
    expect(updatedQueue?.status).toBe("failed");
    expect(updatedQueue?.lastError).toContain("approved template");
    const [updatedRequest] = await db
      .select()
      .from(schema.providerRequests)
      .where(eq(schema.providerRequests.id, providerRequest.id));
    expect(updatedRequest?.status).toBe("failed");
    const events = await db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.providerRequestId, providerRequest.id));
    expect(events.map((event) => event.eventType)).toContain("provider_request_send_failed");
    expect(notifications).toContainEqual(
      expect.objectContaining({
        eventType: "provider_request_send_failed",
        data: expect.objectContaining({
          providerRequestId: providerRequest.id,
          outboundQueueId: queueRow.id,
        }),
      }),
    );
  });

  it("WhatsApp rejects expired free-form provider outreach without template", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [waChannel] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "whatsapp",
        externalId: `wa-expired-${Math.random()}`,
        status: "active",
      })
      .returning();
    if (!waChannel) throw new Error("seed: whatsapp channel insert returned no row");

    const [queueRow] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: waChannel.id,
        payloadJson: JSON.stringify({
          channelId: String(waChannel.id),
          externalUserId: "66999999998",
          parts: [{ kind: "text", text: "window expired" }],
          transport: { whatsapp: { freeFormWindowUntil: now - 60 } },
        }),
        scheduledAt: now,
        status: "pending",
        createdAt: now,
      })
      .returning();
    if (!queueRow) throw new Error("seed: outbound insert returned no row");

    const adapter = new FakeAdapter(String(waChannel.id), "whatsapp");
    const registry = new TestRegistry();
    registry.setEntry({
      channelDbId: waChannel.id,
      tenantId,
      tenantSlug: "wdt",
      kind: "whatsapp",
      adapter,
    });
    const dispatcher = new OutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
    });

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(adapter.sendCalls).toHaveLength(0);
    const [updatedQueue] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, queueRow.id));
    expect(updatedQueue?.status).toBe("failed");
    expect(updatedQueue?.lastError).toContain("free-form window expired");
  });

  it("batch processing: 3 envelope'а в одном tick'е", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher } = makeDispatcher(adapter);

    await seedEnvelope("msg-1");
    await seedEnvelope("msg-2");
    await seedEnvelope("msg-3");

    // Прямой tick() обходит run/abort/sleep race в тестах.
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(adapter.sendCalls).toHaveLength(3);
    const rows = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantId));
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });

  it("SKIP LOCKED: row claim'ится один раз даже если запустить две dispatcher'ы параллельно", async () => {
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

  it("kinds filter: web rows не claim'ятся когда whitelist=[telegram_bot]", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const { dispatcher } = makeDispatcher(adapter, undefined, {
      claimKinds: ["telegram_bot"],
    });

    // Создаём отдельный web-канал и envelope для него — dispatcher
    // должен пропустить эту row (нет в whitelist'е).
    const [webChannel] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "web",
        externalId: `web-${Math.random()}`,
        status: "active",
      })
      .returning();
    if (!webChannel) throw new Error("seed: web channel insert returned no row");
    const now = Math.floor(Date.now() / 1000);
    const [webRow] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: webChannel.id,
        payloadJson: JSON.stringify({
          channelId: String(webChannel.id),
          externalUserId: "u1",
          parts: [{ kind: "text", text: "for-web" }],
        }),
        scheduledAt: now,
        status: "pending",
        createdAt: now,
      })
      .returning();
    if (!webRow) throw new Error("seed: web row insert returned no row");

    // Кладём также telegram_bot envelope — должен claim'нуться + delivered.
    const tgQueueId = await seedEnvelope("for-telegram");

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    // telegram_bot row — sent.
    const [tgRow] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, tgQueueId));
    expect(tgRow?.status).toBe("sent");
    expect(adapter.sendCalls).toHaveLength(1);

    // web row — всё ещё pending (filter отсёк).
    const [webRowAfter] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, webRow.id));
    expect(webRowAfter?.status).toBe("pending");
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
    if (!row) throw new Error("seed: outbound row insert returned no row");

    // Прямой tick() обходит run/abort/sleep race в тестах.
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(adapter.sendCalls).toHaveLength(0);
    const [unchanged] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, row.id));
    expect(unchanged?.status).toBe("pending");
  });

  it("stuck processing row: releaseStuckProcessing возвращает в pending + retry в том же tick'е", async () => {
    if (!sql) return;
    const adapter = new FakeAdapter(String(channelDbId));
    const registry = new TestRegistry();
    registry.setEntry({
      channelDbId,
      tenantId,
      tenantSlug: "wdt",
      kind: "telegram_bot",
      adapter,
    });
    // stuckCheckPeriodTicks=0 → проверка зависших на каждом tick'е.
    const dispatcher = new OutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
      stuckProcessingSec: 300,
      stuckCheckPeriodTicks: 0,
    });

    // Row завис в processing (worker умер не дойдя до markSent/markFailed).
    const now = Math.floor(Date.now() / 1000);
    const [stuckRow] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: channelDbId,
        payloadJson: JSON.stringify({
          channelId: String(channelDbId),
          externalUserId: "1",
          parts: [{ kind: "text", text: "stuck-then-retried" }],
        }),
        scheduledAt: now - 1000, // старше cutoff (now - 300)
        status: "processing",
        createdAt: now - 1000,
      })
      .returning();
    if (!stuckRow) throw new Error("seed: stuck row insert returned no row");

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    // released → pending → claim'нут и доставлен в том же tick'е.
    expect(adapter.sendCalls).toHaveLength(1);
    const [updated] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, stuckRow.id));
    expect(updated?.status).toBe("sent");
  });

  it("provider failure reasons маппятся в метрику lead_engine_provider_failures_total", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    const [waChannel] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "whatsapp",
        externalId: `wa-reasons-${Math.random()}`,
        status: "active",
      })
      .returning();
    if (!waChannel) throw new Error("seed: whatsapp channel insert returned no row");

    const adapter = new FakeAdapter(String(waChannel.id), "whatsapp");
    adapter.shouldFail = true;
    const registry = new TestRegistry();
    registry.setEntry({
      channelDbId: waChannel.id,
      tenantId,
      tenantSlug: "wdt",
      kind: "whatsapp",
      adapter,
    });
    const metrics = makePlatformMetrics();
    const dispatcher = new OutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
      metrics,
    });

    // Каждое сообщение об ошибке отправки → своя reason-метка.
    const cases: Array<{ message: string; reason: string }> = [
      { message: "template rejected by Meta", reason: "template" },
      { message: "free-form window closed upstream", reason: "free_form_window" },
      { message: "no adapter session", reason: "no_adapter" },
      { message: "payload too large", reason: "bad_payload" },
      { message: "totally unexpected boom", reason: "send_error" },
    ];
    for (const c of cases) {
      adapter.failureMessage = c.message;
      const [row] = await db
        .insert(outboundQueue)
        .values({
          tenantId,
          channelId: waChannel.id,
          payloadJson: JSON.stringify({
            channelId: String(waChannel.id),
            externalUserId: "66999999997",
            parts: [{ kind: "text", text: `fail: ${c.reason}` }],
          }),
          scheduledAt: now,
          status: "pending",
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("seed: outbound row insert returned no row");

      await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

      const [updated] = await db
        .select()
        .from(outboundQueue)
        .where(eq(outboundQueue.id, row.id));
      expect(updated?.status).toBe("failed");
      expect(updated?.lastError).toBe(c.message);
    }

    const providerLines = metrics.registry
      .format()
      .split("\n")
      .filter((l) => l.startsWith("lead_engine_provider_failures_total{"));
    for (const c of cases) {
      expect(
        providerLines.some(
          (l) =>
            l.includes(`reason="${c.reason}"`) &&
            l.includes('channel_kind="whatsapp"') &&
            l.endsWith(" 1"),
        ),
      ).toBe(true);
    }
  });
});
