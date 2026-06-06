// Integration test для AI Workflow Builder (admin-workflow). LLM подменяется
// фейковым resolveChat (complete() возвращает заранее заданную строку), поэтому
// тест детерминирован и проверяет НАШУ логику (parse → normalizeStages →
// validateBackbone → applyFunnelStages), а не модель:
//   - /ai-chat: 503 без resolveChat, 400 на пустые messages, reply-only,
//     не-JSON ответ, и полный «readyToGenerate» с нормализованными stages+preview;
//   - /apply: 400 на пустые/невалидные stages, 400 при нарушении костяка,
//     happy-path с реальной записью в stage_definitions.

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  skills,
  stageDefinitions,
  stageFields,
  tryConnectToPg,
} from "@chatman-media/storage";
import type { ChatClient } from "@chatman-media/llm-router";
import { SKILLS_CATALOGUE } from "../lib/skills-catalogue.ts";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminWorkflowRoutes } from "./admin-workflow.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_workflow_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-workflow-flow-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let appNoLlm: Hono;
let token = "";
let tenantId = 0;

// Фейковый chat-клиент: complete() отдаёт `nextRaw` («что бы вернула модель»).
let nextRaw = "";
const fakeClient = { complete: async () => nextRaw } as unknown as ChatClient;

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
    app.route("/", makeAdminWorkflowRoutes({ db, resolveChat: () => fakeClient }));

    // Второй app без resolveChat — для 503.
    appNoLlm = new Hono();
    appNoLlm.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
    appNoLlm.route("/", makeAdminWorkflowRoutes({ db }));

    const sa = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "workflow@demo.io", password: "strong-pwd-12345" }),
    });
    const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
    token = sba.token;
    tenantId = sba.admin.tenantId;
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

