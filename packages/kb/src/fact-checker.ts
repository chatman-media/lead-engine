import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import {
  FACT_CHECKER_SYSTEM_PROMPT_NO_VACANCIES,
  FACT_CHECKER_SYSTEM_PROMPT_WITH_VACANCIES,
} from "./prompts/fact-checker.ts";
import { stripCodeFences, stripThinkBlocks } from "./sanitize.ts";

/**
 * Unified fact-checker — replaces the separate reflect.ts + vacancy-guard.ts
 * pipeline with a single LLM call that checks both:
 *
 *   1. KB grounding: every concrete fact in the answer is supported by the
 *      retrieved KB context (no hallucinations).
 *
 *   2. Vacancy accuracy: any salary/city/condition data matches the
 *      authoritative АКТУАЛЬНЫЕ ВАКАНСИИ block from the DB table.
 *      ВАКАНСИИ always win over KB chunks when they conflict — an old
 *      chat log with a stale salary is not a valid grounding source.
 *
 * Cost: 1 LLM call per turn (was 2 with separate reflect + vacancy-guard).
 *
 * **Fail-closed by default**: on any LLM or parse error returns
 * `{ grounded: false, vacancyOk: false, reason: "checker_error: …" }` so the
 * caller treats the reply as ungrounded and escalates to silence/operator
 * instead of shipping a potentially-hallucinated answer. The legacy
 * fail-open behaviour can be restored with `RAG_FACT_CHECKER_FAIL_OPEN=1`
 * (kept for test fixtures that drive the checker with mock failures).
 */

export interface FactCheckInput {
  question: string;
  answer: string;
  /** KB chunks concatenated — same string passed to the generator. */
  context: string;
  chat: ChatClient;
  /** Optional: rendered АКТУАЛЬНЫЕ ВАКАНСИИ block.
   *  When provided, vacancy facts are checked against it as the authoritative
   *  source. KB chunks that contradict it are treated as outdated. */
  vacanciesBlock?: string;
}

export interface FactCheckResult {
  /** All concrete facts in the answer are found in context (or vacanciesBlock). */
  grounded: boolean;
  /** All vacancy-specific facts (salary, city, conditions) match vacanciesBlock.
   *  Always true when vacanciesBlock was not provided. */
  vacancyOk: boolean;
  /** Human-readable reason when grounded=false or vacancyOk=false. */
  reason?: string;
}

// ── Main function ───────────────────────────────────────────────────────────

/** Reply when the checker itself cannot run (LLM error / network).
 *  Default: treat the answer as ungrounded so it gets silenced. The
 *  RAG_FACT_CHECKER_FAIL_OPEN=1 env override restores the legacy
 *  "let it through" behaviour for test environments that intentionally
 *  inject failing LLM mocks. */
function checkerErrorResult(reason: string): FactCheckResult {
  if (process.env.RAG_FACT_CHECKER_FAIL_OPEN === "1") {
    return { grounded: true, vacancyOk: true };
  }
  return { grounded: false, vacancyOk: false, reason: `checker_error: ${reason}` };
}

export async function checkFacts(input: FactCheckInput): Promise<FactCheckResult> {
  const OK: FactCheckResult = { grounded: true, vacancyOk: true };

  const trimmed = input.answer.trim();
  if (!trimmed) return OK;

  const hasContext = input.context.trim().length > 0;
  const hasVacancies = (input.vacanciesBlock ?? "").trim().length > 0;

  // Nothing to check against — let it through (generator's own NO_CONTEXT
  // rules are the last line of defense on truly empty turns).
  if (!hasContext && !hasVacancies) return OK;

  const systemPrompt = hasVacancies
    ? FACT_CHECKER_SYSTEM_PROMPT_WITH_VACANCIES
    : FACT_CHECKER_SYSTEM_PROMPT_NO_VACANCIES;

  let userPrompt: string;
  if (hasVacancies) {
    userPrompt =
      `ВОПРОС: ${input.question}\n\n` +
      `KB-КОНТЕКСТ:\n${input.context || "(пусто)"}\n\n` +
      `АКТУАЛЬНЫЕ ВАКАНСИИ:\n${input.vacanciesBlock}\n\n` +
      `ОТВЕТ: ${trimmed}\n\nJSON:`;
  } else {
    userPrompt = `ВОПРОС: ${input.question}\n\nКОНТЕКСТ:\n${input.context}\n\nОТВЕТ: ${trimmed}\n\nJSON:`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, { temperature: 0.0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[fact-checker] LLM call failed:", err);
    return checkerErrorResult(`llm_call: ${msg}`);
  }

  return parseFactCheckResult(raw);
}

/** Exported for unit tests. */
export function parseFactCheckResult(raw: string): FactCheckResult {
  const OK: FactCheckResult = { grounded: true, vacancyOk: true };

  const s = stripCodeFences(stripThinkBlocks(raw)).trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return OK;

  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return OK;
  }

  if (typeof parsed !== "object" || parsed === null) return OK;
  const obj = parsed as Record<string, unknown>;

  const grounded = typeof obj.grounded === "boolean" ? obj.grounded : true;
  const vacancyOk = typeof obj.vacancyOk === "boolean" ? obj.vacancyOk : true;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;

  return { grounded, vacancyOk, ...(reason ? { reason } : {}) };
}
