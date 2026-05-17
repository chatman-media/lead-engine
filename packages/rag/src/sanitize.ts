import { applyStyleRules } from "./text-style-rules.ts";

// Hoisted regexes — module-level so they compile once instead of on every
// hot-path LLM-response cleanup. Used both here and in the various
// extractor / verifier wrappers (reflect, rewrite-query, fact-checker,
// vacancy-guard, summarize-conversation, extract-user-facts).
const THINK_BLOCK_PAIRED = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_BLOCK_LEADING_UNCLOSED = /^\s*<think\b[^>]*>[\s\S]*$/i;
const CODE_FENCE = /```(?:json)?/gi;
const LEADING_LABEL = /^\s*(?:answer|ответ|reply|response|согласно\s+контексту)\s*[:\-—]\s*/i;

/**
 * Strip `<think>…</think>` reasoning blocks some chat models emit despite
 * system instructions (qwen3, deepseek-r1 style). Both well-formed
 * paired and an unclosed leading block are handled.
 */
export function stripThinkBlocks(raw: string): string {
  return raw.replace(THINK_BLOCK_PAIRED, "").replace(THINK_BLOCK_LEADING_UNCLOSED, "");
}

/** Strip markdown code fences (` ``` ` and ` ```json `). Useful when an LLM
 *  wraps its JSON answer in a fenced block despite "only JSON" instructions. */
export function stripCodeFences(raw: string): string {
  return raw.replace(CODE_FENCE, "");
}

/**
 * Strip artifacts some chat models emit despite system instructions:
 * - `<think>…</think>` reasoning blocks (qwen3, deepseek-r1 style).
 * - leading "Answer:" / "Ответ:" / "Согласно контексту" prefixes.
 * - surrounding whitespace.
 * - "AI tells" — em-/en-dashes, unicode ellipsis, "Конечно!" lead-ins
 *   (see `text-style-rules.ts` for the full list).
 *
 * Exported for unit tests.
 */
export function sanitizeLlmOutput(raw: string): string {
  let s = stripThinkBlocks(raw);
  s = s.replace(LEADING_LABEL, "");
  // Apply pluggable text-style rules (em-dash → hyphen, ellipsis → ..., etc).
  // See src/rag/text-style-rules.ts to add new rules without touching this file.
  s = applyStyleRules(s);
  return s.trim();
}
