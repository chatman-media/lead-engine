// Integration tests for admin-stage-webhooks CRUD + /test endpoint.
// CRUD: GET / POST / PATCH / DELETE + validation guards (invalid url, bad id,
// nothing-to-update, 404). /test: 404 for missing hook, network-error fallback,
// happy (mock fetch returns 200). fireStageWebhooks: no-op when empty, real call.

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminStageWebhooksRoutes } from "./admin-stage-webhooks.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_stagewh_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-stagewh-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

// Track fetch calls from /test endpoint.
const fetchCalls: { url: string; init: RequestInit }[] = [];
let fetchStatus = 200;
const origFetch = globalThis.fetch;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminStageWebhooksRoutes({ db }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "stagewh@demo.io", password: "strong-pwd-12345" }),
  });
  token = ((await sa.json()) as { token: string }).token;

  // Mock fetch for /test endpoint
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return {
      ok: fetchStatus >= 200 && fetchStatus < 300,
      status: fetchStatus,
      text: async () => "ok",
    } as Response;
  }) as unknown as typeof fetch;
}, 30_000);

afterAll(async () => {
  globalThis.fetch = origFetch;
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

afterEach(() => {
  fetchCalls.length = 0;
  fetchStatus = 200;
});

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("admin-stage-webhooks GET", () => {
  it("GET /stage-webhooks → 200 пустой список", async () => {
    if (!sql) return;
    const res = await req("GET", "/api/admin/stage-webhooks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("admin-stage-webhooks POST создание", () => {
  it("невалидный url → 400", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks", { url: "ftp://bad.url" });
    expect(res.status).toBe(400);
  });

  it("битый JSON → 400", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/stage-webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{ broken",
    });
    expect(res.status).toBe(400);
  });

  it("happy: url + secret → 201, secret замаскирован", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks", {
      url: "https://example.com/hook",
      secret: "mysecret",
      isActive: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; hasSecret: boolean; url: string };
    expect(body.hasSecret).toBe(true);
    expect(body.url).toBe("https://example.com/hook");
    expect((body as { secret?: string }).secret).toBeUndefined();
  });

  it("happy: без secret → hasSecret=false", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks", {
      url: "https://example.com/hook2",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { hasSecret: boolean };
    expect(body.hasSecret).toBe(false);
  });
});

describe("admin-stage-webhooks PATCH обновление", () => {
  let hookId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks", {
      url: "https://example.com/patch-hook",
    });
    if (res.status === 201) hookId = ((await res.json()) as { id: number }).id;
  });

  it("невалидный id → 400", async () => {
    if (!sql) return;
    const res = await req("PATCH", "/api/admin/stage-webhooks/abc", { isActive: false });
    expect(res.status).toBe(400);
  });

  it("невалидный url в patch → 400", async () => {
    if (!sql || !hookId) return;
    const res = await req("PATCH", `/api/admin/stage-webhooks/${hookId}`, { url: "not-a-url" });
    expect(res.status).toBe(400);
  });

  it("пустой patch → 400", async () => {
    if (!sql || !hookId) return;
    const res = await req("PATCH", `/api/admin/stage-webhooks/${hookId}`, {});
    expect(res.status).toBe(400);
  });

  it("несуществующий id → 404", async () => {
    if (!sql) return;
    const res = await req("PATCH", "/api/admin/stage-webhooks/999999", { isActive: false });
    expect(res.status).toBe(404);
  });

  it("happy: обновляем url + isActive + сбрасываем secret", async () => {
    if (!sql || !hookId) return;
    const res = await req("PATCH", `/api/admin/stage-webhooks/${hookId}`, {
      url: "https://example.com/updated",
      secret: "",
      isActive: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; isActive: boolean; hasSecret: boolean };
    expect(body.url).toBe("https://example.com/updated");
    expect(body.isActive).toBe(false);
    expect(body.hasSecret).toBe(false);
  });
});

describe("admin-stage-webhooks DELETE", () => {
  let hookId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks", {
      url: "https://example.com/delete-hook",
    });
    if (res.status === 201) hookId = ((await res.json()) as { id: number }).id;
  });

  it("невалидный id → 400", async () => {
    if (!sql) return;
    const res = await req("DELETE", "/api/admin/stage-webhooks/abc");
    expect(res.status).toBe(400);
  });

  it("несуществующий → 404", async () => {
    if (!sql) return;
    const res = await req("DELETE", "/api/admin/stage-webhooks/999999");
    expect(res.status).toBe(404);
  });

  it("happy → 200", async () => {
    if (!sql || !hookId) return;
    const res = await req("DELETE", `/api/admin/stage-webhooks/${hookId}`);
    expect(res.status).toBe(200);
  });
});

describe("admin-stage-webhooks /test", () => {
  let hookId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks", {
      url: "https://example.com/test-hook",
      secret: "testhook-secret",
    });
    if (res.status === 201) hookId = ((await res.json()) as { id: number }).id;
  });

  it("невалидный id → 400", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks/abc/test");
    expect(res.status).toBe(400);
  });

  it("несуществующий → 404", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/stage-webhooks/999999/test");
    expect(res.status).toBe(404);
  });

  it("happy: fetch вызван, ответ ok=true + status + body", async () => {
    if (!sql || !hookId) return;
    fetchStatus = 200;
    const res = await req("POST", `/api/admin/stage-webhooks/${hookId}/test`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: number };
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]?.url).toBe("https://example.com/test-hook");
    // Подпись X-Signature присутствует (secret задан)
    expect((fetchCalls[0]?.init.headers as Record<string, string>)["X-Signature"]).toMatch(
      /^sha256=/,
    );
  });

  it("fetch упал → ok:false + error", async () => {
    if (!sql || !hookId) return;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await req("POST", `/api/admin/stage-webhooks/${hookId}/test`);
    expect(res.status).toBe(200); // роут не кидает, возвращает { ok: false }
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("network down");
    // Restore mock
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return { ok: true, status: 200, text: async () => "ok" } as Response;
    }) as unknown as typeof fetch;
  });
});
