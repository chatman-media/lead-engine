// Integration test for admin-referral-codes CRUD. Isolated DB + real auth.
// Coverage epic #187 — apps/api untested routes.

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
import { makeAdminReferralRoutes } from "./admin-referral.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_ref_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-referral-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

const BASE = "/api/admin/referral-codes";

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

    app = new Hono();
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
    app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    app.route("/", makeAdminReferralRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ref@demo.io", password: "strong-pwd-12345" }),
    });
    token = ((await sa.json()) as { token: string }).token;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function req(method: string, path: string, body?: unknown, withAuth = true): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("admin-referral-codes CRUD", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    expect((await req("GET", BASE, undefined, false)).status).toBe(401);
  });

  it("GET пустой → []", async () => {
    if (!sql) return;
    expect(((await (await req("GET", BASE)).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("POST без тела → авто-код (XXXX-XXXX), 201", async () => {
    if (!sql) return;
    const res = await req("POST", BASE);
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { code: string; usesCount: number } };
    expect(item.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(item.usesCount).toBe(0);
  });

  it("POST кастомный код → 201; дубль → 409; кривой формат → 400", async () => {
    if (!sql) return;
    expect((await req("POST", BASE, { code: "PROMO-CODE" })).status).toBe(201);
    expect((await req("POST", BASE, { code: "promo-code" })).status).toBe(409); // upcase → дубль
    expect((await req("POST", BASE, { code: "A_B" })).status).toBe(400); // _ запрещён
  });

  it("GET возвращает созданные коды", async () => {
    if (!sql) return;
    const items = ((await (await req("GET", BASE)).json()) as { items: Array<{ code: string }> }).items;
    expect(items.length).toBe(2); // авто + PROMO-CODE
    expect(items.some((i) => i.code === "PROMO-CODE")).toBe(true);
  });

  it("DELETE: bad id → 400; валидный → ok + исчезает из GET", async () => {
    if (!sql) return;
    expect((await req("DELETE", `${BASE}/abc`)).status).toBe(400);
    const items = ((await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> }).items;
    for (const it of items) expect((await req("DELETE", `${BASE}/${it.id}`)).status).toBe(200);
    expect(((await (await req("GET", BASE)).json()) as { items: unknown[] }).items).toEqual([]);
  });
});
