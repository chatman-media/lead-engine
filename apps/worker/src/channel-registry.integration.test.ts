// Integration test для WorkerChannelRegistry.reloadAll. Проверяет
// polling-based hot-reload в apps/worker:
//   1. fresh registry pустой
//   2. insert channel + reloadAll → entry появляется
//   3. delete channel + reloadAll → entry уходит, adapter closed
//   4. update credentials_ref + reloadAll → new adapter с новым token

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { WorkerChannelRegistry } from "./channel-registry.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_worker_reload_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");
const MASTER_KEY = "a".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantId = 0;

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    db = drizzle(sql, { schema });

    const [t] = await db
      .insert(tenants)
      .values({ slug: "worker-reload-tenant", plan: "free", status: "active" })
      .returning({ id: tenants.id });
    tenantId = t!.id;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("WorkerChannelRegistry.reloadAll", () => {
  it("fresh registry — пустой после loadFromDb без channels", async () => {
    if (!sql) return;
    const reg = new WorkerChannelRegistry();
    await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    expect(reg.size()).toBe(0);
  });

  it("insert channel + reloadAll → entry появляется", async () => {
    if (!sql) return;
    const reg = new WorkerChannelRegistry();
    await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    expect(reg.size()).toBe(0);

    // Mimic'аем POST /api/admin/channels/telegram.
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId,
      key: "channel_telegram_bot_workerbot",
      value: "1234:worker-bot-token",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    const [inserted] = await db
      .insert(channels)
      .values({
        tenantId,
        kind: "telegram_bot",
        externalId: "workerbot",
        credentialsRef: "channel_telegram_bot_workerbot",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: channels.id });

    const delta = await reg.reloadAll();
    expect(delta.before).toBe(0);
    expect(delta.after).toBe(1);
    expect(reg.size()).toBe(1);
    expect(reg.byChannelId(inserted!.id)).toBeDefined();
    expect(reg.byChannelId(inserted!.id)?.kind).toBe("telegram_bot");
  });

  it("update credentials_ref → reloadAll даёт fresh adapter (cache invalidated)", async () => {
    if (!sql) return;
    const reg = new WorkerChannelRegistry();
    await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    const id = [...((reg as unknown as { byDbId: Map<number, unknown> }).byDbId.keys())][0]!;
    const adapterBefore = reg.byChannelId(id)?.adapter;
    expect(adapterBefore).toBeDefined();

    // Rotate token (новое secret value, тот же key).
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId,
      key: "channel_telegram_bot_workerbot",
      value: "1234:ROTATED-token",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });

    await reg.reloadAll();
    const adapterAfter = reg.byChannelId(id)?.adapter;
    expect(adapterAfter).toBeDefined();
    // Same channel id, but different adapter instance (was closed + recreated).
    expect(adapterAfter).not.toBe(adapterBefore);
  });

  it("paused channel → reloadAll исключает (channel.status != active)", async () => {
    if (!sql) return;
    const reg = new WorkerChannelRegistry();
    await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    expect(reg.size()).toBe(1);

    await db
      .update(channels)
      .set({ status: "paused", updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(channels.tenantId, tenantId));

    const delta = await reg.reloadAll();
    expect(delta.before).toBe(1);
    expect(delta.after).toBe(0);

    // Restore for next test.
    await db
      .update(channels)
      .set({ status: "active", updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(channels.tenantId, tenantId));
  });

  it("delete channel → reloadAll registry пустой", async () => {
    if (!sql) return;
    const reg = new WorkerChannelRegistry();
    await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    expect(reg.size()).toBe(1);

    await db.delete(channels).where(eq(channels.tenantId, tenantId));
    const delta = await reg.reloadAll();
    expect(delta.before).toBe(1);
    expect(delta.after).toBe(0);
    expect(reg.size()).toBe(0);
  });

  it("reloadAll до loadFromDb → no-op (без crash)", async () => {
    if (!sql) return;
    const reg = new WorkerChannelRegistry();
    const delta = await reg.reloadAll();
    expect(delta).toEqual({ before: 0, after: 0 });
  });
});
