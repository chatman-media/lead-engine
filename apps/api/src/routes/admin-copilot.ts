import type { Db } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { defaultRegistry } from "@chatman-media/verticals";
import { Hono } from "hono";
import {
  buildAdminCopilotSystemPrompt,
  copilotUnknownPageHint,
  PAGE_HINTS,
} from "../prompts/admin-copilot.ts";
import { FIELD_TYPES, type SeedStage, STAGE_KINDS, STAGE_TYPES } from "./admin-funnel.ts";
import { normalizeStages, type StageDraft } from "./admin-workflow.ts";

/**
 * AI-ассистент админки (copilot). Встроенный чат: отвечает по данным текущей
 * страницы и помогает с настройкой кабинета (онбординг, выбор/сборка воронки).
 *
 * BYOK: использует chat-LLM тенанта через `resolveChat`. Если он не настроен —
 * 503 `llm_not_configured` (UI по этому коду показывает подсказку настроить LLM).
 *
 *   POST /api/admin/copilot/chat — один ход диалога.
 *
 * Принцип «советы + действия с подтверждением»: эндпоинт ТОЛЬКО читает и
 * ПРЕДЛАГАЕТ действие (install_vertical / build_funnel / navigate). Сам ничего
 * НЕ пишет в БД — запись делает клиент через существующие, уже аудируемые
 * эндпоинты (`/verticals/:slug/install`, `/workflows/apply`) по подтверждению.
 */

export interface AdminCopilotRoutesOpts {
  db: Db;
  /** Tenant chat LLM (BYOK). Отсутствует/бросает → /chat вернёт 503. */
  resolveChat?: (tenantId: number) => ChatClient;
}

type ChatTurn = { role: "user" | "assistant"; content: string };

const MAX_TURNS = 40;
const PER_MESSAGE_CAP = 4000;
const CONTEXT_CAP = 6000;

function buildSystemPrompt(page: string, contextJson: string | null): string {
  const pageHint = PAGE_HINTS[page] ?? copilotUnknownPageHint(page);
  return buildAdminCopilotSystemPrompt({
    pageHint,
    contextJson,
    stageKinds: STAGE_KINDS,
    stageTypes: STAGE_TYPES,
    fieldTypes: FIELD_TYPES,
  });
}

// ── Валидация предложенного действия (allowlist) ────────────────────────────

interface FunnelPreviewStage {
  slug: string;
  displayName: string;
  kind: string;
  stageType: string;
  supportMode: boolean;
  nextStages: string[];
  fields: Array<{
    slug: string;
    displayName: string;
    fieldType: string;
    required: boolean;
    aiExtractable: boolean;
  }>;
}

export type CopilotAction =
  | { type: "install_vertical"; slug: string; displayName: string }
  | { type: "build_funnel"; stages: SeedStage[]; preview: FunnelPreviewStage[] }
  | { type: "navigate"; to?: string; step?: number };

function toPreview(stages: SeedStage[]): FunnelPreviewStage[] {
  return stages.map((s) => ({
    slug: s.slug,
    displayName: s.displayName,
    kind: s.kind,
    stageType: s.stageType,
    supportMode: s.supportMode ?? false,
    nextStages: s.nextStages,
    fields: s.fields.map((f) => ({
      slug: f.slug,
      displayName: f.displayName,
      fieldType: f.fieldType,
      required: f.required,
      aiExtractable: f.aiExtractable,
    })),
  }));
}

/**
 * Нормализует и валидирует action от LLM. Клиенту НЕ доверяем — install_vertical
 * проверяется по реестру вертикалей, build_funnel прогоняется через
 * normalizeStages (тот же путь, что AI Workflow Builder). Возвращает null если
 * действие невалидно/отсутствует — UI просто покажет reply.
 */
function validateAction(raw: unknown): CopilotAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "install_vertical": {
      if (typeof a.slug !== "string") return null;
      const tpl = defaultRegistry.tryLoad(a.slug);
      if (!tpl) return null;
      return { type: "install_vertical", slug: a.slug, displayName: tpl.displayName ?? a.slug };
    }
    case "build_funnel": {
      if (!Array.isArray(a.stages)) return null;
      const stages = normalizeStages(a.stages as StageDraft[]);
      if (stages.length === 0) return null;
      return { type: "build_funnel", stages, preview: toPreview(stages) };
    }
    case "navigate": {
      const out: { type: "navigate"; to?: string; step?: number } = { type: "navigate" };
      if (typeof a.to === "string") out.to = a.to.slice(0, 128);
      if (typeof a.step === "number" && Number.isFinite(a.step)) out.step = a.step;
      if (out.to === undefined && out.step === undefined) return null;
      return out;
    }
    default:
      return null;
  }
}

// ── Route factory ───────────────────────────────────────────────────────────

export function makeAdminCopilotRoutes(opts: AdminCopilotRoutesOpts): Hono {
  const app = new Hono();

  /**
   * POST /api/admin/copilot/chat
   * Body: { page: string, context?: object, messages: Array<{role,content}> }
   * Returns: { reply: string, action: CopilotAction | null }
   */
  app.post("/api/admin/copilot/chat", async (c) => {
    if (!opts.resolveChat) {
      return c.json({ error: "llm_not_configured" }, 503);
    }
    const tenantId = c.var.tenantId;

    let body: { page?: unknown; context?: unknown; messages?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const page = typeof body.page === "string" ? body.page.slice(0, 64) : "unknown";

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: "messages array required" }, 400);
    }
    const turns: ChatTurn[] = [];
    for (const m of body.messages as Array<{ role?: unknown; content?: unknown }>) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
        turns.push({ role: m.role, content: m.content.slice(0, PER_MESSAGE_CAP) });
      }
    }
    if (turns.length === 0) return c.json({ error: "no valid messages" }, 400);
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);

    let contextJson: string | null = null;
    if (body.context && typeof body.context === "object") {
      try {
        contextJson = JSON.stringify(body.context).slice(0, CONTEXT_CAP);
      } catch {
        contextJson = null;
      }
    }

    let client: ChatClient;
    try {
      client = opts.resolveChat(tenantId);
    } catch {
      return c.json({ error: "llm_not_configured" }, 503);
    }

    const llmMessages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(page, contextJson) },
      ...turns.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
    ];

    let raw: string;
    try {
      raw = await client.complete(llmMessages, { numPredict: 2000, temperature: 0.5 });
    } catch (err) {
      return c.json(
        { error: `LLM error: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
    let parsed: { reply?: unknown; action?: unknown };
    try {
      parsed = JSON.parse(jsonStr) as typeof parsed;
    } catch {
      // LLM не вернул JSON — отдаём текст как реплику, без действия.
      return c.json({ reply: raw.trim(), action: null });
    }

    const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply : raw.trim();
    const action = validateAction(parsed.action);
    return c.json({ reply, action });
  });

  return app;
}
