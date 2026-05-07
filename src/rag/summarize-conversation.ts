import type { ChatClient, ChatMessage } from "./chat.ts";

/**
 * Compresses old turns of a long conversation into one short paragraph that
 * preserves what nuance the user-facts memory layer can't — what the bot
 * already promised, what the candidate hesitated about, what was already
 * explained vs. left open. Injected into the next system prompt as
 * "ИЗ РАННЕЙ ПЕРЕПИСКИ:" so the LLM has continuity past the 12-message
 * recent-history window.
 *
 * Only the OLD tail is summarized — the recent ~12 messages are still
 * passed to the LLM raw (they fit in the window). Pass them via
 * `messagesToSummarize` (oldest first).
 */
export interface SummarizeInput {
  /** Old messages to compress, oldest first. Caller must already have
   *  trimmed off the recent window — those go into LLM context as-is. */
  messagesToSummarize: ChatMessage[];
  chat: ChatClient;
  /** Existing summary to refine (when refreshing an older summary).
   *  Helps the model preserve what was already known without re-reading
   *  the whole stretch of dialogue. */
  previousSummary?: string;
  /** Hard cap on summary length (chars). Default 600. Past this the
   *  summary is truncated at the last sentence boundary. */
  maxLength?: number;
}

const SYSTEM_PROMPT = `Ты сжимаешь старую часть переписки рекрутингового агентства в одно короткое summary.

Цель: чтобы бот в следующих репликах помнил что уже обсуждалось — что ОБЕЩАЛ, что ОТКЛАДЫВАЛ, в чём кандидат СОМНЕВАЛСЯ, какие условия УЖЕ ПРОЗВУЧАЛИ.

Правила:
1. Один абзац, без буллетов, без markdown, без заголовков. 3-6 коротких предложений.
2. Пиши в третьем лице ("кандидат спросил…", "бот объяснил…").
3. Сохраняй КОНКРЕТИКУ: суммы, страны, даты, обещания. ("обещал прислать договор завтра", "кандидат уточняет про Дубай vs Стамбул")
4. НЕ повторяй имя/возраст/город кандидата — это уже хранится отдельно в memory.facts.
5. Игнорируй смолток ("привет", "ок").
6. Если есть "ПРЕДЫДУЩЕЕ SUMMARY" — обнови его, добавив что нового, удалив отжившее.

Пиши ТОЛЬКО текст summary. Никаких префиксов, кавычек, "Ответ:".`;

export async function summarizeConversation(input: SummarizeInput): Promise<string> {
  if (input.messagesToSummarize.length === 0) return input.previousSummary ?? "";

  const dialogue = input.messagesToSummarize
    .map((m) => `${m.role === "user" ? "кандидат" : "бот"}: ${m.content}`)
    .join("\n");

  const userPrompt = input.previousSummary
    ? `ПРЕДЫДУЩЕЕ SUMMARY:\n${input.previousSummary}\n\nДОПОЛНИТЕЛЬНЫЕ РЕПЛИКИ:\n${dialogue}\n\nОБНОВЛЁННОЕ SUMMARY:`
    : `РЕПЛИКИ:\n${dialogue}\n\nSUMMARY:`;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, { temperature: 0.2 });
  } catch (err) {
    console.error("[summarize] LLM call failed:", err);
    return input.previousSummary ?? "";
  }

  return cleanSummary(raw, input.maxLength ?? 600);
}

/** Strip think-tags / markdown / leading prefixes; cap length at the last
 *  sentence boundary inside the cap. Exported for unit tests. */
export function cleanSummary(raw: string, maxLength: number): string {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  // Strip ONLY the fence delimiters, not the wrapped content — the model
  // sometimes wraps a clean summary in ``` for emphasis, we want the body.
  s = s.replace(/```[a-zA-Z]*\n?/g, "");
  s = s.replace(/^\s*(summary|ответ|answer)\s*[:\-—]\s*/i, "");
  s = s.trim();

  if (s.length <= maxLength) return s;

  // Truncate at the last sentence-ending punctuation inside the cap so we
  // don't end mid-word. Falls back to a hard slice if no punctuation found.
  const head = s.slice(0, maxLength);
  const lastPunct = Math.max(head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?"));
  return lastPunct > maxLength * 0.6 ? head.slice(0, lastPunct + 1) : head;
}
