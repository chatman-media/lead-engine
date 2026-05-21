// Integration test для loadTenantLlmConfigs. Isolated PG → миграции →
// создаём 2 tenants → один с DB-config, один без → проверяем что:
//   1. tenant с DB config'ом получает его с decrypted apiKey
//   2. tenant без DB config'а получает env fallback (если env задан)
//   3. anyTenantHas* flags корректны
//   4. corrupted secret_ref (wrong master key) → onError + drop config
//   5. legacy embed env config с dim прилетает в loaded

import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  createIsolatedDb,
  llmProviderConfigs,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import type { ApiConfig } from "../config.ts";
import { loadTenantLlmConfigs } from "./llm-config-loader.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_llmload_${Math.random().toString(36).slice(2, 10)}`;
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
const WRONG_MASTER_KEY = "b".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let tenantA = 0; // has DB chat config
let tenantB = 0; // no DB config → env fallback

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

    // Create two tenants.
    const [a] = await db
      .insert(tenants)
      .values({ slug: "tenant-a-load", plan: "free", status: "active" })
      .returning({ id: tenants.id });
    tenantA = a!.id;
    const [b] = await db
      .insert(tenants)
      .values({ slug: "tenant-b-load", plan: "free", status: "active" })
      .returning({ id: tenants.id });
    tenantB = b!.id;

    const now = Math.floor(Date.now() / 1000);

    // Tenant A: DB chat config + encrypted secret.
    await setEncryptedSecret({
      db,
      tenantId: tenantA,
      key: "llm_chat_apikey",
      value: "sk-tenant-a-chat-key",
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

    // Tenant A: DB embed config + encrypted secret.
    await setEncryptedSecret({
      db,
      tenantId: tenantA,
      key: "llm_embed_apikey",
      value: "sk-tenant-a-embed-key",
      masterKeyHex: MASTER_KEY,
      nowEpoch: now,
    });
    await db.insert(llmProviderConfigs).values({
      tenantId: tenantA,
      purpose: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      secretRef: "llm_embed_apikey",
      embedDim: 1536,
      createdAt: now,
      updatedAt: now,
    });
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

function makeEnvCfg(overrides: Partial<ApiConfig> = {}): ApiConfig {
  // Minimal subset — loader use'ит только llm + embed.
  return {
    llm: {
      provider: "openai",
      model: "gpt-env-fallback",
      apiKey: "sk-env-fallback-key",
      baseUrl: "",
    },
    embed: {
      provider: "openai",
      model: "embed-env-fallback",
      apiKey: "sk-env-embed-key",
      baseUrl: "",
      dim: 1536,
    },
    ...overrides,
  } as ApiConfig;
}

describe("loadTenantLlmConfigs", () => {
  it("tenant с DB chat config → returns decrypted apiKey, source=db", async () => {
    if (!sql) return;
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA, tenantB],
      envFallback: makeEnvCfg(),
      masterKeyHex: MASTER_KEY,
    });
    const cfg = loaded.byTenant.get(tenantA)?.get("chat");
    expect(cfg).toBeDefined();
    expect(cfg!.source).toBe("db");
    expect(cfg!.provider).toBe("openai");
    expect(cfg!.model).toBe("gpt-4o-mini");
    expect(cfg!.apiKey).toBe("sk-tenant-a-chat-key");
  });

  it("tenant без DB config → env fallback с source=env", async () => {
    if (!sql) return;
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA, tenantB],
      envFallback: makeEnvCfg(),
      masterKeyHex: MASTER_KEY,
    });
    const cfg = loaded.byTenant.get(tenantB)?.get("chat");
    expect(cfg).toBeDefined();
    expect(cfg!.source).toBe("env");
    expect(cfg!.model).toBe("gpt-env-fallback");
    expect(cfg!.apiKey).toBe("sk-env-fallback-key");
  });

  it("anyTenantHasChat=true когда хоть один tenant имеет chat config", async () => {
    if (!sql) return;
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA, tenantB],
      envFallback: makeEnvCfg(),
      masterKeyHex: MASTER_KEY,
    });
    expect(loaded.anyTenantHasChat).toBe(true);
    expect(loaded.anyTenantHasEmbed).toBe(true);
  });

  it("env пуст + DB пуст → anyTenantHas* false, byTenant пуст", async () => {
    if (!sql) return;
    // Tenant с completely no config (B без DB, env пуст).
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantB],
      envFallback: makeEnvCfg({
        llm: { provider: "", model: "", apiKey: "", baseUrl: "" },
        embed: { provider: "", model: "", apiKey: "", baseUrl: "", dim: 0 },
      } as Partial<ApiConfig>),
      masterKeyHex: MASTER_KEY,
    });
    expect(loaded.anyTenantHasChat).toBe(false);
    expect(loaded.anyTenantHasEmbed).toBe(false);
    expect(loaded.byTenant.size).toBe(0);
  });

  it("embed config с embedDim прилетает", async () => {
    if (!sql) return;
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: makeEnvCfg(),
      masterKeyHex: MASTER_KEY,
    });
    const embed = loaded.byTenant.get(tenantA)?.get("embed");
    expect(embed?.embedDim).toBe(1536);
    expect(embed?.apiKey).toBe("sk-tenant-a-embed-key");
    expect(embed?.source).toBe("db");
  });

  it("wrong master key → onError + drop DB config + fallback на env", async () => {
    if (!sql) return;
    const errors: { msg: string; ctx: Record<string, unknown> }[] = [];
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantA],
      envFallback: makeEnvCfg(),
      masterKeyHex: WRONG_MASTER_KEY,
      onError: (msg, ctx) => errors.push({ msg, ctx }),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.msg).toContain("decrypt");
    // tenantA должен получить env fallback (DB конфиг dropped из-за decrypt failure)
    const chat = loaded.byTenant.get(tenantA)?.get("chat");
    expect(chat?.source).toBe("env");
  });

  it("Ollama config без secret_ref → ok (apiKey не нужен)", async () => {
    if (!sql) return;
    const now = Math.floor(Date.now() / 1000);
    // Create tenant C with Ollama chat config (no secret_ref).
    const [c] = await db
      .insert(tenants)
      .values({ slug: "tenant-c-ollama", plan: "free", status: "active" })
      .returning({ id: tenants.id });
    const tenantC = c!.id;
    await db.insert(llmProviderConfigs).values({
      tenantId: tenantC,
      purpose: "chat",
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434",
      createdAt: now,
      updatedAt: now,
    });
    const loaded = await loadTenantLlmConfigs({
      db,
      tenantIds: [tenantC],
      envFallback: makeEnvCfg(),
      masterKeyHex: MASTER_KEY,
    });
    const cfg = loaded.byTenant.get(tenantC)?.get("chat");
    expect(cfg?.provider).toBe("ollama");
    expect(cfg?.apiKey).toBeUndefined();
    expect(cfg?.baseUrl).toBe("http://localhost:11434");
    expect(cfg?.source).toBe("db");
  });
});