async function post(appInstance: Hono, path: string, payload: unknown, withAuth = true): Promise<Response> {
  return await appInstance.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

const AICHAT = "/api/admin/workflows/ai-chat";
const APPLY = "/api/admin/workflows/apply";
const MSGS = [{ role: "user", content: "у меня обменник крипты на THB" }];

/** Валидная воронка по костяку: intake → qualify → offer → won/lost. */
const VALID_STAGES = [
  { slug: "intake", displayName: "Заявка", kind: "intake", stageType: "form_fill", nextStages: ["qualify"], fields: [{ slug: "name", displayName: "Имя", fieldType: "text", required: true, aiExtractable: true }] },
  { slug: "qualify", displayName: "Квалификация", kind: "active", stageType: "form_fill", phase: "qualify", goal: "понять сумму и валюту", guidance: "задай 1-2 вопроса", nextStages: ["offer"], fields: [] },
  { slug: "offer", displayName: "Оффер", kind: "active", stageType: "rate_confirmation", phase: "offer", nextStages: ["won", "lost"], fields: [] },
  { slug: "won", displayName: "Успех", kind: "terminal_won", stageType: "milestone", nextStages: [], fields: [] },
  { slug: "lost", displayName: "Отказ", kind: "terminal_lost", stageType: "milestone", nextStages: [], fields: [] },
];

/** Ветвящаяся (мульти-запрос) воронка: intake(request_type) → 2 ветки → общие won/lost. */
const MULTI_STAGES = [
  { slug: "request_received", displayName: "Заявка", kind: "intake", stageType: "form_fill", nextStages: ["exchange_request", "transfer_request", "cancelled"], fields: [{ slug: "request_type", displayName: "Тип запроса", fieldType: "select", required: true, aiExtractable: true, options: [{ value: "exchange", label: "Обмен" }, { value: "transfer", label: "Трансфер" }] }] },
  { slug: "exchange_request", displayName: "Обмен: детали", kind: "active", stageType: "form_fill", phase: "qualify", nextStages: ["exchange_offer"], fields: [] },
  { slug: "transfer_request", displayName: "Трансфер: детали", kind: "active", stageType: "form_fill", phase: "qualify", nextStages: ["transfer_offer"], fields: [] },
  { slug: "exchange_offer", displayName: "Обмен: оффер", kind: "active", stageType: "rate_confirmation", phase: "offer", nextStages: ["exchange_fulfill"], fields: [] },
  { slug: "transfer_offer", displayName: "Трансфер: оффер", kind: "active", stageType: "rate_confirmation", phase: "offer", nextStages: ["transfer_fulfill"], fields: [] },
  { slug: "exchange_fulfill", displayName: "Обмен: выдача", kind: "active", stageType: "milestone", phase: "fulfill", nextStages: ["completed", "cancelled"], fields: [] },
  { slug: "transfer_fulfill", displayName: "Трансфер: подача", kind: "active", stageType: "milestone", phase: "fulfill", nextStages: ["completed", "cancelled"], fields: [] },
  { slug: "completed", displayName: "Выполнено", kind: "terminal_won", stageType: "milestone", nextStages: [], fields: [] },
  { slug: "cancelled", displayName: "Отменено", kind: "terminal_lost", stageType: "milestone", nextStages: [], fields: [] },
];

describe("admin-workflow /ai-chat", () => {
  it("без auth → 401", async () => {
    if (!sql) return;
    const res = await post(app, AICHAT, { messages: MSGS }, false);
    expect(res.status).toBe(401);
  });

  it("без resolveChat → 503", async () => {
    if (!sql) return;
    const res = await post(appNoLlm, AICHAT, { messages: MSGS });
    expect(res.status).toBe(503);
  });

  it("пустые messages → 400", async () => {
    if (!sql) return;
    const res = await post(app, AICHAT, { messages: [] });
    expect(res.status).toBe(400);
  });

  it("readyToGenerate:false → продолжаем диалог", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ reply: "Какой актив меняете?", readyToGenerate: false });
    const res = await post(app, AICHAT, { messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; readyToGenerate: boolean };
    expect(body.reply).toBe("Какой актив меняете?");
    expect(body.readyToGenerate).toBe(false);
  });

  it("не-JSON ответ модели → текст как reply, readyToGenerate:false", async () => {
    if (!sql) return;
    nextRaw = "просто текст без json";
    const res = await post(app, AICHAT, { messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: string; readyToGenerate: boolean };
    expect(body.reply).toBe("просто текст без json");
    expect(body.readyToGenerate).toBe(false);
  });

  it("readyToGenerate:true → нормализованные stages + preview + backbone", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ reply: "Готова воронка", readyToGenerate: true, stages: VALID_STAGES });
    const res = await post(app, AICHAT, { messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readyToGenerate: boolean;
      stages: Array<{ slug: string; position: number }>;
      preview: Array<{ kind: string }>;
      backbone: { errors: string[] };
    };
    expect(body.readyToGenerate).toBe(true);
    expect(body.stages.length).toBe(5);
    expect(body.preview.some((s) => s.kind === "intake")).toBe(true);
    expect(body.preview.some((s) => s.kind === "terminal_won")).toBe(true);
    expect(body.backbone.errors).toEqual([]);
    // normalizeStages проставляет позиции по порядку.
    expect(body.stages[0]?.position).toBe(0);
  });

  it("readyToGenerate:true с мусорными stages → откат в диалог", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ reply: "...", readyToGenerate: true, stages: [{ foo: "bar" }] });
    const res = await post(app, AICHAT, { messages: MSGS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readyToGenerate: boolean };
    expect(body.readyToGenerate).toBe(false);
  });
});

describe("admin-workflow /apply", () => {
  it("пустые stages → 400", async () => {
    if (!sql) return;
    const res = await post(app, APPLY, { stages: [] });
    expect(res.status).toBe(400);
  });

  it("нарушение костяка (нет terminal) → 400 + violations", async () => {
    if (!sql) return;
    const res = await post(app, APPLY, {
      stages: [
        { slug: "intake", displayName: "Заявка", kind: "intake", stageType: "form_fill", nextStages: [], fields: [] },
        { slug: "qualify", displayName: "Квал", kind: "active", stageType: "form_fill", phase: "qualify", nextStages: [], fields: [] },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { violations?: string[] };
    expect(Array.isArray(body.violations)).toBe(true);
    expect((body.violations ?? []).length).toBeGreaterThan(0);
  });

  it("happy path → ok + stage_definitions записаны в БД", async () => {
    if (!sql) return;
    const res = await post(app, APPLY, { stages: VALID_STAGES });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stageCount: number };
    expect(body.ok).toBe(true);
    expect(body.stageCount).toBe(5);

    const rows = await db
      .select({ slug: stageDefinitions.slug, goal: stageDefinitions.goal })
      .from(stageDefinitions)
      .where(eq(stageDefinitions.tenantId, tenantId));
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.slug).sort()).toEqual(["intake", "lost", "offer", "qualify", "won"]);
    // Phase 2 slice C: AI-emitted per-stage goal is normalized + persisted.
    expect(rows.find((r) => r.slug === "qualify")?.goal).toBe("понять сумму и валюту");
  });
});

