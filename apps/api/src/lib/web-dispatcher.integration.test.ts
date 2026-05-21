// Integration test для WebOutboundDispatcher с реальной Postgres + реальным
// WebChannelAdapter (с мокнутым IWebSocket — нам не нужен Bun.serve).
//
// Проверяет:
//   - kind='web' rows claim'ятся (а kind='telegram_bot' — нет, изоляция от
//     worker'овского dispatcher'а)
//   - delivery через adapter.send → frames на mock-socket'е, markSent
//   - WebDeliveryError ("no active connection") → markFailed reason=web_offline

import type { IWebSocket } from "@chatman-media/channel-web";
import { WebChannelAdapter } from "@chatman-media/channel-web";
import { makeDefaultLogger, makePlatformMetrics } from "@chatman-media/observability";
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
import { WebChannelRegistry, type WebChannelEntry } from "./web-channel-registry.ts";
import { WebOutboundDispatcher } from "./web-dispatcher.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_webdisp_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let webChannelDbId = 0;
let tgChannelDbId = 0;

class MockWebSocket implements IWebSocket {
  readonly sent: string[] = [];
  readyState = 1;
  send(data: string): void {
    this.sent.push(data);
  }
  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
  }
}

class TestWebRegistry extends WebChannelRegistry {
  add(entry: WebChannelEntry): void {
    // biome-ignore lint/suspicious/noExplicitAny: туннелируемся в private
    (this as any).byChannelDbId.set(entry.channelDbId, entry);
    // biome-ignore lint/suspicious/noExplicitAny: туннелируемся в private
    (this as any).byTenantSlug.set(entry.tenantSlug, entry);
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
    // RLS FORCE — см. comment в dispatcher.integration.test.ts
    const rlsTables = await sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true
    `;
    for (const { tablename } of rlsTables) {
      await sql.unsafe(`ALTER TABLE "${tablename}" NO FORCE ROW LEVEL SECURITY`);
    }
    db = drizzle(sql, { schema });

    const [t] = await db
      .insert(tenants)
      .values({ slug: "webdisp", plan: "free", status: "active", llmBillingMode: "byok" })
      .returning();
    if (!t) throw new Error("seed tenant");
    tenantId = t.id;

    const [webCh] = await db
      .insert(channels)
      .values({ tenantId, kind: "web", externalId: "web-disp", status: "active" })
      .returning();
    if (!webCh) throw new Error("seed web channel");
    webChannelDbId = webCh.id;

    const [tgCh] = await db
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: "tg-disp", status: "active" })
      .returning();
    if (!tgCh) throw new Error("seed tg channel");
    tgChannelDbId = tgCh.id;
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
  await db.execute(drizzleSql`DELETE FROM outbound_queue WHERE tenant_id = ${tenantId}`);
});

function makeDispatcher(registry: WebChannelRegistry, metrics = makePlatformMetrics()) {
  return {
    metrics,
    dispatcher: new WebOutboundDispatcher(db, registry, {
      pollMs: 50,
      batchSize: 16,
      metrics,
      log: makeDefaultLogger("test"),
    }),
  };
}

async function seedWebEnvelope(channelDbId: number, userId: string, text: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const [row] = await db
    .insert(outboundQueue)
    .values({
      tenantId,
      channelId: channelDbId,
      payloadJson: JSON.stringify({
        channelId: String(channelDbId),
        externalUserId: userId,
        parts: [{ kind: "text", text }],
      }),
      scheduledAt: now,
      status: "pending",
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("seed outbound row");
  return row.id;
}

describe("WebOutboundDispatcher integration", () => {
  it("kind='web' row → adapter.send → markSent, frame на WS-клиенте", async () => {
    if (!sql) return;
    const registry = new TestWebRegistry();
    const adapter = new WebChannelAdapter({ id: String(webChannelDbId) });
    registry.add({
      channelDbId: webChannelDbId,
      tenantId,
      tenantSlug: "webdisp",
      externalId: "web-disp",
      adapter,
    });
    const fakeWs = new MockWebSocket();
    adapter.acceptConnection(fakeWs, "u-1");
    expect(fakeWs.sent[0]).toContain('"type":"ready"');

    const { dispatcher, metrics } = makeDispatcher(registry);
    const queueId = await seedWebEnvelope(webChannelDbId, "u-1", "из web");

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    const [row] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, queueId));
    expect(row?.status).toBe("sent");
    // adapter.send отправил bot_text frame в pinned WS.
    expect(fakeWs.sent.some((s) => s.includes('"type":"bot_text"') && s.includes("из web"))).toBe(
      true,
    );
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_sent_total{kind="web",tenant="${tenantId}"} 1`,
    );
  });

  it("kind='telegram_bot' row игнорируется (фильтр claimPending по kinds=['web'])", async () => {
    if (!sql) return;
    const registry = new TestWebRegistry();
    // Пустой registry — web channel НЕ добавляем чтобы проверить чистую
    // фильтрацию (если бы фильтр упал — добрался бы до registry-miss).
    // Но size()==0 — tick стартует SELECT activeTenants всё равно, но
    // claim не вернёт ни одной row. Эмулируем это, явно добавив фейковую
    // entry для НЕ-этого канала (size>0).
    registry.add({
      channelDbId: 99_999, // несуществующий
      tenantId,
      tenantSlug: "x",
      externalId: "x",
      adapter: new WebChannelAdapter({ id: "x" }),
    });
    const { dispatcher } = makeDispatcher(registry);

    const tgQueueId = await seedWebEnvelope(tgChannelDbId, "u-1", "не для web");

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    const [row] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, tgQueueId));
    expect(row?.status).toBe("pending"); // telegram_bot row остался pending — web dispatcher его не трогает
  });

  it("offline user (no active WS) → markFailed reason=web_offline", async () => {
    if (!sql) return;
    const registry = new TestWebRegistry();
    const adapter = new WebChannelAdapter({ id: String(webChannelDbId) });
    registry.add({
      channelDbId: webChannelDbId,
      tenantId,
      tenantSlug: "webdisp",
      externalId: "web-disp",
      adapter,
    });
    // НЕ вызываем acceptConnection — у user'а нет open WS.

    const { dispatcher, metrics } = makeDispatcher(registry);
    const queueId = await seedWebEnvelope(webChannelDbId, "offline-user", "ау?");

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    const [row] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, queueId));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("no active connection");
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_failed_total{reason="web_offline",tenant="${tenantId}"} 1`,
    );
  });

  it("invalid payload_json → markFailed reason=bad_payload", async () => {
    if (!sql) return;
    const registry = new TestWebRegistry();
    const adapter = new WebChannelAdapter({ id: String(webChannelDbId) });
    registry.add({
      channelDbId: webChannelDbId,
      tenantId,
      tenantSlug: "webdisp",
      externalId: "web-disp",
      adapter,
    });
    const { dispatcher, metrics } = makeDispatcher(registry);

    const now = Math.floor(Date.now() / 1000);
    const [row] = await db
      .insert(outboundQueue)
      .values({
        tenantId,
        channelId: webChannelDbId,
        payloadJson: "{broken",
        scheduledAt: now,
        status: "pending",
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("seed row");

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    const [updated] = await db
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.id, row.id));
    expect(updated?.status).toBe("failed");
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_failed_total{reason="bad_payload",tenant="${tenantId}"} 1`,
    );
  });

  it("empty registry — tick no-op без SELECT'а на tenants", async () => {
    if (!sql) return;
    const registry = new TestWebRegistry();
    // Ничего не добавляем — registry.size() === 0.
    const { dispatcher } = makeDispatcher(registry);
    // Просто проверяем что не падает и не делает destructive операций.
    await expect(
      (dispatcher as unknown as { tick: () => Promise<void> }).tick(),
    ).resolves.toBeUndefined();
  });
});
