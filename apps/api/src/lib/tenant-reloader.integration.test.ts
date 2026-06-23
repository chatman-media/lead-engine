// Integration test для tenant-reloader: проверяет что после mutation
// llm_provider_configs / channels через DB + reloadLlm()/reloadChannels()
// LoadedRef + InMemoryLlmRouter содержат свежие данные без рестарта.

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import { InMemoryLlmRouter } from "@chatman-media/llm-router";
import {
  applyAllMigrations,
  channels,
  createIsolatedDb,
  llmProviderConfigs,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { ChannelRegistry } from "../channel-registry.ts";
import type { ApiConfig } from "../config.ts";
import type { LoadedRef } from "../llm-bootstrap.ts";
import { loadTenantLlmConfigs } from "./llm-config-loader.ts";
import { makeTenantReloader } from "./tenant-reloader.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_reload_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);
const MASTER_KEY = "a".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantA = 0;

const ENV_CFG = {
  llm: { provider: "", model: "", apiKey: "", baseUrl: "" },
  embed: { provider: "", model: "", apiKey: "", baseUrl: "", dim: 0 },
  masterKeyHex: MASTER_KEY,
} as unknown as ApiConfig;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  // Create one tenant.
  const [t] = await db
    .insert(tenants)
    .values({ slug: "tenant-reload-a", plan: "free", status: "active" })
    .returning({ id: tenants.id });
  tenantA = t!.id;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("tenant-reloader.reloadLlm", () => {
  it("после insert llm_provider_config + reloadLlm → router.resolveChat работает", async () => {
    if (!sql) return;
    // Initial state — нет config'ов.
    const initial = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: ENV_CFG,
      masterKeyHex: MASTER_KEY,
    });
    const ref: LoadedRef = {
      current: initial,
      router: new InMemoryLlmRouter(),
    };
    const reloader = makeTenantReloader({
      db,
      cfg: ENV_CFG,
      ref,
      registry: new ChannelRegistry(),
      log: () => {},
    });

    expect(ref.current.anyTenantHasChat).toBe(false);
    expect(() => ref.router.resolveChat(tenantA, "chat")).toThrow();

    // Direct DB insert — minic'ит PUT /api/admin/llm-configs/chat.
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId: tenantA,
      key: "llm_chat_apikey",
      value: "sk-new-rotation-key",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await db.insert(llmProviderConfigs).values({
      tenantId: tenantA,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      secretRef: "llm_chat_apikey",
      createdAt: now,
      updatedAt: now,
    });

    // Reload!
    await reloader.reloadLlm(tenantA);

    expect(ref.current.anyTenantHasChat).toBe(true);
    const chat = ref.current.byTenant.get(tenantA)?.get("chat");
    expect(chat?.apiKey).toBe("sk-new-rotation-key");
    expect(chat?.model).toBe("gpt-4o-mini");
    // Router теперь имеет config для этого tenant'а — resolveChat не throw'нет.
    const client = ref.router.resolveChat(tenantA, "chat");
    expect(client).toBeDefined();
  });

  it("после update apiKey + reloadLlm → invalidate сбросит cached client", async () => {
    if (!sql) return;
    const initial = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: ENV_CFG,
      masterKeyHex: MASTER_KEY,
    });
    const ref: LoadedRef = {
      current: initial,
      router: new InMemoryLlmRouter(),
    };
    const reloader = makeTenantReloader({
      db,
      cfg: ENV_CFG,
      ref,
      registry: new ChannelRegistry(),
      log: () => {},
    });
    // Initial state — config есть (insert'нут предыдущим тестом).
    await reloader.reloadLlm(tenantA);
    const before = ref.router.resolveChat(tenantA, "chat");

    // Rotate apiKey в БД.
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId: tenantA,
      key: "llm_chat_apikey",
      value: "sk-ROTATED-key",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await reloader.reloadLlm(tenantA);

    const after = ref.router.resolveChat(tenantA, "chat");
    // Different instance — cache was invalidated + rebuilt.
    expect(after).not.toBe(before);
    expect(ref.current.byTenant.get(tenantA)?.get("chat")?.apiKey).toBe("sk-ROTATED-key");
  });

  it("после DELETE llm_provider_config + reloadLlm → snapshot чистый", async () => {
    if (!sql) return;
    const initial = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: ENV_CFG,
      masterKeyHex: MASTER_KEY,
    });
    const ref: LoadedRef = {
      current: initial,
      router: new InMemoryLlmRouter(),
    };
    const reloader = makeTenantReloader({
      db,
      cfg: ENV_CFG,
      ref,
      registry: new ChannelRegistry(),
      log: () => {},
    });

    // Pre: config есть.
    expect(ref.current.byTenant.get(tenantA)?.has("chat")).toBe(true);

    // DELETE via DB direct.
    await db
      .delete(llmProviderConfigs)
      .where(and(eq(llmProviderConfigs.tenantId, tenantA), eq(llmProviderConfigs.purpose, "chat")));

    await reloader.reloadLlm(tenantA);
    // Snapshot теперь не имеет chat для tenantA.
    expect(ref.current.byTenant.get(tenantA)?.has("chat") ?? false).toBe(false);
    expect(ref.current.anyTenantHasChat).toBe(false);
  });
});

