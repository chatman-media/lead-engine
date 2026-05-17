/**
 * Detects whether a user message contains an explicit request to be handed off
 * to a human operator. Matches whole-word triggers in Russian and English so we
 * don't false-positive on "humanitarian", "operating system", "оперативно" etc.
 */
const TRIGGER_RE =
  /(^|[^\p{L}])(operator|human|оператор[а-яё]*|человек[а-яё]*|менеджер[а-яё]*)([^\p{L}]|$)/iu;

export function containsEscalationTrigger(text: string): boolean {
  if (!text) return false;
  return TRIGGER_RE.test(text);
}
