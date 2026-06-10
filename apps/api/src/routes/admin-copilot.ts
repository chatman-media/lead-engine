import type { Db } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { defaultRegistry } from "@chatman-media/verticals";
import { Hono } from "hono";
import type { SeedStage } from "./admin-funnel.ts";
import { normalizeStages, type StageDraft } from "./admin-workflow.ts";
import { buildCopilotBuildFunnelActionPrompt } from "./funnel-builder-prompt.ts";

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

/** Краткая подсказка ассистенту по текущей странице. */
const PAGE_HINTS: Record<string, string> = {
  onboarding:
    "Пользователь проходит первичную настройку (онбординг). Помоги выбрать готовую воронку " +
    "(вертикаль) или собрать свою, объясни шаги: канал → LLM-провайдер → база знаний. Если в " +
    "данных видно, что chat-LLM ещё не настроен — подскажи настроить его на шаге «Провайдер».",
  dashboard:
    "Главная панель: метрики лидов, диалогов, воронки. Объясняй цифры и предлагай следующие шаги.",
  leads: "Страница лидов. Помогай разбираться в списке лидов, их стадиях и полях.",
  funnel: "Конструктор воронки (стадии и поля). Можешь предложить собрать или переработать воронку.",
  conversations: "Диалоги с клиентами. Помогай анализировать переписку и стадии.",
  exchange: "Настройки обменника: курсы и реквизиты. Помогай по данным страницы.",
  channels: "Каналы (Telegram/WhatsApp/web). Помогай с подключением и статусами.",
  settings: "Настройки LLM-провайдеров. Помогай выбрать модель и параметры.",
  outreach: "Рассылки по лидам: кампании и шаблоны сообщений. Помогай готовить и анализировать рассылку.",
  vacancies: "Каталог (вакансии/товары/услуги). Помогай разбираться в позициях каталога.",
  skills: "Навыки бота — переиспользуемые фрагменты поведения. Объясняй и предлагай улучшения.",
  hooks: "Director-хуки — точечные скрипты убеждения. Помогай формулировать и проверять.",
  styles: "Стили продаж (тон и манера ответов). Помогай выбрать и настроить.",
  experiments: "A/B-эксперименты над стилями. Помогай интерпретировать результаты.",
  test: "Тест-бот — прогон диалога без реальной отправки. Помогай составить сценарий проверки.",
  notifications: "Уведомления оператора. Помогай настроить триггеры и каналы доставки.",
  webhooks: "Stage-вебхуки — POST при смене стадии. Помогай настроить интеграцию.",
  tools: "Агентные инструменты бота (booking и т.п.). Помогай включить и настроить.",
  referral: "Партнёрская/реферальная программа. Помогай по ссылкам и начислениям.",
  audit: "Журнал аудита действий. Помогай искать и интерпретировать события.",
  team: "Команда (админы, приглашения, роли). Помогай с управлением доступом.",
  billing: "Использование LLM и тариф. Объясняй расход и лимиты плана.",
  diagnostics: "Диагностика подсистем (LLM/каналы/БД). Помогай прочитать статусы и починить.",
  superadmin: "Платформенная панель аккаунтов (суперадмин). Помогай по тенантам.",
};

export function buildCopilotSystemPrompt(page: string, contextJson: string | null): string {
  const pageHint = PAGE_HINTS[page] ?? `Текущая страница админки: «${page}».`;
  return `Ты — встроенный AI-ассистент SaaS-платформы lead-engine (админка бота-продавца).
Помогаешь оператору: отвечаешь на вопросы ПО ДАННЫМ ТЕКУЩЕЙ СТРАНИЦЫ и помогаешь настроить кабинет.
Отвечай кратко, по-деловому, на языке оператора (по умолчанию русский).

КОНТЕКСТ СТРАНИЦЫ: ${pageHint}
${contextJson ? `ДАННЫЕ СТРАНИЦЫ (JSON, может быть обрезан):\n${contextJson}` : "Данные страницы не переданы."}

ФОРМАТ ОТВЕТА: всегда возвращай ТОЛЬКО JSON-объект (без markdown, без префиксов):
{ "reply": "ответ оператору", "action": <действие или null> }

ДЕЙСТВИЕ (action) добавляй ТОЛЬКО когда оператор явно хочет что-то сделать или это очевидно полезно;
иначе "action": null и просто отвечай в "reply". Доступные действия:

1) Установить готовую воронку (вертикаль) — slug бери из списка доступных вертикалей в данных страницы:
   { "type": "install_vertical", "slug": "<slug>" }

${buildCopilotBuildFunnelActionPrompt()}

3) Перейти/подсказать шаг (без записи):
   { "type": "navigate", "to": "/funnel" }  или  { "type": "navigate", "step": 1 }

Не выдумывай данные, которых нет в контексте. Если информации не хватает — задай уточняющий вопрос.`;
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
      { role: "system", content: buildCopilotSystemPrompt(page, contextJson) },
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