describe("tenant-reloader.reloadChannels", () => {
  it("после insert channel + reloadChannels → registry содержит entry", async () => {
    if (!sql) return;
    const registry = new ChannelRegistry();
    await registry.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    const initial = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: ENV_CFG,
      masterKeyHex: MASTER_KEY,
    });
    const ref: LoadedRef = {
      current: initial,
      router: new InMemoryLlmRouter(),
    };
    const reloader = makeTenantReloader({
      db,
      cfg: ENV_CFG,
      ref,
      registry,
      log: () => {},
    });

    expect(registry.getTelegramBotsByTenant("tenant-reload-a")).toHaveLength(0);

    // Insert channel.
    const now = Math.floor(Date.now() / 1000);
    await setEncryptedSecret({
      db,
      tenantId: tenantA,
      key: "channel_telegram_bot_xbot",
      value: "1234:fake-token",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await db.insert(channels).values({
      tenantId: tenantA,
      kind: "telegram_bot",
      externalId: "xbot",
      credentialsRef: "channel_telegram_bot_xbot",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await reloader.reloadChannels(tenantA);
    expect(registry.getTelegramBotsByTenant("tenant-reload-a")).toHaveLength(1);
  });

  it("после DELETE channel + reloadChannels → registry пустой для tenant'а", async () => {
    if (!sql) return;
    const registry = new ChannelRegistry();
    await registry.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    const initial = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: ENV_CFG,
      masterKeyHex: MASTER_KEY,
    });
    const ref: LoadedRef = {
      current: initial,
      router: new InMemoryLlmRouter(),
    };
    const reloader = makeTenantReloader({
      db,
      cfg: ENV_CFG,
      ref,
      registry,
      log: () => {},
    });

    expect(registry.getTelegramBotsByTenant("tenant-reload-a")).toHaveLength(1);

    await db.delete(channels).where(eq(channels.tenantId, tenantA));

    await reloader.reloadChannels(tenantA);
    expect(registry.getTelegramBotsByTenant("tenant-reload-a")).toHaveLength(0);
  });

  it("reloadChannels для несуществующего tenant'а → no-op (log warning, no throw)", async () => {
    if (!sql) return;
    const registry = new ChannelRegistry();
    await registry.loadFromDb(db, { masterKeyHex: MASTER_KEY });
    const initial = await loadTenantLlmConfigs({
      db,
      tenantIds: [],
      envFallback: ENV_CFG,
      masterKeyHex: MASTER_KEY,
    });
    const ref: LoadedRef = {
      current: initial,
      router: new InMemoryLlmRouter(),
    };
    const reloader = makeTenantReloader({
      db,
      cfg: ENV_CFG,
      ref,
      registry,
      log: () => {},
    });
    await expect(reloader.reloadChannels(999999)).resolves.toBeUndefined();
  });
});
