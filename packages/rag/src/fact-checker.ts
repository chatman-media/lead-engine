import type { ChatClient, ChatMessage } from "./chat.ts";

/**
 * Unified fact-checker — replaces the separate reflect.ts + vacancy-guard.ts
 * pipeline with a single LLM call that checks both:
 *
 *   1. KB grounding: every concrete fact in the answer is supported by the
 *      retrieved KB context (no hallucinations).
 *
 *   2. Vacancy accuracy: any salary/city/condition data matches the
 *      authoritative АКТУАЛЬНЫЕ ВАКАНСИИ block from the DB table.
 *      ВАКАНСИИ always win over KB chunks when they conflict — an old
 *      chat log with a stale salary is not a valid grounding source.
 *
 * Cost: 1 LLM call per turn (was 2 with separate reflect + vacancy-guard).
 *
 * Fail-open: on any LLM or parse error returns { grounded: true, vacancyOk: true }
 * — false negatives (one wasted reply) are cheaper than false positives
 * (silently dropping a legitimate answer).
 */

export interface FactCheckInput {
  question: string;
  answer: string;
  /** KB chunks concatenated — same string passed to the generator. */
  context: string;
  chat: ChatClient;
  /** Optional: rendered АКТУАЛЬНЫЕ ВАКАНСИИ block.
   *  When provided, vacancy facts are checked against it as the authoritative
   *  source. KB chunks that contradict it are treated as outdated. */
  vacanciesBlock?: string;
}

export interface FactCheckResult {
  /** All concrete facts in the answer are found in context (or vacanciesBlock). */
  grounded: boolean;
  /** All vacancy-specific facts (salary, city, conditions) match vacanciesBlock.
   *  Always true when vacanciesBlock was not provided. */
  vacancyOk: boolean;
  /** Human-readable reason when grounded=false or vacancyOk=false. */
  reason?: string;
}

// ── System prompts ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_NO_VACANCIES = `Ты проверяешь ответ бота на галлюцинации.
Тебе дают: ВОПРОС кандидата, КОНТЕКСТ (выдержки из базы знаний), ОТВЕТ бота.

Задача: проверить, что КАЖДЫЙ конкретный факт из ОТВЕТА встречается в КОНТЕКСТЕ.

Правила:
- Общие фразы ("хорошие условия", "напишу подробности"), приветствия, эмоции — НЕ требуют проверки
- Конкретные числа, страны, города, валюты, сроки, % — ДОЛЖНЫ быть в контексте
- "уточню у руководства" / "уточним на созвоне" — ОК, не требует проверки
- Личные факты бота (имя, возраст, город, статус) — НЕ требуют проверки в контексте

Верни СТРОГО JSON одной строкой, без markdown, без \`\`\`:
{"grounded": true, "vacancyOk": true} — если все факты подтверждены или ответ общий
{"grounded": false, "vacancyOk": true, "reason": "<какой факт не из контекста>"} — если есть выдуманное

Только JSON, ничего больше.`;

const SYSTEM_PROMPT_WITH_VACANCIES = `Ты проверяешь ответ бота на два типа ошибок.
Тебе дают: ВОПРОС кандидата, KB-КОНТЕКСТ (выдержки из базы знаний), АКТУАЛЬНЫЕ ВАКАНСИИ (официальный список из БД), ОТВЕТ бота.

ВАЖНО: АКТУАЛЬНЫЕ ВАКАНСИИ имеют приоритет над KB-КОНТЕКСТОМ.
Если KB-чанк содержит устаревшую зарплату/условие, а в АКТУАЛЬНЫХ ВАКАНСИЯХ другое — правы ВАКАНСИИ.

Проверка 1 — KB grounding:
- Все конкретные факты в ОТВЕТЕ (числа, страны, города, валюты, сроки, %) должны быть в KB-КОНТЕКСТЕ или в АКТУАЛЬНЫХ ВАКАНСИЯХ.
- Общие фразы, приветствия, "уточним на созвоне", личные факты бота — НЕ проверяются.

Проверка 2 — Vacancy accuracy (только если ОТВЕТ содержит конкретные данные о вакансиях):
- Суммы заработка, города трудоустройства, условия жилья/перелёта, тип заведения —
  должны совпадать с АКТУАЛЬНЫМИ ВАКАНСИЯМИ.
- Общие фразы ("легальный контракт", "поддержка агентства") — НЕ проверяются.

Верни СТРОГО JSON одной строкой, без markdown, без \`\`\`:
{"grounded": true, "vacancyOk": true} — всё ок
{"grounded": false, "vacancyOk": true, "reason": "..."} — выдуманный факт (не из KB и не из вакансий)
{"grounded": true, "vacancyOk": false, "reason": "..."} — данные вакансии не совпадают с официальным списком
{"grounded": false, "vacancyOk": false, "reason": "..."} — оба нарушения

Только JSON, ничего больше.`;

// ── Main function ───────────────────────────────────────────────────────────

export async function checkFacts(input: FactCheckInput): Promise<FactCheckResult> {
  const OK: FactCheckResult = { grounded: true, vacancyOk: true };

  const trimmed = input.answer.trim();
  if (!trimmed) return OK;

  const hasContext = input.context.trim().length > 0;
  const hasVacancies = (input.vacanciesBlock ?? "").trim().length > 0;

  // Nothing to check against — let it through (generator's own NO_CONTEXT
  // rules are the last line of defense on truly empty turns).
  if (!hasContext && !hasVacancies) return OK;

  const systemPrompt = hasVacancies ? SYSTEM_PROMPT_WITH_VACANCIES : SYSTEM_PROMPT_NO_VACANCIES;

  let userPrompt: string;
  if (hasVacancies) {
    userPrompt =
      `ВОПРОС: ${input.question}\n\n` +
      `KB-КОНТЕКСТ:\n${input.context || "(пусто)"}\n\n` +
      `АКТУАЛЬНЫЕ ВАКАНСИИ:\n${input.vacanciesBlock}\n\n` +
      `ОТВЕТ: ${trimmed}\n\nJSON:`;
  } else {
    userPrompt = `ВОПРОС: ${input.question}\n\nКОНТЕКСТ:\n${input.context}\n\nОТВЕТ: ${trimmed}\n\nJSON:`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, { temperature: 0.0 });
  } catch (err) {
    console.error("[fact-checker] LLM call failed; treating as ok:", err);
    return OK;
  }

  return parseFactCheckResult(raw);
}

/** Exported for unit tests. */
export function parseFactCheckResult(raw: string): FactCheckResult {
  const OK: FactCheckResult = { grounded: true, vacancyOk: true };

  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return OK;

  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return OK;
  }

  if (typeof parsed !== "object" || parsed === null) return OK;
  const obj = parsed as Record<string, unknown>;

  const grounded = typeof obj.grounded === "boolean" ? obj.grounded : true;
  const vacancyOk = typeof obj.vacancyOk === "boolean" ? obj.vacancyOk : true;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;

  return { grounded, vacancyOk, ...(reason ? { reason } : {}) };
}
