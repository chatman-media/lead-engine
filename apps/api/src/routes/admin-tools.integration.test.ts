// Integration test for admin-tools (booking-link config, encrypted secret).
// Isolated DB + real auth. Coverage epic #187 — apps/api untested routes.

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
import { makeAdminToolsRoutes } from "./admin-tools.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_tools_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-tools-flow-12345";
const MASTER_KEY = "0".repeat(64); // 32 bytes hex

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

const BASE = "/api/admin/tools";

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
  app.route("/", makeAdminToolsRoutes({ db, masterKeyHex: MASTER_KEY }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tools@demo.io", password: "strong-pwd-12345" }),
  });
  token = ((await sa.json()) as { token: string }).token;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function req(
  method: string,
  path: string,
  body?: unknown,
  withAuth = true,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("admin-tools booking_link", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    expect((await req("GET", BASE, undefined, false)).status).toBe(401);
  });

  it("GET /tools (пусто) → booking_link disabled", async () => {
    if (!sql) return;
    const res = await req("GET", BASE);
    expect(res.status).toBe(200);
    const { tools } = (await res.json()) as { tools: Array<{ name: string; enabled: boolean }> };
    expect(tools[0]?.name).toBe("booking_link");
    expect(tools[0]?.enabled).toBe(false);
  });

  it("GET /tools/booking (пусто) → enabled:false, url null", async () => {
    if (!sql) return;
    const b = (await (await req("GET", `${BASE}/booking`)).json()) as {
      enabled: boolean;
      url: string | null;
    };
    expect(b.enabled).toBe(false);
    expect(b.url).toBeNull();
  });

  it("POST /tools/booking валидация: no url / bad / non-http → 400", async () => {
    if (!sql) return;
    expect((await req("POST", `${BASE}/booking`, {})).status).toBe(400);
    expect((await req("POST", `${BASE}/booking`, { url: "not a url" })).status).toBe(400);
    expect((await req("POST", `${BASE}/booking`, { url: "ftp://x.io" })).status).toBe(400);
  });

  it("POST валидный url → сохраняется (roundtrip через encrypt)", async () => {
    if (!sql) return;
    const res = await req("POST", `${BASE}/booking`, { url: "https://cal.com/demo" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe("https://cal.com/demo");

    const b = (await (await req("GET", `${BASE}/booking`)).json()) as {
      enabled: boolean;
      url: string;
    };
    expect(b.enabled).toBe(true);
    expect(b.url).toBe("https://cal.com/demo");

    const { tools } = (await (await req("GET", BASE)).json()) as {
      tools: Array<{ enabled: boolean }>;
    };
    expect(tools[0]?.enabled).toBe(true);
  });

  it("DELETE отключает tool", async () => {
    if (!sql) return;
    expect((await req("DELETE", `${BASE}/booking`)).status).toBe(200);
    const b = (await (await req("GET", `${BASE}/booking`)).json()) as { enabled: boolean };
    expect(b.enabled).toBe(false);
  });
});
