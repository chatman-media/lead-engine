import type { ChatClient, ChatMessage } from "./chat.ts";

/**
 * Rewrites a user question into a search-friendly query using recent
 * conversation history. Resolves pronouns ("это", "там", "то"), expands
 * elliptical follow-ups ("а сколько платят?" → "сколько платят моделям в
 * Дубае"), and folds in named entities from prior turns.
 *
 * Why this matters: vector search on the raw user message misses precision
 * on follow-ups because embeddings of "а в дубае?" sit nowhere near the
 * actual KB chunks about Dubai contracts. Rewriting bridges that gap.
 */
export interface RewriteQueryInput {
  question: string;
  /** Recent dialog (oldest first), excluding the current question. */
  history?: ChatMessage[];
  chat: ChatClient;
  /** Cap output length to avoid the model writing essays. Default 200 chars. */
  maxLength?: number;
}

const SYSTEM_PROMPT = `Ты переформулируешь вопрос кандидата в самостоятельный поисковый запрос для базы знаний.

Правила:
1. Раскрывай местоимения и эллипсисы по контексту истории ("а там?" → "а в Дубае какие условия?")
2. Сохраняй ВСЕ ключевые сущности из вопроса и недавней истории (страна, город, сумма, тема)
3. Никаких вступлений, никакого markdown — ТОЛЬКО переформулированный запрос одной строкой
4. Если вопрос и так самостоятельный и ясный — верни его без изменений
5. Если вопрос вообще не про работу/услуги/факты (только смолток типа "привет"/"как дела") — верни его как есть
6. Не отвечай на вопрос, не давай советов — только переформулируй

Примеры:
история: ассистент: в дубае платят 1500 в день, контракт 30 дней
вопрос: а в стамбуле?
ответ: какие условия и оплата в стамбуле

история: ассистент: контракты бывают на 30, 60 и 90 дней
вопрос: а виза как?
ответ: как оформляется виза для работы по контракту

вопрос: сколько платят моделям в дубае?
ответ: сколько платят моделям в дубае?`;

/**
 * Heuristic: skip rewriting when the question is already self-contained.
 * Saves an LLM call (and thus latency + $) on the majority of inbound
 * messages which are full standalone questions, not follow-ups.
 */
export function questionNeedsRewrite(question: string, history?: ChatMessage[]): boolean {
  const trimmed = question.trim();
  if (!trimmed) return false;

  // No history → no pronouns to resolve, no ellipsis to expand. Even ambiguous
  // single-word messages can't be rewritten meaningfully without context.
  if (!history || history.length === 0) return false;

  // Very short (likely follow-up) or contains common deictic markers
  // pointing back to prior turns.
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 4) return true;

  // JS `\b` is ASCII-only — silently fails on Cyrillic. Use Unicode-property
  // boundaries instead, same trick as stage-router.ts and elsewhere.
  const deictic =
    /(?<![\p{L}\p{N}])(это|этот|эта|эти|тот|та|те|там|туда|оттуда|такой|такая|такие|тогда|оно|он|она|они)(?![\p{L}\p{N}])/iu;
  if (deictic.test(trimmed)) return true;

  // Starts with a follow-up conjunction.
  const followUp = /^(а|и|но|или|ещё|еще|тоже)(?![\p{L}\p{N}])/iu;
  if (followUp.test(trimmed)) return true;

  return false;
}

export async function rewriteQuery(input: RewriteQueryInput): Promise<string> {
  const original = input.question.trim();
  if (!original) return original;

  // Skip work when there's nothing to disambiguate. Saves ~80% of LLM calls
  // in production on full-question messages (per typical chat distribution).
  if (!questionNeedsRewrite(original, input.history)) return original;

  // Compose a compact history snippet — only the last 6 messages, otherwise
  // we feed the whole conversation into a "rewrite" call which defeats the
  // latency goal.
  const tail = (input.history ?? []).slice(-6);
  const historyText = tail.map((m) => `${m.role}: ${m.content}`).join("\n");
  const userPrompt =
    historyText.length > 0
      ? `история:\n${historyText}\n\nвопрос: ${original}\nответ:`
      : `вопрос: ${original}\nответ:`;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, { temperature: 0.1 });
  } catch (err) {
    console.error("[rewrite-query] LLM call failed; using original:", err);
    return original;
  }

  return sanitizeRewritten(raw, original, input.maxLength ?? 200);
}

/** Strips think-tags, "ответ:" prefixes, markdown, line breaks. Falls back
 *  to original on empty/garbage output. Exported for unit tests. */
export function sanitizeRewritten(raw: string, fallback: string, maxLength: number): string {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/^\s*(ответ|answer)\s*[:\-—]\s*/i, "");
  // Take first non-empty line — the model occasionally adds explanations after.
  const firstLine = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return fallback;
  const trimmed = firstLine.length > maxLength ? firstLine.slice(0, maxLength) : firstLine;
  return trimmed || fallback;
}
