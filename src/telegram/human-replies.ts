/**
 * Human-sounding Telegram fallbacks. Tone calibrated against the real-agent
 * corpus in `kb/extracted/dialogs/` — recruiters there are concise, neutral,
 * and slightly formal ("Здравствуйте", "Минуту", "Сейчас уточню", "Хорошо").
 *
 * Strict no-go:
 *   - «бот», «ассистент», «ИИ», «оператор», «коллега передаст» — break the
 *     human-manager illusion the persona depends on.
 *   - Cutesy/girly turns of phrase ("щас дорисую", "не теряла", "минуточку
 *     совсем") that don't appear in the real-agent corpus.
 *   - Em-dashes / non-breaking hyphens trying to look "natural" but actually
 *     read as written-by-AI.
 */

/**
 * Variant pool for first-time stall / NO_CONTEXT / explicit escalation triggers.
 * The candidate has just said something we can't answer cleanly — buy time
 * and signal that a real check is happening.
 */
export const ESCALATION_REPLIES = [
  "Секунду, уточню по этому вопросу и напишу.",
  "Минуту, проверю детали — отвечу.",
  "Сейчас посмотрю и вернусь с ответом.",
  "Минуту, уточняю.",
] as const;

/**
 * Conversation already queued; user pings again. We're alive but still
 * looking — keep it brief, no excuses.
 */
export const QUEUED_REPLIES = [
  "Секунду, я ещё смотрю — отвечу совсем скоро.",
  "Минуту, добиваю ответ.",
  "Уже проверяю, скоро напишу.",
  "На связи, отвечу через минуту.",
] as const;

/**
 * RAG deps missing / dev stub. Vague but not weird — the candidate doesn't
 * need to know an LLM isn't configured.
 */
export const PLACEHOLDER_REPLIES = [
  "Секунду, отвечу через минуту.",
  "Минуту, скоро напишу.",
  "Сейчас отвечу.",
] as const;

/**
 * Background pipeline threw (timeout, embedder, chat, etc.). Ask the
 * candidate to send the message again — covers the case where their text
 * was lost mid-pipeline. Apologetic but professional, never girly.
 */
export const PROCESSING_FAILURE_REPLIES = [
  "Извините, у меня сорвался ответ. Повторите, пожалуйста, вопрос.",
  "Простите, что-то с отправкой. Напишите ещё раз — я отвечу.",
  "Сорвалось сообщение, прошу прощения. Можете продублировать вопрос?",
] as const;

/**
 * Picks one phrase deterministically per (conversation, inbound text) so the
 * same retry of the same message produces the same line, but different
 * conversations get different phrases. This avoids one canned line repeating
 * across the board while keeping idempotency on retries.
 *
 * Implementation: Knuth-multiplicative integer hash with `Math.imul` for
 * well-defined 32-bit multiplication (plain `*` overflows JS Number above
 * 2^53 and the previous version of this function collapsed all inputs to
 * a single bucket because of that).
 */
export function pickHumanStallPhrase(
  phrases: readonly string[],
  conversationId: number,
  userMessageText: string,
): string {
  const n = phrases.length;
  if (n === 0) return "";
  if (n === 1) return phrases[0]!;

  // Math.imul guarantees 32-bit multiplication that doesn't lose precision.
  // 2654435761 = Knuth's golden-ratio multiplier; 1597334677 is a coprime
  // companion for the final mix step.
  let x = conversationId | 0;
  const t = userMessageText;
  for (let i = 0; i < t.length; i++) {
    x = Math.imul(x ^ t.charCodeAt(i), 2654435761);
  }
  x = Math.imul(x ^ (conversationId << 13), 1597334677);
  // x is signed int32 — convert to unsigned before modulo to avoid a
  // negative remainder (which would crash phrases[-3] === undefined).
  return phrases[(x >>> 0) % n]!;
}
