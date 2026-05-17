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
  apply: (s) => s.replace(/\s*—\s*/g, " - ").replace(/ {2,}/g, " "),
};

/**
 * En-dash (`–`, U+2013). Less common but appears in date ranges
 * («10:00–18:00») and is also AI-flavoured in casual chat.
 */
export const replaceEnDash: TextStyleRule = {
  name: "replace-en-dash",
  description: "U+2013 «–» → «-»",
  apply: (s) => s.replace(/\s*–\s*/g, " - ").replace(/ {2,}/g, " "),
};

/**
 * Horizontal bar (`―`, U+2015) and figure dash (`‒`, U+2012) — the rest of
 * the dash family. Same rule, same reason.
 */
export const replaceOtherDashes: TextStyleRule = {
  name: "replace-other-dashes",
  description: "U+2015 «―» / U+2012 «‒» → «-»",
  apply: (s) => s.replace(/\s*[‒―]\s*/g, " - ").replace(/ {2,}/g, " "),
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
  description: "удалить «Конечно/Безусловно/Разумеется/Отлично/Хорошо!» в начале реплики",
  apply: (s) => {
    const stripped = s.replace(
      /^\s*(?:Конечно|Безусловно|Разумеется|Отлично|Хорошо)\s*[!,.]\s*/iu,
      "",
    );
    // Восстанавливаем заглавную букву если её срезали.
    if (stripped !== s && stripped.length > 0 && /[a-zа-яё]/u.test(stripped[0]!)) {
      return stripped[0]!.toUpperCase() + stripped.slice(1);
    }
    return stripped.length === 0 ? s : stripped;
  },
};

/**
 * Capitalise the first alphabetic character of the reply.
 *
 * Why: qwen3 (and other models) tend to mirror the candidate's casing —
 * if the user types «привет», the model replies «привет, ...» in lowercase.
 * Real recruiters in our corpus (`kb/extracted/dialogs/*`) consistently
 * start replies with a capital letter («Здравствуйте», «Хорошо»),
 * regardless of how the candidate wrote.
 *
 * Implementation finds the FIRST alphabetic codepoint (skipping leading
 * whitespace, emoji, punctuation) and uppercases it. Idempotent.
 */
export const capitalizeFirstLetter: TextStyleRule = {
  name: "capitalize-first-letter",
  description: "первая буква реплики — заглавная",
  apply: (s) => {
    const match = /[\p{L}]/u.exec(s);
    if (!match || match.index === undefined) return s;
    const i = match.index;
    const ch = s[i]!;
    const upper = ch.toUpperCase();
    if (ch === upper) return s;
    return s.slice(0, i) + upper + s.slice(i + 1);
  },
};

/**
 * Strip Markdown bold (`**text**` and `__text__`). Telegram doesn't
 * render Markdown unless `parse_mode` is set — and the bot uses plain
 * text — so the asterisks/underscores leak through to the candidate
 * verbatim ("Зарплата от **₩110 000**" → user sees the stars).
 *
 * We strip the markers and keep the inner text. Conservative: requires
 * non-whitespace content inside, so a literal `**` separator wrapping
 * spaces stays intact (rare but happens).
 */
export const stripMarkdownBold: TextStyleRule = {
  name: "strip-markdown-bold",
  description: "**foo** / __foo__ → foo",
  apply: (s) =>
    s
      .replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, "$1")
      .replace(/__([^\s_](?:[^_]*[^\s_])?)__/g, "$1"),
};

/**
 * Strip Markdown italics (`*text*` and `_text_`). Same reason as bold.
 *
 * Tricky: bare `*` and `_` appear naturally in URLs, file names, math
 * expressions, etc. We require:
 *   - the OPENING marker to be at start-of-string OR preceded by a
 *     non-letter/non-digit (so `foo_bar` and `https://example_com` stay);
 *   - the CLOSING marker to be at end-of-string OR followed by the same;
 *   - inner content to be non-empty + not start/end with whitespace.
 *
 * Run AFTER `stripMarkdownBold` so `**bold**` is unwrapped before the
 * italic regex sees the standalone `*` pair.
 */
export const stripMarkdownItalic: TextStyleRule = {
  name: "strip-markdown-italic",
  description: "*foo* / _foo_ → foo",
  apply: (s) =>
    s
      .replace(/(^|[^\p{L}\p{N}*])\*([^\s*][^*]*?[^\s*]|[^\s*])\*(?=$|[^\p{L}\p{N}*])/gu, "$1$2")
      .replace(/(^|[^\p{L}\p{N}_])_([^\s_][^_]*?[^\s_]|[^\s_])_(?=$|[^\p{L}\p{N}_])/gu, "$1$2"),
};

/**
 * Strip Markdown inline / fenced code (`` `code` ``, ``` ```block``` ```).
 * In a candidate-facing sales chat these are never helpful; the bot
 * sometimes wraps numbers like `` `₩110 000` `` for emphasis and the
 * candidate sees the backticks.
 *
 * Fenced (triple-backtick) blocks come first so their contents aren't
 * partially eaten by the inline rule.
 */
export const stripMarkdownCode: TextStyleRule = {
  name: "strip-markdown-code",
  description: "`x` → x; ```x``` → x",
  apply: (s) =>
    s.replace(/```(?:[a-z0-9_-]*\n)?([\s\S]*?)```/gi, "$1").replace(/`([^`\n]+)`/g, "$1"),
};

/**
 * Strip Markdown headers (`# Heading` at the start of a line). LLMs
 * sometimes emit `## Условия:` when listing facts; in chat that just
 * dumps the hashes. We keep the trailing text.
 */
export const stripMarkdownHeaders: TextStyleRule = {
  name: "strip-markdown-headers",
  description: "^#+ text → text",
  apply: (s) => s.replace(/^[ \t]*#{1,6}[ \t]+/gm, ""),
};

/**
 * Strip Markdown links (`[text](url)`) into `text (url)` — keeps the
 * URL visible, drops the bracket syntax. Telegram autolinks plain
 * URLs, so the candidate still gets a clickable link.
 */
export const stripMarkdownLinks: TextStyleRule = {
  name: "strip-markdown-links",
  description: "[text](url) → text (url)",
  apply: (s) => s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)"),
};

// ─── Default bundle ────────────────────────────────────────────────────

/**
 * The standard rule set applied by `sanitizeLlmOutput`.
 *
 * Order matters when one rule's output feeds another. Critical:
 * `stripAILeadIns` MUST run before `capitalizeFirstLetter`, otherwise we
 * just re-uppercase the «К» in «Конечно!» and the lead-in stays.
 */
export const DEFAULT_STYLE_RULES: readonly TextStyleRule[] = [
  // Markdown stripping FIRST — Telegram doesn't render markdown for
  // plain-text bot replies, so leftover **/`/[]() reach the candidate.
  // Order: links → fenced code → bold → italic → headers (each one's
  // output becomes input for the next; bold before italic so `**foo**`
  // is unwrapped before the italic regex sees a `*` pair).
  stripMarkdownLinks,
  stripMarkdownCode,
  stripMarkdownBold,
  stripMarkdownItalic,
  stripMarkdownHeaders,
  // Typography normalisation.
  replaceEmDash,
  replaceEnDash,
  replaceOtherDashes,
  replaceEllipsis,
  // Conversational tone fixes.
  stripAILeadIns, // strip first
  capitalizeFirstLetter, // then ensure remaining first char is capital
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
