// Integration test для admin-copilot chat endpoint. LLM подменяется фейковым
// resolveChat (complete() возвращает заранее заданную строку), поэтому тест
// детерминирован и проверяет нашу логику парсинга/валидации, а не модель:
//   - 503 llm_not_configured когда resolveChat не сконфигурирован;
//   - reply-only и non-JSON ответы LLM;
//   - install_vertical: валидный slug проходит, мусорный → action=null;
//   - build_funnel: stages нормализуются (тот же путь, что AI Workflow Builder).

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
// Импорт ради side-effect: регистрирует EXCHANGE_V1 в defaultRegistry, по
// которому install_vertical валидирует slug.
import { EXCHANGE_V1 } from "@chatman-media/vertical-exchange";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminCopilotRoutes } from "./admin-copilot.ts";
import { normalizeStages, type StageDraft } from "./admin-workflow.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_copilot_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-copilot-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let appNoLlm: Hono;
let token = "";

// Фейковый chat-клиент: complete() отдаёт `nextRaw` (что бы «вернула модель»).
let nextRaw = "";
let lastMessages: ChatMessage[] = [];
const fakeClient = {
  complete: async (messages: ChatMessage[]) => {
    lastMessages = messages;
    return nextRaw;
  },
} as unknown as ChatClient;
const resolveChat = () => fakeClient;

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
    app.route("/", makeAdminCopilotRoutes({ db, resolveChat }));

    // Второй app БЕЗ resolveChat — для проверки 503 llm_not_configured.
    appNoLlm = new Hono();
    appNoLlm.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    appNoLlm.route("/", makeAdminCopilotRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "copilot@demo.io", password: "strong-pwd-12345" }),
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

async function chat(
  appInstance: Hono,
  payload: Record<string, unknown>,
  withAuth = true,
): Promise<Response> {
  return await appInstance.request("/api/admin/copilot/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

const MSGS = [{ role: "user", content: "привет" }];

describe("admin-copilot /chat", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await chat(app, { page: "onboarding", messages: MSGS }, false);
    expect(res.status).toBe(401);
  });

  it("без resolveChat → 503 llm_not_configured", async () => {
    if (!sql) return;
    const res = await chat(appNoLlm, { page: "onboarding", messages: MSGS });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("llm_not_configured");
  });

  it("пустые messages → 400", async () => {
    if (!sql) return;
    const res = await chat(app, { page: "onboarding", messages: [] });
    expect(res.status).toBe(400);
  });

  it("reply-only JSON → reply, action=null", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ reply: "Привет! Чем помочь?", action: null });
    const res = await chat(app, { page: "onboarding", messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; action: unknown };
    expect(body.reply).toBe("Привет! Чем помочь?");
    expect(body.action).toBeNull();
  });

  it("system prompt содержит общий контракт сборки воронки", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ reply: "Ок", action: null });
    const res = await chat(app, { page: "funnel", messages: MSGS });
    expect(res.status).toBe(200);
    const system = lastMessages[0]?.content ?? "";
    expect(system).toContain("Используй тот же контракт стадий");
    expect(system).toContain('"phase"');
    expect(system).toContain('"goal"');
    expect(system).toContain("request_type");
    expect(system).toContain("awaiting_operator");
  });

  it("не-JSON ответ модели → весь текст как reply, action=null", async () => {
    if (!sql) return;
    nextRaw = "просто текст без json";
    const res = await chat(app, { page: "leads", messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; action: unknown };
    expect(body.reply).toBe("просто текст без json");
    expect(body.action).toBeNull();
  });

  it("install_vertical с валидным slug → action проходит", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({
      reply: "Установить обменник?",
      action: { type: "install_vertical", slug: EXCHANGE_V1.slug },
    });
    const res = await chat(app, { page: "onboarding", messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      action: { type: string; slug: string; displayName: string } | null;
    };
    expect(body.action?.type).toBe("install_vertical");
    expect(body.action?.slug).toBe(EXCHANGE_V1.slug);
    expect(typeof body.action?.displayName).toBe("string");
  });

  it("install_vertical с мусорным slug → action=null", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({
      reply: "...",
      action: { type: "install_vertical", slug: "no_such_vertical_xyz" },
    });
    const res = await chat(app, { page: "onboarding", messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: unknown };
    expect(body.action).toBeNull();
  });

  it("build_funnel → нормализованные stages + preview", async () => {
    if (!sql) return;
    const draft: StageDraft[] = [
      {
        slug: "intake",
        displayName: "Заявка",
        kind: "intake",
        stageType: "form_fill",
        nextStages: ["qualify"],
        fields: [
          {
            slug: "service_type",
            displayName: "Тип услуги",
            fieldType: "select",
            required: true,
            aiExtractable: true,
            options: [{ value: "consulting", label: "Консультация" }],
          },
        ],
      },
      {
        slug: "qualify",
        displayName: "Квалификация",
        kind: "active",
        stageType: "form_fill",
        phase: "qualify",
        goal: "Понять задачу и бюджет клиента.",
        guidance: "Уточни цель, сроки и бюджет, затем веди к офферу.",
        nextStages: ["offer", "lost"],
        fields: [],
      },
      {
        slug: "offer",
        displayName: "Оффер",
        kind: "active",
        stageType: "awaiting_operator",
        phase: "offer",
        goal: "Передать персональные условия и получить подтверждение.",
        guidance: "Условия даёт оператор, не выдумывай цену.",
        nextStages: ["won", "lost"],
        fields: [],
      },
      {
        slug: "won",
        displayName: "Успех",
        kind: "terminal_won",
        stageType: "milestone",
        nextStages: [],
        fields: [],
      },
      {
        slug: "lost",
        displayName: "Отказ",
        kind: "terminal_lost",
        stageType: "milestone",
        nextStages: [],
        fields: [],
      },
    ];
    nextRaw = JSON.stringify({
      reply: "Вот воронка",
      action: {
        type: "build_funnel",
        stages: draft,
      },
    });
    const res = await chat(app, { page: "funnel", messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      action: {
        type: string;
        stages: unknown[];
        preview: Array<{ kind: string; stageType: string }>;
      } | null;
    };
    expect(body.action?.type).toBe("build_funnel");
    expect(body.action?.stages).toEqual(normalizeStages(draft));
    expect(body.action?.preview.length).toBe(5);
    expect(body.action?.preview.some((s) => s.kind === "intake")).toBe(true);
    expect(body.action?.preview.some((s) => s.stageType === "awaiting_operator")).toBe(true);
  });
});
