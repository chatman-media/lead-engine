// E2E проверка что OutboundDispatcher работает под non-BYPASSRLS Postgres
// role'ью с FORCE ROW LEVEL SECURITY активным (production-like setup).
//
// Без правильной wire-up'ы withTenant вокруг repo-вызовов:
//   - claimPending UPDATE'нул бы 0 rows (RLS policy фильтрует pending
//     по tenant_id, app.tenant_id не set → 0 видимых)
//   - markSent / markFailed просто не сработали бы
//   - dispatcher молча drain'ил бы pending очередь без эффекта
//
// Этот тест — оракул для wiring'а: если кто-то когда-то откатит
// withTenant обратно в dispatcher.ts, тест упадёт сразу.

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
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { WorkerChannelRegistry, type WorkerChannelEntry } from "./channel-registry.ts";
import { OutboundDispatcher } from "./dispatcher.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_disp_rls_${Math.random().toString(36).slice(2, 10)}`;
const appRoleName = `app_disp_rls_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-disp-rls";
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");

let ownerSql: Sql | null = null;
let appSql: Sql | null = null;
let appDb: PostgresJsDatabase<typeof schema>;
let tenantId = 0;
let channelDbId = 0;

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
  constructor(id: string) {
    this.id = id;
  }
  receive(): AsyncIterable<Inbound> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined as unknown as Inbound, done: true }),
      }),
    };
  }
  async send(envelope: OutboundEnvelope): Promise<Sent> {
    this.sendCalls.push(envelope);
    return {
      channelId: this.id,
      externalMessageId: `fake-${this.sendCalls.length}`,
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
    // biome-ignore lint/suspicious/noExplicitAny: tunneling в private
    (this as any).byDbId.set(entry.channelDbId, entry);
  }
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });

  ownerSql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(ownerSql, migrationsDir);
  // НЕ делаем `ALTER NO FORCE RLS` — оставляем policy активной как в prod.

  await ownerSql.unsafe(`
      CREATE ROLE "${appRoleName}" LOGIN PASSWORD '${appRolePass}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO "${appRoleName}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRoleName}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRoleName}";
    `);

  // Seed под owner (он bypass'ит). app-role будет коннектиться отдельно.
  const ownerDb = drizzle(ownerSql, { schema });
  const [t] = await ownerDb
    .insert(tenants)
    .values({ slug: "rls-disp", plan: "free", status: "active", llmBillingMode: "byok" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenantId = t.id;
  const [ch] = await ownerDb
    .insert(channels)
    .values({
      tenantId,
      kind: "telegram_bot",
      externalId: "rls-disp-bot",
      status: "active",
    })
    .returning();
  if (!ch) throw new Error("seed channel");
  channelDbId = ch.id;

  // Подсадим pending row через owner (что-то для dispatcher'а).
  const now = Math.floor(Date.now() / 1000);
  await ownerDb.insert(outboundQueue).values({
    tenantId,
    channelId: channelDbId,
    payloadJson: JSON.stringify({
      channelId: String(channelDbId),
      externalUserId: "user-rls",
      parts: [{ kind: "text", text: "hello under RLS" }],
    }),
    scheduledAt: now,
    status: "pending",
    createdAt: now,
  });

  // App-роль для самого dispatcher'а — она BYPASSRLS не имеет.
  const parsed = new URL(testUrl);
  parsed.username = appRoleName;
  parsed.password = appRolePass;
  appSql = postgres(parsed.toString(), { max: 4, onnotice: () => {} });
  appDb = drizzle(appSql, { schema });
}, 30_000);

afterAll(async () => {
  if (appSql) {
    await appSql.end({ timeout: 0 }).catch(() => {});
    appSql = null;
  }
  if (ownerSql) {
    await ownerSql
      .unsafe(`DROP OWNED BY "${appRoleName}"; DROP ROLE IF EXISTS "${appRoleName}"`)
      .catch(() => {});
    await ownerSql.end({ timeout: 0 }).catch(() => {});
    ownerSql = null;
  }
}, 10_000);

describe("OutboundDispatcher under FORCE RLS / non-BYPASSRLS role", () => {
  it("end-to-end: claim → adapter.send → markSent ВСЁ через app.tenant_id SET LOCAL", async () => {
    if (!appSql || !ownerSql) return;

    // Sanity-проверки. (a) app role реально без bypass'а.
    const roleInfo = await appSql<Array<{ sup: boolean; bypass: boolean }>>`
      SELECT rolsuper as sup, rolbypassrls as bypass FROM pg_roles WHERE rolname = current_user
    `;
    expect(roleInfo[0]?.sup).toBe(false);
    expect(roleInfo[0]?.bypass).toBe(false);

    // (b) raw SELECT без SET LOCAL не видит pending row — это и есть та
    // самая RLS-защита что мы тестируем как live в проде.
    const blindCount = await appSql<Array<{ c: string }>>`
      SELECT COUNT(*)::text as c FROM outbound_queue
    `;
    expect(blindCount[0]?.c).toBe("0");

    // (c) Прогон dispatcher'а. Если бы withTenant отсутствовал — claim
    // вернул бы [], adapter.send никогда не вызвался, ниже expectations
    // упали бы.
    const adapter = new FakeAdapter(String(channelDbId));
    const registry = new TestRegistry();
    registry.setEntry({
      channelDbId,
      tenantId,
      tenantSlug: "rls-disp",
      kind: "telegram_bot",
      adapter,
    });
    const metrics = makePlatformMetrics();
    const dispatcher = new OutboundDispatcher(appDb, registry, {
      pollMs: 50,
      batchSize: 16,
      metrics,
    });

    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.sendCalls[0]?.parts).toEqual([{ kind: "text", text: "hello under RLS" }]);

    // (d) Состояние row проверяем под owner (он bypass'ит, видит ВСЁ).
    const ownerDb = drizzle(ownerSql, { schema });
    const rows = await ownerDb
      .select()
      .from(outboundQueue)
      .where(eq(outboundQueue.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.externalMessageId).toBe("fake-1");

    // (e) Metrics эмитнулись — proof что код прошёл happy-path.
    expect(metrics.registry.format()).toContain(
      `lead_engine_outbound_sent_total{kind="telegram_bot",tenant="${tenantId}"} 1`,
    );
  });
});
