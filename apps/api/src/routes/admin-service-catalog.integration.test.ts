import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminServiceCatalogRoutes } from "./admin-service-catalog.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_service_catalog_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-service-catalog-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tokenA = "";
let tokenB = "";

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
  app.route("/", makeAdminServiceCatalogRoutes({ db }));

  tokenA = await signup("catalog-a@demo.io");
  tokenB = await signup("catalog-b@demo.io");
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function signup(email: string): Promise<string> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "strong-pwd-12345" }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function authReq(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

describe("admin service catalog", () => {
  it("creates, validates, updates and isolates catalog items by tenant", async () => {
    if (!sql) return;

    const emptyRes = await authReq(tokenA, "/api/admin/service-catalog");
    expect(emptyRes.status).toBe(200);
    expect(((await emptyRes.json()) as { items: unknown[] }).items).toHaveLength(0);

    const createRes = await authReq(tokenA, "/api/admin/service-catalog/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Подбор недвижимости",
        category: "Недвижимость",
        routeType: "manual",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = ((await createRes.json()) as {
      item: { id: number; slug: string; routeType: string };
    }).item;
    expect(created.slug).toBe("podbor_nedvizhimosti");
    expect(created.routeType).toBe("manual");

    const duplicateRes = await authReq(tokenA, "/api/admin/service-catalog/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Подбор недвижимости", routeType: "manual" }),
    });
    expect(duplicateRes.status).toBe(409);

    const badWebhookRes = await authReq(tokenA, `/api/admin/service-catalog/items/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeType: "webhook" }),
    });
    expect(badWebhookRes.status).toBe(400);

    const webhookRes = await authReq(tokenA, `/api/admin/service-catalog/items/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeType: "webhook", webhookUrl: "https://partner.example/hook" }),
    });
    expect(webhookRes.status).toBe(200);
    const updated = ((await webhookRes.json()) as {
      item: { routeType: string; webhookUrl: string | null };
    }).item;
    expect(updated.routeType).toBe("webhook");
    expect(updated.webhookUrl).toBe("https://partner.example/hook");

    const tenantBRes = await authReq(tokenB, "/api/admin/service-catalog");
    expect(tenantBRes.status).toBe(200);
    expect(((await tenantBRes.json()) as { items: unknown[] }).items).toHaveLength(0);
  });
});
