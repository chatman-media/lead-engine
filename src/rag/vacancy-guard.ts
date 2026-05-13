import type { ChatClient, ChatMessage } from "./chat.ts";

/**
 * Vacancy Guard — второй слой валидации после reflect.ts.
 *
 * reflect.ts проверяет что все факты из KB-контекста (чанки). Но KB содержит
 * старые переписки и посты с устаревшими данными — бот может процитировать
 * правильный KB-чанк, но неправильную вакансию.
 *
 * Этот guard проверяет строже: любые конкретные данные о вакансиях (зарплата,
 * страна, город, условия жилья, перелёт, оклад) должны буквально присутствовать
 * в АКТУАЛЬНЫЕ ВАКАНСИИ — официальном блоке из таблицы vacancies.
 *
 * Если vacanciesBlock пустой — guard пропускает (нечего проверять).
 * Если в ответе нет никаких данных о вакансиях — guard пропускает.
 */

export interface VacancyGuardInput {
  answer: string;
  /** Rendered АКТУАЛЬНЫЕ ВАКАНСИИ block from VacanciesRepo. */
  vacanciesBlock: string;
  chat: ChatClient;
}

export interface VacancyGuardResult {
  ok: boolean;
  reason?: string;
}

const SYSTEM_PROMPT = `Ты — контролёр точности данных о вакансиях.

Тебе дают: ОТВЕТ бота кандидату и АКТУАЛЬНЫЕ ВАКАНСИИ (официальный список).

Задача: проверить, что все конкретные факты о вакансиях в ОТВЕТЕ соответствуют АКТУАЛЬНЫМ ВАКАНСИЯМ.

Что проверять (только если ОТВЕТ содержит конкретные данные):
- Суммы заработка (числа + валюта: $, ₩, юань, рубль)
- Страны и города трудоустройства
- Условия жилья (бесплатно / платно / сумма)
- Условия перелёта (за счёт агентства / кредитуется / платно)
- Оклад, процент, чаевые — конкретные цифры
- Название типа заведения (KTV, хостес, массаж и т.д.)

НЕ проверять:
- Общие фразы ("хорошие условия", "легальный контракт", "поддержка агентства")
- Обещания уточнить ("уточним на созвоне", "скину детали")
- Личные факты бота (имя, возраст)
- Если в ОТВЕТЕ вообще нет конкретных данных о вакансиях

Верни СТРОГО JSON одной строкой, без markdown, без \`\`\`:
{"ok": true} — если все данные совпадают с АКТУАЛЬНЫМИ ВАКАНСИЯМИ (или данных о вакансиях нет)
{"ok": false, "reason": "<какой именно факт не совпадает и что правильно>"} — если есть расхождение

Только JSON, ничего больше.`;

export async function checkVacancyFacts(input: VacancyGuardInput): Promise<VacancyGuardResult> {
  const { answer, vacanciesBlock, chat } = input;

  // Если нечего проверять — пропускаем
  if (!vacanciesBlock.trim() || !answer.trim()) return { ok: true };

  const userPrompt = `АКТУАЛЬНЫЕ ВАКАНСИИ:\n${vacanciesBlock}\n\nОТВЕТ БОТА:\n${answer.trim()}\n\nJSON:`;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await chat.complete(messages, { temperature: 0.0 });
  } catch (err) {
    // Fail open — guard failure should never block the bot
    console.error("[vacancy-guard] LLM call failed; passing answer through:", err);
    return { ok: true };
  }

  return parseGuardResult(raw);
}

/** Exported for unit tests. */
export function parseGuardResult(raw: string): VacancyGuardResult {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { ok: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { ok: true };
  }

  if (typeof parsed !== "object" || parsed === null) return { ok: true };
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") return { ok: true };
  if (obj.ok) return { ok: true };
  const reason = typeof obj.reason === "string" ? obj.reason : "vacancy data mismatch";
  return { ok: false, reason };
}
