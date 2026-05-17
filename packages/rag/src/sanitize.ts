import { applyStyleRules } from "./text-style-rules.ts";

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
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/^\s*<think\b[^>]*>[\s\S]*$/i, "");
  s = s.replace(/^\s*(?:answer|ответ|reply|response|согласно\s+контексту)\s*[:\-—]\s*/i, "");
  // Apply pluggable text-style rules (em-dash → hyphen, ellipsis → ..., etc).
  // See src/rag/text-style-rules.ts to add new rules without touching this file.
  s = applyStyleRules(s);
  return s.trim();
}
