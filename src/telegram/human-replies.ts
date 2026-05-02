/**
 * Human-sounding Telegram fallbacks — must never read like a chatbot /
 * ticketing system / "AI assistant". No «бот», «ассистент», «ИИ», «оператор»,
 * «коллега передаст», tech jargon.
 */

/** Variant pool for first-time stall / NO_CONTEXT / explicit escalation triggers. */
export const ESCALATION_REPLIES = [
  "Секунду, уточню по этому вопросу и напишу.",
  "Дай минуту — проверю детали, не хочу наугад говорить. Скоро отвечу.",
  "Ок, щас посмотрю и допишу, что по факту.",
  "Минутку, хочу глянуть по своим записи — чтобы ничего не перепутать.",
] as const;

/** Conversation already queued; user pings again — still alive, casual. */
export const QUEUED_REPLIES = [
  "Секунду, я ещё смотрю — отвечу совсем скоро.",
  "Я тут, чуть затянулась — уже добиваю.",
  "Не теряла, щас дорисую ответ по твоей теме.",
  "Подожди чуть‑чуть, уже почти отправлю текст.",
  "На связи, минуточку совсем.",
] as const;

/** RAG deps missing / dev stub — vague, nobody says "configured" or "model". */
export const PLACEHOLDER_REPLIES = [
  "Секунду, отвечу через минуту.",
  "Минуту не пропадай — сейчас допишу.",
  "Чуть занята, уже скоро отвечу.",
] as const;

/** Background pipeline threw (timeout, embedder, chat, etc.). */
export const PROCESSING_FAILURE_REPLIES = [
  "Кажется, последнее сообщение не долетело. Скинь тот же текст ещё раз — я здесь.",
  "У меня тут отправка заглючила минутку. Напиши ещё раз коротко, что хотел узнать.",
  "Что‑то второе сообщение не ушло как надо — повтори, пожалуйста.",
  "Связь дернулась, извини. Можешь дубльнуть тот же вопрос когда удобно?",
] as const;

/**
 * Picks one phrase deterministically per (conversation, inbound text)
 * so the chat doesn't repeat one canned line forever, stays stable across retries.
 */
export function pickHumanStallPhrase(
  phrases: readonly string[],
  conversationId: number,
  userMessageText: string,
): string {
  const n = phrases.length;
  if (n <= 1) return phrases[0] ?? "";

  let x = conversationId >>> 0;
  const t = userMessageText;
  for (let i = 0; i < t.length; i++) {
    x = ((x ^ t.charCodeAt(i)) >>> 0) * 2654435761;
  }
  x = (((x >>> 0) ^ (conversationId << 13)) >>> 0) * 1597334677;
  return phrases[(x >>> 0) % n]!;
}
