// Runtime settings — operator-editable operational knobs (LLM model,
// answer temperature, RAG feature toggles). Persisted to the `.env` file so
// they survive restarts; the running process keeps its boot-time config
// until the service is restarted (the UI states this explicitly).
//
// Deliberately excludes secrets (API keys, bot tokens, userbot session) —
// only operational tuning. The key whitelist below IS the security
// boundary: a request can only read/write keys defined here.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../../config.ts";
import { AuditLogRepo } from "../../db/repos/audit-log.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseJsonBody, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

type SettingType = "text" | "number" | "boolean";

interface SettingSpec {
  key: string;
  label: string;
  hint: string;
  type: SettingType;
  /** Shown when the env var is absent. For booleans: "1" or "0". */
  defaultValue?: string;
}

// Temperature + RAG feature flags — provider-independent. The chat model is
// provider-specific and is prepended per request (see modelSpec).
const TUNABLE_SPECS: readonly SettingSpec[] = [
  {
    key: "RAG_CHAT_TEMPERATURE",
    label: "Температура ответов",
    hint: "0 — сухо и предсказуемо, 1 — живее и разнообразнее. Пусто = по умолчанию.",
    type: "number",
  },
  {
    key: "RAG_USER_MEMORY",
    label: "Память о собеседнике",
    hint: "Бот запоминает факты о кандидате между сессиями и не переспрашивает их.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_QUERY_REWRITE",
    label: "Переформулировка вопросов",
    hint: "Уточняет вопрос перед поиском по базе знаний — лучше понимает «а это?», «там».",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_REFLECT",
    label: "Проверка фактов в ответах",
    hint: "После генерации проверяет, что факты подтверждены базой знаний.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_HYBRID_SEARCH",
    label: "Гибридный поиск",
    hint: "Совмещает смысловой и точный поиск по ключевым словам.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_CONVERSATION_SUMMARY",
    label: "Резюме длинных диалогов",
    hint: "Сжимает старые сообщения в краткое резюме при длинной переписке.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_TOPIC_ROUTING",
    label: "Поиск по темам",
    hint: "Сужает поиск по базе знаний до темы вопроса (виза, оплата, жильё…).",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_BOOKS_PRIORITY",
    label: "Приоритет книг",
    hint: "Сначала ищет по библиотеке книг; при нулевом результате — по всей базе знаний.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "RAG_SKILL_GRADING",
    label: "Оценка навыков ИИ",
    hint: "После каждого ответа ИИ определяет, какие навыки продаж были использованы (для аналитики).",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "VISION_ENABLED",
    label: "Распознавание фото (ИИ)",
    hint: "Классифицирует фото кандидата (паспорт, портрет, полный рост) через модель зрения.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "VISION_ENABLED",
    label: "Распознавание фото (ИИ)",
    hint: "Бот определяет по фото: загранпаспорт / в полный рост / портрет. Выкл — грубая прикидка по числу фото.",
    type: "boolean",
  },
];

/** The chat-model env key depends on the active LLM provider. */
function modelSpec(): SettingSpec {
  const key =
    config.llm.provider === "openrouter"
      ? "OPENROUTER_CHAT_MODEL"
      : config.llm.provider === "ollama"
        ? "OLLAMA_CHAT_MODEL"
        : "OPENAI_CHAT_MODEL";
  return {
    key,
    label: "Модель ИИ",
    hint: `Провайдер: ${config.llm.provider}. Напр. google/gemini-2.5-flash, anthropic/claude-haiku-4.5. Точные ID — на openrouter.ai/models.`,
    type: "text",
  };
}

function allSpecs(): SettingSpec[] {
  return [modelSpec(), ...TUNABLE_SPECS];
}

/** Path to the `.env` file the running process loads. Overridable via
 *  ADMIN_SETTINGS_ENV_FILE (used by tests so they never touch the real one). */
function envFilePath(): string {
  return process.env.ADMIN_SETTINGS_ENV_FILE || resolve(process.cwd(), ".env");
}