describe("admin-workflow /apply мульти-запрос (R3)", () => {
  it("ветвящаяся воронка применяется + request_type options сохранены", async () => {
    if (!sql) return;
    const res = await post(app, APPLY, { stages: MULTI_STAGES });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; stageCount: number };
    expect(body.stageCount).toBe(9);

    const [intake] = await db
      .select({ id: stageDefinitions.id })
      .from(stageDefinitions)
      .where(and(eq(stageDefinitions.tenantId, tenantId), eq(stageDefinitions.slug, "request_received")));
    const fields = await db
      .select({ slug: stageFields.slug, optionsJson: stageFields.optionsJson })
      .from(stageFields)
      .where(eq(stageFields.stageId, intake!.id));
    const rt = fields.find((f) => f.slug === "request_type");
    expect(rt).toBeDefined();
    // value-ключи опций сохранены латиницей — иначе сломалась бы маршрутизация веток.
    const opts = JSON.parse(rt!.optionsJson) as Array<{ value: string }>;
    expect(opts.map((o) => o.value).sort()).toEqual(["exchange", "transfer"]);
  });

  it("мультизапрос: тип без ветки → 400 + violation", async () => {
    if (!sql) return;
    const broken = MULTI_STAGES.map((s) =>
      s.slug === "request_received"
        ? {
            ...s,
            fields: [{ slug: "request_type", displayName: "Тип запроса", fieldType: "select", required: true, aiExtractable: true, options: [{ value: "exchange", label: "Обмен" }, { value: "transfer", label: "Трансфер" }, { value: "food", label: "Еда" }] }],
          }
        : s,
    );
    const res = await post(app, APPLY, { stages: broken });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { violations?: string[] };
    expect((b.violations ?? []).some((v) => v.includes("food"))).toBe(true);
  });
});

const RS = "/api/admin/workflows/recommend-skills";

describe("admin-workflow /recommend-skills", () => {
  it("без resolveChat → 503", async () => {
    if (!sql) return;
    const res = await post(appNoLlm, RS, { description: "обменник" });
    expect(res.status).toBe(503);
  });

  it("без description → 400", async () => {
    if (!sql) return;
    const res = await post(app, RS, {});
    expect(res.status).toBe(400);
  });

  it("не-JSON ответ → 502", async () => {
    if (!sql) return;
    nextRaw = "не json";
    const res = await post(app, RS, { description: "обменник" });
    expect(res.status).toBe(502);
  });

  it("нет валидных slug → 502", async () => {
    if (!sql) return;
    nextRaw = JSON.stringify({ slugs: ["no_such_skill_xyz"] });
    const res = await post(app, RS, { description: "обменник" });
    expect(res.status).toBe(502);
  });

  it("happy → включает РОВНО рекомендованные навыки", async () => {
    if (!sql) return;
    const pick = [SKILLS_CATALOGUE[0]!.slug, SKILLS_CATALOGUE[1]!.slug];
    nextRaw = JSON.stringify({ slugs: pick });
    const res = await post(app, RS, { description: "обменник крипты на THB" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: string[]; count: number };
    expect(body.count).toBe(2);
    expect([...body.enabled].sort()).toEqual([...pick].sort());

    // В БД включены РОВНО рекомендованные (остальной каталог выключен).
    const enabled = await db
      .select({ slug: skills.slug })
      .from(skills)
      .where(and(eq(skills.tenantId, tenantId), eq(skills.isEnabled, true)));
    expect(enabled.map((s) => s.slug).sort()).toEqual([...pick].sort());
  });
});
