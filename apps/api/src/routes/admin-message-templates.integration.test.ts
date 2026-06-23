// Integration tests для admin-message-templates endpoints.
// CRUD flow: create → list → update name/body → delete.
// Также проверяем: валидация (пустые поля → 400), cross-tenant isolation,
// PATCH с пустым телом → 400, PATCH несуществующего → 404.

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
import { makeAdminMessageTemplatesRoutes } from "./admin-message-templates.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_msgtpl_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-msgtpl-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = ""; // tenant A
let otherToken = ""; // tenant B (cross-tenant isolation)

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
  app.route("/", makeAdminMessageTemplatesRoutes({ db }));

  const signup = async (email: string) => {
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "strong-pwd-12345" }),
    });
    return ((await res.json()) as { token: string }).token;
  };

  token = await signup("tpl-alice@demo.io");
  otherToken = await signup("tpl-bob@demo.io");
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

function req(tok: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tok}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function post(tok: string, path: string, body: unknown) {
  return req(tok, path, { method: "POST", body: JSON.stringify(body) });
}

describe("GET /api/admin/message-templates", () => {
  it("пустой список изначально", async () => {
    if (!sql) return;
    const res = await req(token, "/api/admin/message-templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(0);
  });

  it("без токена → 401", async () => {
    if (!sql) return;
    const res = await app.request("/api/admin/message-templates");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/message-templates", () => {
  it("создаёт шаблон — 201 + поля", async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", {
      name: "Приветствие",
      body: "Привет! Рады видеть вас.",
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: number; name: string; body: string };
    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe("Приветствие");
    expect(row.body).toBe("Привет! Рады видеть вас.");
  });

  it("появляется в GET списке", async () => {
    if (!sql) return;
    const res = await req(token, "/api/admin/message-templates");
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.some((t) => t.name === "Приветствие")).toBe(true);
  });

  it("пустое name → 400", async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", { name: "", body: "текст" });
    expect(res.status).toBe(400);
  });

  it("пустой body → 400", async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", { name: "Шаблон", body: "" });
    expect(res.status).toBe(400);
  });

  it("name только пробелы → 400", async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", { name: "   ", body: "текст" });
    expect(res.status).toBe(400);
  });

  it("без name → 400", async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", { body: "текст" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/admin/message-templates/:id", () => {
  let tplId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", {
      name: "Для обновления",
      body: "Старый текст",
    });
    tplId = ((await res.json()) as { id: number }).id;
  });

  it("обновляет name", async () => {
    if (!sql) return;
    const res = await req(token, `/api/admin/message-templates/${tplId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Новое имя" }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { name: string; body: string };
    expect(row.name).toBe("Новое имя");
    expect(row.body).toBe("Старый текст"); // body не тронут
  });

  it("обновляет body", async () => {
    if (!sql) return;
    const res = await req(token, `/api/admin/message-templates/${tplId}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "Новый текст" }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()) as { body: string };
    expect(row.body).toBe("Новый текст");
  });

  it("пустой body без полей → 400 (nothing to update)", async () => {
    if (!sql) return;
    const res = await req(token, `/api/admin/message-templates/${tplId}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("пустая строка name → 400 (nothing to update)", async () => {
    if (!sql) return;
    const res = await req(token, `/api/admin/message-templates/${tplId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("несуществующий id → 404", async () => {
    if (!sql) return;
    const res = await req(token, "/api/admin/message-templates/999999", {
      method: "PATCH",
      body: JSON.stringify({ name: "Что-то" }),
    });
    expect(res.status).toBe(404);
  });

  it("cross-tenant: другой тенант не видит шаблон → 404", async () => {
    if (!sql) return;
    const res = await req(otherToken, `/api/admin/message-templates/${tplId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Взлом" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/admin/message-templates/:id", () => {
  let tplId = 0;

  beforeAll(async () => {
    if (!sql) return;
    const res = await post(token, "/api/admin/message-templates", {
      name: "Для удаления",
      body: "Временный шаблон",
    });
    tplId = ((await res.json()) as { id: number }).id;
  });

  it("cross-tenant: другой тенант не может удалить → ok но ничего не удаляет", async () => {
    if (!sql) return;
    // DELETE всегда 200, но RLS не дал удалить чужое
    await req(otherToken, `/api/admin/message-templates/${tplId}`, { method: "DELETE" });
    // Шаблон всё ещё виден оригинальному тенанту
    const list = await req(token, "/api/admin/message-templates");
    const body = (await list.json()) as { items: Array<{ id: number }> };
    expect(body.items.some((t) => t.id === tplId)).toBe(true);
  });

  it("удаляет шаблон → 200 + пропадает из списка", async () => {
    if (!sql) return;
    const res = await req(token, `/api/admin/message-templates/${tplId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const list = await req(token, "/api/admin/message-templates");
    const listBody = (await list.json()) as { items: Array<{ id: number }> };
    expect(listBody.items.some((t) => t.id === tplId)).toBe(false);
  });
});
