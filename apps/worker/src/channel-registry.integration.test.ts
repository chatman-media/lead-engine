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

// ── Kinds + credential resolution (whatsapp/facebook/vk/max, env fallback,
//    decrypt-ошибки, userbot/web skip) — отдельный tenant, чтобы не зависеть
//    от состояния тестов выше. ────────────────────────────────────────────────

describe("WorkerChannelRegistry.loadFromDb — kinds + credential resolution", () => {
  const KINDS_SLUG = "worker-kinds-tenant"; // env-suffix → WORKER_KINDS_TENANT
  let kindsTenantId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const [t] = await db
      .insert(tenants)
      .values({ slug: KINDS_SLUG, plan: "free", status: "active" })
      .returning({ id: tenants.id });
    kindsTenantId = t!.id;
  });

  /** Чистим каналы kinds-тенанта между тестами — каждый сидит свои. */
  async function resetKindsChannels(): Promise<void> {
    await db.delete(channels).where(eq(channels.tenantId, kindsTenantId));
  }

  async function insertChannel(
    kind: string,
    over: Partial<typeof channels.$inferInsert> = {},
  ): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const [row] = await db
      .insert(channels)
      .values({
        tenantId: kindsTenantId,
        kind,
        externalId: `${kind}-ext`,
        status: "active",
        createdAt: now,
        updatedAt: now,
        ...over,
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  it("whatsapp/facebook/vk/max загружаются из tenant_secrets (decrypt-путь)", async () => {
    if (!sql) return;
    await resetKindsChannels();
    const now = Math.floor(Date.now() / 1000);
    const metaKinds = [
      { kind: "whatsapp" as const, ref: "channel_whatsapp_main" },
      { kind: "facebook" as const, ref: "channel_facebook_main" },
      { kind: "vk" as const, ref: "channel_vk_main" },
      { kind: "max" as const, ref: "channel_max_main" },
    ];
    const ids = new Map<string, number>();
    for (const { kind, ref } of metaKinds) {
      await setEncryptedSecret({
        db,
        tenantId: kindsTenantId,
        key: ref,
        value: `${kind}-secret-token`,
        masterKeyHex: MASTER_KEY,
        nowEpoch: now,
      });
      ids.set(kind, await insertChannel(kind, { credentialsRef: ref }));
    }

    const reg = new WorkerChannelRegistry();
    await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    for (const { kind } of metaKinds) {
      const entry = reg.byChannelId(ids.get(kind)!);
      expect(entry?.kind).toBe(kind);
      expect(entry?.tenantSlug).toBe(KINDS_SLUG);
      expect(entry?.adapter).toBeDefined();
    }
    reg.closeAll();
  });

  it("decrypt-ошибка (чужой master key) → onWarn, канал пропущен без env fallback", async () => {
    if (!sql) return;
    await resetKindsChannels();
    const now = Math.floor(Date.now() / 1000);
    const wrongKey = "b".repeat(64);
    await setEncryptedSecret({
      db,
      tenantId: kindsTenantId,
      key: "bad_bot_ref",
      value: "tg-token",
      masterKeyHex: wrongKey,
      nowEpoch: now,
    });
    await setEncryptedSecret({
      db,
      tenantId: kindsTenantId,
      key: "bad_wa_ref",
      value: "wa-token",
      masterKeyHex: wrongKey,
      nowEpoch: now,
    });
    const tgId = await insertChannel("telegram_bot", { credentialsRef: "bad_bot_ref" });
    const waId = await insertChannel("whatsapp", { credentialsRef: "bad_wa_ref" });

    const savedEnv = {
      BOT_TOKEN: process.env.BOT_TOKEN,
      WA_ACCESS_TOKEN: process.env.WA_ACCESS_TOKEN,
    };
    delete process.env.BOT_TOKEN;
    delete process.env.WA_ACCESS_TOKEN;
    const warns: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    try {
      const reg = new WorkerChannelRegistry();
      await reg.loadFromDb(db, {
        masterKeyHex: MASTER_KEY,
        onWarn: (msg, ctx) => warns.push({ msg, ctx }),
      });
      expect(reg.byChannelId(tgId)).toBeUndefined();
      expect(reg.byChannelId(waId)).toBeUndefined();
    } finally {
      if (savedEnv.BOT_TOKEN !== undefined) process.env.BOT_TOKEN = savedEnv.BOT_TOKEN;
      if (savedEnv.WA_ACCESS_TOKEN !== undefined)
        process.env.WA_ACCESS_TOKEN = savedEnv.WA_ACCESS_TOKEN;
    }
    const botWarn = warns.find((w) => w.msg.includes("bot token"));
    expect(botWarn?.ctx.credentialsRef).toBe("bad_bot_ref");
    const credWarn = warns.find((w) => w.msg.includes("channel credential"));
    expect(credWarn?.ctx.envPrefix).toBe("WA_ACCESS_TOKEN");
  });

  it("env fallback: BOT_TOKEN_<SLUG> и WA_ACCESS_TOKEN_<SLUG> без credentials_ref", async () => {
    if (!sql) return;
    await resetKindsChannels();
    const tgId = await insertChannel("telegram_bot");
    const waId = await insertChannel("whatsapp");

    process.env.BOT_TOKEN_WORKER_KINDS_TENANT = "env-bot-token";
    process.env.WA_ACCESS_TOKEN_WORKER_KINDS_TENANT = "env-wa-token";
    try {
      const reg = new WorkerChannelRegistry();
      await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
      expect(reg.byChannelId(tgId)?.kind).toBe("telegram_bot");
      expect(reg.byChannelId(waId)?.kind).toBe("whatsapp");
      reg.closeAll();
    } finally {
      delete process.env.BOT_TOKEN_WORKER_KINDS_TENANT;
      delete process.env.WA_ACCESS_TOKEN_WORKER_KINDS_TENANT;
    }
  });

  it("userbot/web пропускаются; kinds без креденшелов → continue", async () => {
    if (!sql) return;
    await resetKindsChannels();
    // userbot/web — pinned-соединение живёт в apps/api, worker их не грузит.
    await insertChannel("telegram_userbot", { credentialsRef: "whatever" });
    await insertChannel("web");
    // Meta-kinds без credentials_ref и без env — каждый идёт в свой `continue`.
    await insertChannel("whatsapp");
    await insertChannel("facebook");
    await insertChannel("vk");
    await insertChannel("max");

    const savedEnv = {
      WA_ACCESS_TOKEN: process.env.WA_ACCESS_TOKEN,
      FB_PAGE_TOKEN: process.env.FB_PAGE_TOKEN,
      VK_ACCESS_TOKEN: process.env.VK_ACCESS_TOKEN,
      MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN,
    };
    for (const k of Object.keys(savedEnv)) delete process.env[k];
    try {
      const reg = new WorkerChannelRegistry();
      await reg.loadFromDb(db, { masterKeyHex: MASTER_KEY });
      expect(reg.size()).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });
});
