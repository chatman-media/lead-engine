import { type Db, StylesRepo, withTenant } from "@chatman-media/conversation-engine";
import { StyleSchema } from "@chatman-media/kb";
import type { ChatClient } from "@chatman-media/llm-router";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { isUniqueViolation } from "../lib/db-errors.ts";

/**
 * Styles CRUD — tenant-specific sales personas / communication frameworks.
 *
 * Endpoints:
 *   GET    /api/admin/styles          — список всех не-удалённых стилей тенанта
 *   POST   /api/admin/styles/generate — AI-генерация стиля из примеров сообщений
 *   POST   /api/admin/styles          — создать стиль
 *   PATCH  /api/admin/styles/:id      — обновить стиль
 *   DELETE /api/admin/styles/:id      — soft-delete стиль
 */
export interface AdminStylesRoutesOpts {
  db: Db;
  /** Tenant chat LLM — needed for /generate. If absent, /generate returns 503. */
  resolveChat?: (tenantId: number) => ChatClient;
}

export function makeAdminStylesRoutes(opts: AdminStylesRoutesOpts): Hono {
  const app = new Hono();

  /**
   * POST /api/admin/styles/generate
   * Body: { samples: string }  — raw text of example messages (max 8000 chars)
   * Returns: { displayName, slug, personaName, personaRole, personaCompany, framework }
   */
  app.post("/api/admin/styles/generate", async (c) => {
    if (!opts.resolveChat) {
      return c.json({ error: "LLM not configured for this tenant" }, 503);
    }
    const tenantId = c.var.tenantId;

    let body: { samples?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.samples !== "string" || !body.samples.trim()) {
      return c.json({ error: "samples required" }, 400);
    }
    const samples = body.samples.slice(0, 8000);

    const prompt = `Проанализируй эти сообщения продавца/менеджера и определи стиль общения.
Верни ТОЛЬКО JSON-объект (без markdown, без объяснений):
{
  "displayName": "Краткое название стиля (2-4 слова, на языке сообщений)",
  "slug": "snake_case_slug из displayName, только a-z 0-9 _",
  "personaName": "Имя персоны если упоминается, иначе пустая строка",
  "personaRole": "Должность/роль если видна из сообщений, иначе пустая строка",
  "personaCompany": "Название компании если упоминается, иначе пустая строка",
  "framework": "Один из: SPIN, AIDA, Challenger, Sandler, Consultative — или пустая строка"
}

Обрати внимание на: тон (формальный/дружелюбный), работу с возражениями, создание срочности, установление доверия.

Сообщения:
${samples}`;

    let client: ChatClient;
    try {
      client = opts.resolveChat(tenantId);
    } catch {
      return c.json({ error: "LLM not configured for this tenant" }, 503);
    }

    let raw: string;
    try {
      raw = await client.complete(
        [{ role: "user", content: prompt }],
        { numPredict: 300 },
      );
    } catch (err) {
      return c.json(
        { error: `LLM error: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    // Strip possible markdown code fences
    const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, string>;
    } catch {
      return c.json({ error: "LLM returned non-JSON response", raw }, 502);
    }

    const slug = (parsed.slug ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);

    return c.json({
      displayName: parsed.displayName ?? "",
      slug,
      personaName: parsed.personaName ?? "",
      personaRole: parsed.personaRole ?? "",
      personaCompany: parsed.personaCompany ?? "",
      framework: parsed.framework ?? "",
    });
  });

  /**
   * POST /api/admin/styles/generate-full
   * Body: { description: string }  — business description (max 4000 chars)
   * AI собирает ПОЛНЫЙ Style (persona/voice/framework/hooks/per-stage goal+
   * guidance/few-shot) из описания бизнеса, валидирует StyleSchema и сохраняет
   * как активный стиль. Дополняет лёгкий /generate (тот лишь извлекает метаданные
   * из примеров). Часть AI-сборки воронки — см. docs AI_FUNNEL_BUILDER.md.
   */
  app.post("/api/admin/styles/generate-full", async (c) => {
    if (!opts.resolveChat) {
      return c.json({ error: "LLM not configured for this tenant" }, 503);
    }
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let body: { description?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.description !== "string" || !body.description.trim()) {
      return c.json({ error: "description required" }, 400);
    }
    const description = body.description.slice(0, 4000);

    const prompt = `Ты проектируешь стиль общения (sales persona) AI-бота по описанию бизнеса.
Верни ТОЛЬКО JSON-объект по схеме (без markdown, без пояснений):
{
  "slug": "kebab-case, только a-z 0-9 -",
  "displayName": "Название стиля (на языке описания)",
  "persona": { "name": "Имя менеджера", "role": "human" или "assistant", "company": "название (опц.)" },
  "voice": { "tone": "тон (напр. дружелюбный, уверенный)", "language": "ru" или "en", "forbid": ["чего избегать"] },
  "framework": "один из: AIDA, PAS, SPIN, NEPQ, straight_line",
  "hooks": [ { "kind": "один из: social_proof, scarcity, authority, liking, reciprocity, commitment", "text": "формулировка" } ],
  "stages": {
    "opener":    { "goal": "...", "guidance": "..." },
    "qualify":   { "goal": "...", "guidance": "..." },
    "pitch":     { "goal": "...", "guidance": "..." },
    "objection": { "goal": "...", "guidance": "..." },
    "close":     { "goal": "...", "guidance": "..." }
  },
  "fewShot": [ { "user": "реплика клиента", "assistant": "ответ менеджера", "stage": "qualify" } ],
  "guardrails": { "forbiddenTopics": ["..."] }
}
Правила: персона звучит как живой менеджер ИМЕННО этого бизнеса; tone и hooks — под нишу; в stages дай конкретные goal под бизнес; 2-3 few-shot на языке бизнеса. Язык всего — язык описания.

Описание бизнеса:
${description}`;

    let client: ChatClient;
    try {
      client = opts.resolveChat(tenantId);
    } catch {
      return c.json({ error: "LLM not configured for this tenant" }, 503);
    }

    let raw: string;
    try {
      raw = await client.complete([{ role: "user", content: prompt }], {
        numPredict: 1500,
        temperature: 0.5,
      });
    } catch (err) {
      return c.json(
        { error: `LLM error: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
    let parsedJson: Record<string, unknown>;
    try {
      parsedJson = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return c.json({ error: "LLM returned non-JSON response", raw }, 502);
    }

    // Sanitize slug to kebab-case so a near-miss doesn't fail schema validation.
    if (typeof parsedJson.slug === "string") {
      parsedJson.slug = parsedJson.slug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    }

    // Structural containers the prompt doesn't ask for — let StyleSchema fill
    // their inner defaults (model pin, guardrail flags) instead of rejecting.
    if (parsedJson.model == null) parsedJson.model = {};
    if (parsedJson.guardrails == null) parsedJson.guardrails = {};

    const result = StyleSchema.safeParse(parsedJson);
    if (!result.success) {
      return c.json(
        { error: "generated style failed schema validation", issues: result.error.issues.slice(0, 5) },
        502,
      );
    }
    const style = result.data;

    let row: Awaited<ReturnType<StylesRepo["create"]>>;
    try {
      row = await withTenant(opts.db, tenantId, async (tx) => {
        const repo = new StylesRepo({ db: tx, tenantId });
        return repo.create({
          slug: style.slug,
          displayName: style.displayName,
          configJson: JSON.stringify(style),
          isActive: true,
        });
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "active style with this slug already exists" }, 409);
      }
      throw err;
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.generate_full",
      targetKind: "style",
      targetId: row.id,
      details: { slug: style.slug, displayName: style.displayName },
    });

    return c.json({ id: row.id, slug: row.slug, displayName: row.displayName, style }, 201);
  });

  app.get("/api/admin/styles", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new StylesRepo({ db: tx, tenantId });
      return repo.listAll();
    });
    return c.json({ items: rows });
  });

  /**
   * POST /api/admin/styles
   * Body: { displayName, slug, configJson, isActive? }
   */
  app.post("/api/admin/styles", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let body: { displayName?: unknown; slug?: unknown; configJson?: unknown; isActive?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const configJson = typeof body.configJson === "string" ? body.configJson : "{}";
    const isActive = body.isActive !== false;

    if (!displayName) return c.json({ error: "displayName required" }, 400);
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      return c.json({ error: "slug required, only a-z 0-9 _ -" }, 400);
    }

    try {
      JSON.parse(configJson);
    } catch {
      return c.json({ error: "configJson must be valid JSON" }, 400);
    }

    let row: Awaited<ReturnType<StylesRepo["create"]>>;
    try {
      row = await withTenant(opts.db, tenantId, async (tx) => {
        const repo = new StylesRepo({ db: tx, tenantId });
        return repo.create({ slug, displayName, configJson, isActive });
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "style with this slug already exists" }, 409);
      }
      throw err;
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.create",
      targetKind: "style",
      targetId: row.id,
      details: { slug, displayName },
    });

    return c.json(row, 201);
  });

  /**
   * PATCH /api/admin/styles/:id
   * Body: { displayName?, configJson?, isActive? }
   */
  app.patch("/api/admin/styles/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { displayName?: unknown; configJson?: unknown; isActive?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const patch: Parameters<StylesRepo["update"]>[1] = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName.trim();
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
    if (typeof body.configJson === "string") {
      try {
        JSON.parse(body.configJson);
      } catch {
        return c.json({ error: "configJson must be valid JSON" }, 400);
      }
      patch.configJson = body.configJson;
    }

    if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);

    const updated = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new StylesRepo({ db: tx, tenantId });
      return repo.update(id, patch);
    });

    if (!updated) return c.json({ error: "style not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.update",
      targetKind: "style",
      targetId: id,
      details: patch,
    });

    return c.json(updated);
  });

  /**
   * DELETE /api/admin/styles/:id — soft-delete
   */
  app.delete("/api/admin/styles/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const deleted = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new StylesRepo({ db: tx, tenantId });
      return repo.softDelete(id);
    });

    if (!deleted) return c.json({ error: "style not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "style.delete",
      targetKind: "style",
      targetId: id,
      details: {},
    });

    return c.json({ ok: true });
  });

  return app;
}
