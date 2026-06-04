// Integration test для admin-llm-configs CRUD endpoints. Isolated PG →
// миграции → signup admin → GET/PUT/DELETE configs. Проверяем что
// secret_ref проставляется при apiKey, что tenant_secrets row создаётся
// encrypted, что между tenants нет утечки.

import {
  applyAllMigrations,
  createIsolatedDb,
  llmProviderConfigs,
  schema,
  tenantSecrets,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminLlmConfigsRoutes } from "./admin-llm-configs.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_llmcfg_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-llm-cfg-flow-12345";
// AES-256 нужен 32-byte (64 hex chars) master key.
const MASTER_KEY_HEX = "a".repeat(64);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tenantIdA = 0;
let tokenB = "";
let tenantIdB = 0;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminLlmConfigsRoutes({ db, masterKeyHex: MASTER_KEY_HEX }));

  // Tenant A
  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "llm-a@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  tokenA = sba.token;
  tenantIdA = sba.admin.tenantId;

  // Tenant B (cross-tenant isolation test)
  const sb = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "llm-b@demo.io", password: "strong-pwd-12345" }),
  });
  const sbb = (await sb.json()) as { token: string; admin: { tenantId: number } };
  tokenB = sbb.token;
  tenantIdB = sbb.admin.tenantId;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function authReq(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin-llm-configs CRUD", () => {
  it("GET /api/admin/llm-configs без auth → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/llm-configs");
    expect(res.status).toBe(401);
  });

  it("GET с auth, нет configs → empty list", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("PUT chat config + apiKey → создаёт config + encrypted secret", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-test-secret-key-xyz",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; updated: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(false); // newly inserted
    expect(body.id).toBeGreaterThan(0);

    // Verify config in DB
    const [cfg] = await db
      .select()
      .from(llmProviderConfigs)
      .where(
        and(eq(llmProviderConfigs.tenantId, tenantIdA), eq(llmProviderConfigs.purpose, "chat")),
      );
    expect(cfg).toBeDefined();
    expect(cfg!.provider).toBe("openai");
    expect(cfg!.model).toBe("gpt-4o-mini");
    expect(cfg!.secretRef).toBe("llm_chat_apikey");

    // Verify secret encrypted in tenant_secrets
    const [secret] = await db
      .select()
      .from(tenantSecrets)
      .where(and(eq(tenantSecrets.tenantId, tenantIdA), eq(tenantSecrets.key, "llm_chat_apikey")));
    expect(secret).toBeDefined();
    expect(secret!.encryptedValue).not.toBe("sk-test-secret-key-xyz"); // encrypted
    expect(secret!.encryptedValue.length).toBeGreaterThan(20); // non-trivial ciphertext
  });

  it("GET после insert → list содержит config с hasSecret=true (без secret_ref value)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        purpose: string;
        provider: string;
        model: string;
        hasSecret: boolean;
      }>;
    };
    const chat = body.items.find((i) => i.purpose === "chat");
    expect(chat).toBeDefined();
    expect(chat!.provider).toBe("openai");
    expect(chat!.model).toBe("gpt-4o-mini");
    expect(chat!.hasSecret).toBe(true);
    // Critically: response не содержит raw secret_ref value
    expect(JSON.stringify(body)).not.toContain("sk-test-secret-key-xyz");
  });

  it("PUT update без apiKey → secret_ref сохраняется, model меняется", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: boolean };
    expect(body.updated).toBe(true);

    const [cfg] = await db
      .select()
      .from(llmProviderConfigs)
      .where(
        and(eq(llmProviderConfigs.tenantId, tenantIdA), eq(llmProviderConfigs.purpose, "chat")),
      );
    expect(cfg!.model).toBe("gpt-4o");
    expect(cfg!.secretRef).toBe("llm_chat_apikey"); // preserved
  });

  it("PUT embed без embedDim → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/embed", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-emb-test",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT embed с embedDim → 200", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/embed", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-emb-test",
        embedDim: 1536,
      }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT ollama без apiKey → 200 (local provider, key optional)", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/vision", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "ollama",
        model: "llava",
        baseUrl: "http://localhost:11434",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("PUT anthropic без apiKey (нет ключа этого провайдера) → 500", async () => {
    if (!sql) return;
    // У tokenA нет ни одного anthropic-конфига с ключом → переиспользовать нечего.
    const res = await authReq(tokenA, "/api/admin/llm-configs/judge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
      }),
    });
    expect(res.status).toBe(500);
  });

  it("PUT judge openai без apiKey → переиспользует ключ chat-openai (200, hasSecret)", async () => {
    if (!sql) return;
    // chat уже сконфигурен с openai+ключ ранее в этом suite → ключ переиспользуется.
    const res = await authReq(tokenA, "/api/admin/llm-configs/judge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o-mini" }),
    });
    expect(res.status).toBe(200);
    const list = (await (await authReq(tokenA, "/api/admin/llm-configs")).json()) as {
      items: Array<{ purpose: string; provider: string; hasSecret: boolean }>;
    };
    const judge = list.items.find((i) => i.purpose === "judge");
    expect(judge?.provider).toBe("openai");
    expect(judge?.hasSecret).toBe(true);
  });

  it("PUT invalid purpose → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/totally-invalid", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o-mini", apiKey: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT invalid provider → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "fakeprovider",
        model: "x",
        apiKey: "y",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT without model → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT invalid json → 400", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("DELETE → row удаляется, secret НЕ удаляется", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const cfgRows = await db
      .select()
      .from(llmProviderConfigs)
      .where(
        and(eq(llmProviderConfigs.tenantId, tenantIdA), eq(llmProviderConfigs.purpose, "chat")),
      );
    expect(cfgRows).toHaveLength(0);

    // tenant_secrets row сохраняется (manual cleanup для безопасности)
    const [secret] = await db
      .select()
      .from(tenantSecrets)
      .where(and(eq(tenantSecrets.tenantId, tenantIdA), eq(tenantSecrets.key, "llm_chat_apikey")));
    expect(secret).toBeDefined();
  });

  it("DELETE несуществующий → 404", async () => {
    if (!sql) return;
    const res = await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("cross-tenant isolation: B не видит configs A", async () => {
    if (!sql) return;
    // Tenant A insert config
    await authReq(tokenA, "/api/admin/llm-configs/chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "tenant-a-model",
        apiKey: "sk-tenant-a-xxx",
      }),
    });
    // Tenant B sees only its own configs
    const res = await authReq(tokenB, "/api/admin/llm-configs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ model: string }>;
    };
    expect(body.items.find((i) => i.model === "tenant-a-model")).toBeUndefined();
    expect(tenantIdA).not.toBe(tenantIdB);
  });

  it("tampered token → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/llm-configs", {
      headers: { Authorization: "Bearer not-a-valid-token" },
    });
    expect(res.status).toBe(401);
  });
});