/**
 * Coerce a raw request value to the canonical string written to `.env`.
 * Returns an Error (with an operator-readable message) on invalid input.
 * Empty string means "remove the key" — fall back to the code default.
 */
function normalizeValue(spec: SettingSpec, raw: unknown): string | Error {
  if (spec.type === "boolean") {
    if (raw === true || raw === "1" || raw === "true") return "1";
    if (raw === false || raw === "0" || raw === "false" || raw === "") return "0";
    return new Error(`${spec.label}: ожидается «вкл» или «выкл»`);
  }
  if (spec.type === "number") {
    if (raw === "" || raw === null || raw === undefined) return "";
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return new Error(`${spec.label}: ожидается число`);
    if (spec.key === "RAG_CHAT_TEMPERATURE" && (n < 0 || n > 2)) {
      return new Error(`${spec.label}: значение должно быть от 0 до 2`);
    }
    return String(n);
  }
  // text
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.includes("\n") || s.length > 200) {
    return new Error(`${spec.label}: недопустимое значение`);
  }
  return s;
}

/**
 * Rewrite the `.env` file: drop every line whose key is in `updates`, then
 * append the new values. An empty value removes the key entirely. Lines for
 * keys not in `updates` (other env vars, comments) are preserved verbatim.
 */
async function writeEnvUpdates(path: string, updates: Record<string, string>): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  const keys = new Set(Object.keys(updates));
  const kept = existing.split("\n").filter((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    return !(m && keys.has(m[1]!));
  });
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  for (const [k, v] of Object.entries(updates)) {
    if (v !== "") kept.push(`${k}=${v}`);
  }
  await writeFile(path, `${kept.join("\n")}\n`, { mode: 0o600 });
}

/**
 * GET /admin/api/settings/runtime
 * Returns the whitelisted operational settings with their current effective
 * values (read live from process.env) plus the `.env` path being edited.
 */
export function createGetRuntimeSettingsHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async () => {
    const settings = allSpecs().map((s) => ({
      ...s,
      value: process.env[s.key] ?? s.defaultValue ?? "",
    }));
    return json({ env_path: envFilePath(), provider: config.llm.provider, settings });
  });
}

/**
 * PUT /admin/api/settings/runtime  body: { updates: { KEY: value, … } }
 * Validates every key against the whitelist, writes the `.env` file, and
 * mirrors the values into process.env so a re-GET is consistent. The change
 * takes effect for the bot only after a service restart.
 */
export function createUpdateRuntimeSettingsHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, admin }) => {
    const body = await parseJsonBody<{ updates?: unknown }>(req);
    if (body instanceof Response) return body;
    const { updates } = body;
    if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
      return json({ error: "updates must be an object of key→value" }, { status: 400 });
    }

    const byKey = new Map(allSpecs().map((s) => [s.key, s]));
    const sanitized: Record<string, string> = {};
    for (const [key, raw] of Object.entries(updates as Record<string, unknown>)) {
      const spec = byKey.get(key);
      if (!spec) return json({ error: `unknown setting: ${key}` }, { status: 400 });
      const value = normalizeValue(spec, raw);
      if (value instanceof Error) return json({ error: value.message }, { status: 400 });
      sanitized[key] = value;
    }
    if (Object.keys(sanitized).length === 0) {
      return json({ error: "no settings to update" }, { status: 400 });
    }

    try {
      await writeEnvUpdates(envFilePath(), sanitized);
    } catch (err) {
      return json(
        { error: `failed to write .env: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }

    // Mirror into process.env so an immediate re-GET shows the saved values
    // (the bot's own config is still the boot snapshot until a restart).
    for (const [k, v] of Object.entries(sanitized)) {
      if (v === "") delete process.env[k];
      else process.env[k] = v;
    }

    await new AuditLogRepo(deps.sql)
      .write({
        action: "settings.runtime.update",
        adminId: admin.adminId,
        details: { keys: Object.keys(sanitized) },
      })
      .catch((err) => console.error("[audit] settings.runtime.update write failed:", err));

    return json({ ok: true, updated: Object.keys(sanitized), restart_required: true });
  });
}
