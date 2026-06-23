// Integration test for admin-vacancies CRUD. Isolated DB + real auth.
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
import { makeAdminVacanciesRoutes } from "./admin-vacancies.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_vac_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-vacancies-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

const BASE = "/api/admin/vacancies";

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
  app.route("/", makeAdminVacanciesRoutes({ db }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "vac@demo.io", password: "strong-pwd-12345" }),
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

describe("admin-vacancies CRUD", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    expect((await req("GET", BASE, undefined, false)).status).toBe(401);
  });

  it("GET пустой список → []", async () => {
    if (!sql) return;
    const res = await req("GET", BASE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("POST без title → 400, без body → 400", async () => {
    if (!sql) return;
    expect((await req("POST", BASE, { body: "текст" })).status).toBe(400);
    expect((await req("POST", BASE, { title: "Курьер" })).status).toBe(400);
  });

  it("POST создаёт вакансию → 201, видна в GET", async () => {
    if (!sql) return;
    const res = await req("POST", BASE, {
      title: "Курьер THB",
      body: "Доставка наличных",
      url: "https://x.io",
    });
    expect(res.status).toBe(201);
    const v = (await res.json()) as {
      id: number;
      title: string;
      url: string | null;
      isActive: boolean;
    };
    expect(v.title).toBe("Курьер THB");
    expect(v.url).toBe("https://x.io");
    expect(v.isActive).toBe(true);

    const list = (await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> };
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.id).toBe(v.id);
  });

  it("PATCH обновляет; bad id → 400; not found → 404", async () => {
    if (!sql) return;
    const id = ((await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> })
      .items[0]!.id;
    expect(
      (await req("PATCH", `${BASE}/${id}`, { title: "Курьер 2", isActive: false, url: "" })).status,
    ).toBe(200);
    expect((await req("PATCH", `${BASE}/abc`, { title: "x" })).status).toBe(400);
    expect((await req("PATCH", `${BASE}/999999`, { title: "x" })).status).toBe(404);

    const item = (
      (await (await req("GET", BASE)).json()) as {
        items: Array<{ title: string; isActive: boolean; url: string | null }>;
      }
    ).items[0]!;
    expect(item.title).toBe("Курьер 2");
    expect(item.isActive).toBe(false);
    expect(item.url).toBeNull();
  });

  it("DELETE удаляет; bad id → 400", async () => {
    if (!sql) return;
    const id = ((await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> })
      .items[0]!.id;
    expect((await req("DELETE", `${BASE}/${id}`)).status).toBe(200);
    expect((await req("DELETE", `${BASE}/abc`)).status).toBe(400);
    expect(((await (await req("GET", BASE)).json()) as { items: unknown[] }).items).toEqual([]);
  });
});
