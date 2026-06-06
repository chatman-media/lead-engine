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
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
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
  fewShot: [{ user: "хочу поменять usdt", assistant: "Привет! Сколько USDT и на какую валюту?", stage: "qualify" }],
  guardrails: { forbiddenTopics: [] },
};

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
  },
  30_000,
);

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
    const listed = (await list.json()) as { items: Array<{ slug: string; isActive: boolean; configJson: string }> };
    const saved = listed.items.find((s) => s.slug === "exchange-pro");
    expect(saved).toBeDefined();
    expect(saved?.isActive).toBe(true);
    expect((JSON.parse(saved?.configJson ?? "{}") as { framework?: string }).framework).toBe("SPIN");
  });

  it("повторная генерация того же slug → 409", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify(VALID_STYLE);
    const res = await gen(app, { description: "тот же обменник" });
    expect(res.status).toBe(409);
  });
});
