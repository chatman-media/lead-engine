// Integration test для admin-styles AI-генерации полного стиля
// (POST /api/admin/styles/generate-full). LLM подменяется фейковым resolveChat;
// проверяем нашу логику: parse → sanitize slug → StyleSchema.safeParse →
// StylesRepo.create(active). Детерминированно, без реальной модели.

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import type { ChatClient } from "@chatman-media/llm-router";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminStylesRoutes } from "./admin-styles.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_styles_${Math.random().toString(36).slice(2, 10)}`;
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
const SECRET = "test-secret-styles-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let appNoLlm: Hono;
let token = "";

let nextRaw = "";
const fakeClient = { complete: async () => nextRaw } as unknown as ChatClient;

const GEN = "/api/admin/styles/generate-full";

// Полный валидный Style (остальные поля доберёт StyleSchema дефолтами).
const VALID_STYLE = {
  slug: "exchange-pro",
  displayName: "Обменник Про",
  persona: { name: "Алекс", role: "human", company: "exchanges.agency" },
  voice: { tone: "дружелюбный, уверенный", language: "ru", forbid: ["канцелярит"] },
  framework: "SPIN",
  hooks: [{ kind: "scarcity", text: "Курс фиксируется на 15 минут" }],
  stages: {
    qualify: { goal: "понять сумму и валюту обмена" },
    close: { goal: "подтвердить заявку и реквизиты" },
  },
  fewShot: [
    {
      user: "хочу поменять usdt",
      assistant: "Привет! Сколько USDT и на какую валюту?",
      stage: "qualify",
    },
  ],
  guardrails: { forbiddenTopics: [] },
};

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
  app.route("/", makeAdminStylesRoutes({ db, resolveChat: () => fakeClient }));

  appNoLlm = new Hono();
  appNoLlm.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  appNoLlm.route("/", makeAdminStylesRoutes({ db }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "styles@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string };
  token = sba.token;
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function gen(appInstance: Hono, payload: unknown, withAuth = true): Promise<Response> {
  return await appInstance.request(GEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

describe("admin-styles /generate-full", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await gen(app, { description: "обменник крипты" }, false);
    expect(res.status).toBe(401);
  });

  it("без resolveChat → 503", async () => {
    if (!sql) return;
    const res = await gen(appNoLlm, { description: "обменник крипты" });
    expect(res.status).toBe(503);
  });

  it("без description → 400", async () => {
    if (!sql) return;
    const res = await gen(app, {});
    expect(res.status).toBe(400);
  });

  it("не-JSON ответ модели → 502", async () => {
    if (!sql) return;
    nextRaw = "это не json";
    const res = await gen(app, { description: "обменник крипты на THB" });
    expect(res.status).toBe(502);
  });

  it("ответ не проходит StyleSchema → 502", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ slug: "x", displayName: "X" }); // нет persona/voice/framework/stages
    const res = await gen(app, { description: "обменник крипты на THB" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("schema");
  });

  it("happy path → 201, стиль сохранён активным и доступен", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify(VALID_STYLE);
    const res = await gen(app, { description: "обменник крипты USDT→THB на Пхукете" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: number;
      slug: string;
      style: { framework: string; persona: { role: string } };
    };
    expect(body.slug).toBe("exchange-pro");
    expect(body.style.framework).toBe("SPIN");
    expect(body.style.persona.role).toBe("human");

    // Доступен через GET /api/admin/styles, configJson парсится в полный Style.
    const list = await app.request("/api/admin/styles", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listed = (await list.json()) as {
      items: Array<{ slug: string; isActive: boolean; configJson: string }>;
    };
    const saved = listed.items.find((s) => s.slug === "exchange-pro");
    expect(saved).toBeDefined();
    expect(saved?.isActive).toBe(true);
    expect((JSON.parse(saved?.configJson ?? "{}") as { framework?: string }).framework).toBe(
      "SPIN",
    );
  });

  it("повторная генерация того же slug → 409", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify(VALID_STYLE);
    const res = await gen(app, { description: "тот же обменник" });
    expect(res.status).toBe(409);
  });
});

// ── POST /api/admin/styles/generate (лёгкий AI-экстракт метаданных) ───────────
const SAMPLES_BODY = { samples: "Привет! Я Алекс, менеджер агентства. Чем могу помочь?" };
const META_RESPONSE = JSON.stringify({
  displayName: "Дружелюбный менеджер",
  slug: "friendly_manager",
  personaName: "Алекс",
  personaRole: "менеджер",
  personaCompany: "Агентство",
  framework: "SPIN",
});

