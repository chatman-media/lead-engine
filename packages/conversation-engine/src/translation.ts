// Переводящий слой оператору (#731). Инкапсулирует LLM-перевод через
// инжектируемый ChatClient. Два направления, оба гейтятся по effectiveLang
// диалога: клиент→оператор (язык клиента → русский для показа оператору) и
// оператор→клиент (русский ответ оператора → язык клиента перед отправкой).
//
// ИНВАРИАНТ: перевод — это LLM-вызов; его НЕЛЬЗЯ запускать внутри withTenant
// (split-transaction, AGENTS.md). Все вызовы происходят вне tx.

import type { ChatClient } from "@chatman-media/llm-router";
import type { Lang } from "./language.ts";
import { buildTranslationSystemPrompt } from "./prompts/translation.ts";

/** Язык, на котором работает оператор (видит входящие, пишет ответы). v1 — русский. */
export const OPERATOR_LANG: Lang = "ru";

/** Нужен ли перевод между языками. Равны (в т.ч. оба ru) → нет. */
export function needsTranslation(src: Lang, dst: Lang): boolean {
  return src !== dst;
}

/** Бюджет токенов на перевод: соразмерен входу, CJK↔кириллица может раздуть. */
function translationTokenBudget(text: string): number {
  return Math.min(2048, Math.max(128, Math.ceil(text.length * 1.5)));
}

/**
 * Переводит текст на targetLang через LLM. Пустой/пробельный текст (медиа-only
 * сообщение) возвращает как есть. Ошибка LLM → возвращает ОРИГИНАЛ и зовёт
 * onWarn: перевод никогда не роняет основной флоу диалога.
 */
export async function translateText(opts: {
  chat: ChatClient;
  text: string;
  targetLang: Lang;
  onWarn?: (msg: string) => void;
}): Promise<string> {
  const raw = opts.text ?? "";
  if (!raw.trim()) return raw;
  try {
    const out = await opts.chat.complete(
      [
        { role: "system", content: buildTranslationSystemPrompt(opts.targetLang) },
        { role: "user", content: raw },
      ],
      { temperature: 0, numPredict: translationTokenBudget(raw) },
    );
    const trimmed = (out ?? "").trim();
    return trimmed || raw;
  } catch (err) {
    opts.onWarn?.(`[translation] failed → returning original: ${String(err)}`);
    return raw;
  }
}
