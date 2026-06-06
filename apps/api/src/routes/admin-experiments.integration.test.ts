// Integration test for admin-experiments CRUD + status state machine.
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
import { makeAdminExperimentsRoutes } from "./admin-experiments.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_exp_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-experiments-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

const BASE = "/api/admin/experiments";
const ALLOC = JSON.stringify([
  { style_slug: "a", weight: 50 },
  { style_slug: "b", weight: 50 },
]);

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
    app.route("/", makeAdminExperimentsRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "exp@demo.io", password: "strong-pwd-12345" }),
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

async function firstId(): Promise<number> {
  return ((await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> }).items[0]!.id;
}

describe("admin-experiments", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    expect((await req("GET", BASE, undefined, false)).status).toBe(401);
  });

  it("GET пустой → []", async () => {
    if (!sql) return;
    expect(((await (await req("GET", BASE)).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("POST валидация: slug / metric / allocation / json", async () => {
    if (!sql) return;
    expect((await req("POST", BASE, { slug: "Bad Slug", successMetric: "won", allocationJson: ALLOC })).status).toBe(400);
    expect((await req("POST", BASE, { slug: "exp1", successMetric: "nope", allocationJson: ALLOC })).status).toBe(400);
    expect((await req("POST", BASE, { slug: "exp1", successMetric: "won", allocationJson: JSON.stringify([{ x: 1 }]) })).status).toBe(400);
    expect((await req("POST", BASE, { slug: "exp1", successMetric: "won", allocationJson: "{not json" })).status).toBe(400);
  });

  it("POST happy → 201; дубль slug → 409", async () => {
    if (!sql) return;
    const res = await req("POST", BASE, { slug: "exp-a", successMetric: "won", allocationJson: ALLOC });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slug: string }).slug).toBe("exp-a");
    expect((await req("POST", BASE, { slug: "exp-a", successMetric: "won", allocationJson: ALLOC })).status).toBe(409);
  });

  it("PATCH: bad id → 400; nothing → 400; not found → 404; draft → 200", async () => {
    if (!sql) return;
    const id = await firstId();
    expect((await req("PATCH", `${BASE}/0`, { successMetric: "won" })).status).toBe(400);
    expect((await req("PATCH", `${BASE}/${id}`, {})).status).toBe(400);
    expect((await req("PATCH", `${BASE}/999999`, { successMetric: "qualified" })).status).toBe(404);
    expect((await req("PATCH", `${BASE}/${id}`, { successMetric: "qualified" })).status).toBe(200);
  });

  it("POST битый JSON → 400; PATCH metric/allocation валидация → 400", async () => {
    if (!sql) return;
    const bad = await app.request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const id = await firstId(); // exp-a ещё в draft
    expect((await req("PATCH", `${BASE}/${id}`, { successMetric: "nope" })).status).toBe(400);
    expect((await req("PATCH", `${BASE}/${id}`, { allocationJson: "{not json" })).status).toBe(400);
    expect((await req("PATCH", `${BASE}/${id}`, { allocationJson: JSON.stringify([{ x: 1 }]) })).status).toBe(400);
  });

  it("PUT status: bad status → 400; invalid transition → 409; draft→running → 200; затем PATCH running → 409", async () => {
    if (!sql) return;
    const id = await firstId();
    expect((await req("PUT", `${BASE}/${id}/status`, { status: "nope" })).status).toBe(400);
    expect((await req("PUT", `${BASE}/${id}/status`, { status: "done" })).status).toBe(409); // draft→done запрещён
    expect((await req("PUT", `${BASE}/0/status`, { status: "running" })).status).toBe(400);
    expect((await req("PUT", `${BASE}/999999/status`, { status: "running" })).status).toBe(404);
    expect((await req("PUT", `${BASE}/${id}/status`, { status: "running" })).status).toBe(200);
    // running нельзя редактировать
    expect((await req("PATCH", `${BASE}/${id}`, { successMetric: "won" })).status).toBe(409);
  });
});
