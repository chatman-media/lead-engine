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
import { fetchOpenRouterCredits } from "../../openrouter/credits.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseJsonBody, withSuperadmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

type SettingType = "text" | "number" | "boolean";

interface SettingSpec {
  key: string;
  label: string;
  hint: string;
  type: SettingType;
  /** Shown when the env var is absent. For booleans: "1" or "0". */
  defaultValue?: string;
  /** Credential (API key / token). The real value is never returned by
   *  GET — only a masked preview — and an empty value on PUT means "keep
   *  the existing one" instead of "delete". */
  secret?: boolean;
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
    key: "VISION_ENABLED",
    label: "Распознавание фото (ИИ)",
    hint: "Бот определяет по фото: загранпаспорт / в полный рост / портрет. Выкл — грубая прикидка по числу фото.",
    type: "boolean",
    defaultValue: "1",
  },
  {
    key: "LEADS_CHAT_ID",
    label: "Чат для лидов (Telegram)",
    hint: "ID группы, куда бот постит карточки новых лидов с кнопками «Одобрить/Отклонить». Добавьте бота в группу. Узнать ID: перешлите сообщение из группы боту @userinfobot. Пусто — карточки только в админке.",
    type: "text",
  },
  {
    key: "VISA_CHAT_ID",
    label: "Чат для виз (Telegram)",
    hint: "ID группы, куда бот публикует пакет документов при передаче лида на визу. Может совпадать с чатом для лидов. Пусто — пакет только в админке.",
    type: "text",
  },
];

// API-ключи и токены. Редактируются из UI, но GET никогда не возвращает
// само значение — только маску. Пустое значение на PUT = «оставить как
// есть». ADMIN_TG_USER_ID — обычный (несекретный) идентификатор.
const CREDENTIAL_SPECS: readonly SettingSpec[] = [
  {
    key: "OPENROUTER_API_KEY",
    label: "Ключ OpenRouter",
    hint: "API-ключ с openrouter.ai/keys. Через него идут платные ответы ИИ.",
    type: "text",
    secret: true,
  },
  {
    key: "OPENAI_API_KEY",
    label: "Ключ OpenAI",
    hint: "API-ключ OpenAI (если провайдер — openai, либо для эмбеддингов).",
    type: "text",
    secret: true,
  },
  {
    key: "EMBED_API_KEY",
    label: "Ключ для эмбеддингов",
    hint: "Отдельный ключ для векторного поиска. Пусто — используется ключ OpenAI.",
    type: "text",
    secret: true,
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    label: "Токен Telegram-бота",
    hint: "Токен от @BotFather. Меняется при пересоздании бота.",
    type: "text",
    secret: true,
  },
  {
    key: "TELEGRAM_WEBHOOK_SECRET",
    label: "Секрет вебхука Telegram",
    hint: "Секретная строка в адресе вебхука. После смены заново привяжите вебхук.",
    type: "text",
    secret: true,
  },
  {
    key: "TELEGRAM_API_ID",
    label: "Userbot: API ID",
    hint: "С my.telegram.org. Нужен только в режиме userbot (личный аккаунт).",
    type: "text",
    secret: true,
  },
  {
    key: "TELEGRAM_API_HASH",
    label: "Userbot: API Hash",
    hint: "С my.telegram.org. Нужен только в режиме userbot (личный аккаунт).",
    type: "text",
    secret: true,
  },
  {
    key: "ADMIN_TG_USER_ID",
    label: "Telegram ID оператора",
    hint: "Кому слать уведомления (низкий баланс, новые вопросы). Узнать: @userinfobot.",
    type: "text",
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
  return [modelSpec(), ...TUNABLE_SPECS, ...CREDENTIAL_SPECS];
}

/** Masked preview of a secret — last 4 chars, the rest as bullets.
 *  Never reveals enough to reconstruct the key. */
function maskSecret(raw: string): string {
  if (!raw) return "";
  return raw.length <= 4 ? "••••" : `••••${raw.slice(-4)}`;
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
  // text — secrets get a larger budget (some API keys are long)
  const s = typeof raw === "string" ? raw.trim() : "";
  const maxLen = spec.secret ? 500 : 200;
  if (s.includes("\n") || s.length > maxLen) {
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
  return withSuperadmin(deps.sql, async () => {
    const settings = allSpecs().map((s) => {
      const raw = process.env[s.key] ?? "";
      // Secrets: never echo the value back — only whether one is set and
      // a masked tail so the operator can recognise it.
      if (s.secret) {
        return { ...s, value: "", configured: raw !== "", preview: maskSecret(raw) };
      }
      return { ...s, value: raw || s.defaultValue || "" };
    });
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
  return withSuperadmin(deps.sql, async ({ req, admin }) => {
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
      // Empty secret = "keep the current one" — the UI never has the real
      // value to send back, so a blank field must not wipe the key.
      if (spec.secret && (raw === "" || raw === null || raw === undefined)) continue;
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

/**
 * POST /admin/api/settings/validate-key  body: { key, value }
 * Probes a credential against its provider WITHOUT saving it, so the
 * operator gets immediate "key works / doesn't" feedback before applying.
 * Supported: OPENROUTER_API_KEY, OPENAI_API_KEY, EMBED_API_KEY,
 * TELEGRAM_BOT_TOKEN. Always returns 200 with `{ ok, detail }` for a
 * clean probe result; 400 only on a malformed request.
 */
export function createValidateKeyHandler(deps: AdminApiDeps): RouteHandler {
  return withSuperadmin(deps.sql, async ({ req }) => {
    const body = await parseJsonBody<{ key?: unknown; value?: unknown }>(req);
    if (body instanceof Response) return body;
    const key = typeof body.key === "string" ? body.key : "";
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!value) {
      return json({ ok: false, detail: "Введите ключ для проверки" }, { status: 400 });
    }

    try {
      if (key === "OPENROUTER_API_KEY") {
        const c = await fetchOpenRouterCredits({
          apiKey: value,
          baseUrl: config.openrouter.baseUrl,
        });
        return json({ ok: true, detail: `Ключ рабочий. Остаток: $${c.remaining.toFixed(2)}` });
      }
      if (key === "OPENAI_API_KEY" || key === "EMBED_API_KEY") {
        const base = config.openai.baseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${value}` },
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok
          ? json({ ok: true, detail: "Ключ рабочий" })
          : json({ ok: false, detail: `Провайдер ответил HTTP ${res.status}` });
      }
      if (key === "TELEGRAM_BOT_TOKEN") {
        const res = await fetch(`https://api.telegram.org/bot${value}/getMe`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
        return data.ok
          ? json({ ok: true, detail: `Бот рабочий: @${data.result?.username ?? "?"}` })
          : json({ ok: false, detail: "Токен недействителен" });
      }
      return json({ ok: false, detail: "Проверка для этого поля недоступна" }, { status: 400 });
    } catch (err) {
      return json({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
