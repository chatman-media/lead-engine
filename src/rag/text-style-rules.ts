/**
 * Post-processing rules for LLM output — the tg-chatbot analog of "skills":
 * small, named, composable text transforms that run after the model returns.
 * Each one targets a specific "AI tell" that breaks the human-manager
 * illusion (the candidate must believe they're talking to a real recruiter,
 * not a chatbot — see persona role="human" in `buildSystemPrompt`).
 *
 * Adding a new rule:
 *   1. Define it as `TextStyleRule` (name + description + apply function).
 *   2. Append it to `DEFAULT_STYLE_RULES` (or a style-specific bundle).
 *   3. Add a unit test in `tests/unit/text-style-rules.test.ts`.
 *
 * Rules MUST be:
 *   - idempotent (`rule(rule(x)) === rule(x)`) so re-application is safe;
 *   - pure (same input → same output, no I/O, no global state);
 *   - cheap (sub-ms on a 1 KB string; we run the whole stack on every reply).
 *
 * Negative-instruction-in-prompt approach was tried and is unreliable —
 * LLMs ignore "не используй длинное тире" in 30-50% of replies. Doing it
 * deterministically as post-processing is bullet-proof.
 */

export interface TextStyleRule {
  name: string;
  description: string;
  apply: (text: string) => string;
}

// ─── Individual rules ──────────────────────────────────────────────────

/**
 * Em-dash (`—`, U+2014) — formally correct Russian typography but a dead
 * giveaway in messenger chat. Real candidates type a plain hyphen `-` or
 * skip the dash entirely. Replace with regular hyphen, normalising
 * surrounding whitespace so we don't end up with double-spaces.
 */
export const replaceEmDash: TextStyleRule = {
  name: "replace-em-dash",
  description: "U+2014 «—» → «-» (с нормализацией пробелов)",
  apply: (s) => s.replace(/\s*—\s*/g, " - ").replace(/  +/g, " "),
};

/**
 * En-dash (`–`, U+2013). Less common but appears in date ranges
 * («10:00–18:00») and is also AI-flavoured in casual chat.
 */
export const replaceEnDash: TextStyleRule = {
  name: "replace-en-dash",
  description: "U+2013 «–» → «-»",
  apply: (s) => s.replace(/\s*–\s*/g, " - ").replace(/  +/g, " "),
};

/**
 * Horizontal bar (`―`, U+2015) and figure dash (`‒`, U+2012) — the rest of
 * the dash family. Same rule, same reason.
 */
export const replaceOtherDashes: TextStyleRule = {
  name: "replace-other-dashes",
  description: "U+2015 «―» / U+2012 «‒» → «-»",
  apply: (s) => s.replace(/\s*[‒―]\s*/g, " - ").replace(/  +/g, " "),
};

/**
 * Unicode ellipsis (`…`, U+2026) → three ASCII dots. Native typists hit
 * `...` on a regular keyboard; the single-codepoint ellipsis arrives only
 * via autocomplete or model output.
 */
export const replaceEllipsis: TextStyleRule = {
  name: "replace-ellipsis",
  description: "U+2026 «…» → «...»",
  apply: (s) => s.replace(/…/g, "..."),
};

/**
 * Strip AI-flavoured lead-ins at the start of the reply.
 *
 * "Конечно!" / "Безусловно!" / "Разумеется!" / "Хорошо!" alone, followed by
 * a sentence boundary or comma, are textbook ChatGPT openers. A real
 * recruiter just answers. We trim the preamble; if the rest of the line is
 * empty we leave the original untouched (better to keep something than
 * nothing).
 */
export const stripAILeadIns: TextStyleRule = {
  name: "strip-ai-lead-ins",
  description:
    "удалить «Конечно/Безусловно/Разумеется/Отлично/Хорошо!» в начале реплики",
  apply: (s) => {
    const stripped = s.replace(
      /^\s*(?:Конечно|Безусловно|Разумеется|Отлично|Хорошо)\s*[!,.]\s*/iu,
      "",
    );
    // Восстанавливаем заглавную букву если её срезали.
    if (
      stripped !== s &&
      stripped.length > 0 &&
      /[a-zа-яё]/u.test(stripped[0]!)
    ) {
      return stripped[0]!.toUpperCase() + stripped.slice(1);
    }
    return stripped.length === 0 ? s : stripped;
  },
};

// ─── Default bundle ────────────────────────────────────────────────────

/**
 * The standard rule set applied by `sanitizeLlmOutput`.
 *
 * Order matters only for rules whose outputs are inputs of others — for the
 * current set the rules are independent (commutative), but new rules may
 * not be: keep the order intentional.
 */
export const DEFAULT_STYLE_RULES: readonly TextStyleRule[] = [
  replaceEmDash,
  replaceEnDash,
  replaceOtherDashes,
  replaceEllipsis,
  stripAILeadIns,
];

/**
 * Apply a sequence of style rules in order. Returns the input unchanged
 * when `rules` is empty.
 */
export function applyStyleRules(
  text: string,
  rules: readonly TextStyleRule[] = DEFAULT_STYLE_RULES,
): string {
  return rules.reduce((acc, rule) => rule.apply(acc), text);
}
