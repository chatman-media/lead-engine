// Integration test for admin-director-hooks CRUD (tenant persuasion scripts).
// Isolated DB + real auth; covers list/create/reorder/update/delete + guards.
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
import { makeAdminDirectorHooksRoutes } from "./admin-director-hooks.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_dhooks_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-dhooks-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";

const BASE = "/api/admin/director-hooks";

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
  app.route("/", makeAdminDirectorHooksRoutes({ db }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "dhooks@demo.io", password: "strong-pwd-12345" }),
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

describe("admin-director-hooks CRUD", () => {
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

  it("POST без name → 400, без body → 400, invalid json → 400", async () => {
    if (!sql) return;
    expect((await req("POST", BASE, { body: "x" })).status).toBe(400);
    expect((await req("POST", BASE, { name: "x" })).status).toBe(400);
    const bad = await app.request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
  });

  it("POST создаёт хук → 201, виден в GET", async () => {
    if (!sql) return;
    const res = await req("POST", BASE, {
      name: "Срочность",
      body: "Курс фиксируется на 15 минут",
      triggerHint: "когда торгуется",
    });
    expect(res.status).toBe(201);
    const hook = (await res.json()) as {
      id: number;
      name: string;
      triggerHint: string | null;
      isActive: boolean;
    };
    expect(hook.name).toBe("Срочность");
    expect(hook.triggerHint).toBe("когда торгуется");
    expect(hook.isActive).toBe(true);

    const list = (await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> };
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.id).toBe(hook.id);
  });

  it("PATCH /:id обновляет; bad id → 400; not found → 404", async () => {
    if (!sql) return;
    const id = ((await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> })
      .items[0]!.id;
    expect(
      (
        await req("PATCH", `${BASE}/${id}`, {
          name: "Срочность 2",
          isActive: false,
          triggerHint: "",
        })
      ).status,
    ).toBe(200);
    expect((await req("PATCH", `${BASE}/0`, { name: "x" })).status).toBe(400);
    expect((await req("PATCH", `${BASE}/999999`, { name: "x" })).status).toBe(404);

    const item = (
      (await (await req("GET", BASE)).json()) as {
        items: Array<{ name: string; isActive: boolean; triggerHint: string | null }>;
      }
    ).items[0]!;
    expect(item.name).toBe("Срочность 2");
    expect(item.isActive).toBe(false);
    expect(item.triggerHint).toBeNull();
  });

  it("PATCH /reorder: массив id → ok; не-массив → 400", async () => {
    if (!sql) return;
    await req("POST", BASE, { name: "Второй", body: "тело", position: 1 });
    const ids = (
      (await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> }
    ).items.map((h) => h.id);
    expect((await req("PATCH", `${BASE}/reorder`, { ids: [ids[1], ids[0]] })).status).toBe(200);
    expect((await req("PATCH", `${BASE}/reorder`, { ids: "nope" })).status).toBe(400);
  });

  it("DELETE /:id удаляет; повтор → 404; bad id → 400", async () => {
    if (!sql) return;
    const ids = (
      (await (await req("GET", BASE)).json()) as { items: Array<{ id: number }> }
    ).items.map((h) => h.id);
    for (const id of ids) {
      expect((await req("DELETE", `${BASE}/${id}`)).status).toBe(200);
      expect((await req("DELETE", `${BASE}/${id}`)).status).toBe(404);
    }
    expect((await req("DELETE", `${BASE}/0`)).status).toBe(400);
    expect(((await (await req("GET", BASE)).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("applicableStages: round-trip + фильтрация невалидных стадий", async () => {
    if (!sql) return;
    // Список пуст после DELETE-теста. Создаём с валидной + мусорной стадией.
    const created = (await (
      await req("POST", BASE, {
        name: "Только закрытие",
        body: "дави на закрытии",
        applicableStages: ["close", "bogus_stage", "qualify"],
      })
    ).json()) as { id: number; applicableStagesJson: string };
    // Мусор отфильтрован, валидные сохранены.
    expect(JSON.parse(created.applicableStagesJson)).toEqual(["close", "qualify"]);

    // PATCH сужает до одной стадии.
    expect(
      (await req("PATCH", `${BASE}/${created.id}`, { applicableStages: ["pitch"] })).status,
    ).toBe(200);
    const after = (
      (await (await req("GET", BASE)).json()) as {
        items: Array<{ applicableStagesJson: string }>;
      }
    ).items[0]!;
    expect(JSON.parse(after.applicableStagesJson)).toEqual(["pitch"]);

    // Дефолт без поля → '[]' (на всех стадиях).
    const plain = (await (await req("POST", BASE, { name: "Везде", body: "всегда" })).json()) as {
      applicableStagesJson: string;
    };
    expect(plain.applicableStagesJson).toBe("[]");
  });
});