async function generate(payload: unknown, withAuth = true): Promise<Response> {
  return app.request("/api/admin/styles/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

describe("admin-styles /generate (metadata extract)", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await generate(SAMPLES_BODY, false);
    expect(res.status).toBe(401);
  });

  it("без resolveChat → 503", async () => {
    if (!sql) return;
    const res = await appNoLlm.request("/api/admin/styles/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(SAMPLES_BODY),
    });
    expect(res.status).toBe(503);
  });

  it("пустой samples → 400", async () => {
    if (!sql) return;
    const res = await generate({ samples: "   " });
    expect(res.status).toBe(400);
  });

  it("LLM бросает → 502", async () => {
    if (!sql) return;
    const errClient = {
      complete: async () => {
        throw new Error("llm down");
      },
    } as unknown as ChatClient;
    const appErr = new Hono();
    appErr.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    appErr.route("/", makeAdminStylesRoutes({ db, resolveChat: () => errClient }));
    const res = await appErr.request("/api/admin/styles/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(SAMPLES_BODY),
    });
    expect(res.status).toBe(502);
  });

  it("LLM возвращает не-JSON → 502", async () => {
    if (!sql) return;
    nextRaw = "не json";
    const res = await generate(SAMPLES_BODY);
    expect(res.status).toBe(502);
  });

  it("happy path → 200 со slug + displayName + framework", async () => {
    if (!sql) return;
    nextRaw = META_RESPONSE;
    const res = await generate(SAMPLES_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; displayName: string; framework: string };
    expect(body.slug).toBe("friendly_manager");
    expect(body.displayName).toBe("Дружелюбный менеджер");
    expect(body.framework).toBe("SPIN");
  });
});

// ── CRUD: POST / GET / PATCH / DELETE /api/admin/styles ──────────────────────
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

describe("admin-styles CRUD", () => {
  let styleId = 0;

  it("GET /styles (пустой список)", async () => {
    if (!sql) return;
    const res = await req("GET", "/api/admin/styles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    // может быть непустым из generate-full теста — просто проверяем структуру
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("POST /styles без displayName → 400", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/styles", { slug: "x" });
    expect(res.status).toBe(400);
  });

  it("POST /styles с невалидным slug → 400", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/styles", { displayName: "X", slug: "Плохой Слаг" });
    expect(res.status).toBe(400);
  });

  it("POST /styles с невалидным configJson → 400", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/styles", {
      displayName: "X",
      slug: "valid-slug",
      configJson: "{broken",
    });
    expect(res.status).toBe(400);
  });

  it("POST /styles happy → 201", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/styles", {
      displayName: "Тест Стиль",
      slug: "test-crud-style",
      configJson: "{}",
      isActive: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; slug: string };
    expect(body.slug).toBe("test-crud-style");
    styleId = body.id;
  });

  it("POST /styles дубль slug → 409", async () => {
    if (!sql) return;
    const res = await req("POST", "/api/admin/styles", {
      displayName: "Другой",
      slug: "test-crud-style",
      configJson: "{}",
    });
    expect(res.status).toBe(409);
  });

  it("PATCH /styles/:id невалидный id → 400", async () => {
    if (!sql) return;
    const res = await req("PATCH", "/api/admin/styles/abc", { displayName: "X" });
    expect(res.status).toBe(400);
  });

  it("PATCH /styles/:id пустой patch → 400", async () => {
    if (!sql) return;
    if (!styleId) return;
    const res = await req("PATCH", `/api/admin/styles/${styleId}`, {});
    expect(res.status).toBe(400);
  });

  it("PATCH /styles/:id с невалидным configJson → 400", async () => {
    if (!sql) return;
    if (!styleId) return;
    const res = await req("PATCH", `/api/admin/styles/${styleId}`, { configJson: "{broken" });
    expect(res.status).toBe(400);
  });

  it("PATCH /styles/:id 404 для несуществующего", async () => {
    if (!sql) return;
    const res = await req("PATCH", "/api/admin/styles/999999", { displayName: "X" });
    expect(res.status).toBe(404);
  });

  it("PATCH /styles/:id happy → 200", async () => {
    if (!sql) return;
    if (!styleId) return;
    const res = await req("PATCH", `/api/admin/styles/${styleId}`, {
      displayName: "Обновлённый Стиль",
      isActive: false,
      configJson: JSON.stringify({ updated: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string; isActive: boolean };
    expect(body.displayName).toBe("Обновлённый Стиль");
    expect(body.isActive).toBe(false);
  });

  it("DELETE /styles/:id невалидный id → 400", async () => {
    if (!sql) return;
    const res = await req("DELETE", "/api/admin/styles/abc");
    expect(res.status).toBe(400);
  });

  it("DELETE /styles/:id 404 для несуществующего", async () => {
    if (!sql) return;
    const res = await req("DELETE", "/api/admin/styles/999999");
    expect(res.status).toBe(404);
  });

  it("DELETE /styles/:id happy → 200", async () => {
    if (!sql) return;
    if (!styleId) return;
    const res = await req("DELETE", `/api/admin/styles/${styleId}`);
    expect(res.status).toBe(200);
  });
});
