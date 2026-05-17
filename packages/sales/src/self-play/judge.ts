/**
 * LLM-as-judge for self-play matches. Reads the full transcript and the
 * candidate persona's `judgingHint`, returns a single verdict
 * `{outcome: won|lost|draw, reason: string}`.
 *
 * The judge is intentionally conservative — defaulting to "draw" when the
 * conversation is ambiguous prevents inflated win-rates. Verdicts go
 * straight into `skill_outcomes` and ELO, so misclassification cascades.
 *
 * Tolerant JSON parsing: accepts code-fenced JSON or bare object. On
 * any error we surface a draw + the raw model output as reason — so a
 * judge crash doesn't lose the run.
 */
import type { ChatClient, ChatMessage } from "@chatman-media/rag";
import type { EloOutcome } from "../elo.ts";
import { extractJsonObject } from "../llm-json.ts";

export interface JudgeInput {
  /** Style under test (e.g. "marina-prime-v1"). */
  styleSlug: string;
  /** Candidate archetype (slug). */
  personaSlug: string;
  /** What "won" looks like for THIS persona. */
  judgingHint: string;
  /** Full transcript: candidate vs salesperson, alternating. */
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
  chat: ChatClient;
  model?: string;
}

export interface JudgeVerdict {
  outcome: EloOutcome;
  reason: string;
  /** When the judge model couldn't be parsed, the raw text comes back here
   *  for debugging. Empty otherwise. */
  raw?: string;
}

const JUDGE_SYSTEM = (hint: string) =>
  `You are an objective judge of a sales conversation between an agency salesperson (Russian-speaking recruiter for foreign work contracts) and a CANDIDATE (a simulated prospect).

Read the full transcript. Decide ONE outcome from this set:
  - "won":  the candidate clearly committed to the next step (anketa / call / fly out / sign / send photos). The salesperson successfully advanced to close.
  - "lost": the candidate clearly walked away (refused / said it's a scam / lost interest / told them to stop writing).
  - "draw": ambiguous — the conversation ended without a clear yes or no, or the candidate said "I'll think about it" without committing.

WHAT "WON" LOOKS LIKE FOR THIS PERSONA:
${hint}

CRITICAL: Be CONSERVATIVE. Do NOT default to "won" because the salesperson was polite. Only "won" when the candidate explicitly accepted a concrete next step. When in doubt, return "draw".

OUTPUT FORMAT — RETURN EXACTLY THIS JSON, NOTHING ELSE:
{"outcome": "won" | "lost" | "draw", "reason": "<one short sentence>"}

No markdown, no explanation outside the JSON. Reason should be one sentence quoting the moment that decided it.`;

function transcriptToString(t: JudgeInput["transcript"]): string {
  return t
    .map(
      (m, i) =>
        `[${i + 1}] ${m.role === "candidate" ? "candidate" : "salesperson"}: ${m.text}`,
    )
    .join("\n");
}

export async function judgeMatch(input: JudgeInput): Promise<JudgeVerdict> {
  const messages: ChatMessage[] = [
    { role: "system", content: JUDGE_SYSTEM(input.judgingHint) },
    {
      role: "user",
      content: `/no_think\nTranscript (style under test: ${input.styleSlug}, candidate persona: ${input.personaSlug}):\n\n${transcriptToString(
        input.transcript,
      )}\n\nReturn the JSON verdict now.`,
    },
  ];
  let raw: string;
  try {
    raw = await input.chat.complete(messages, {
      temperature: 0,
      ...(input.model ? { model: input.model } : {}),
      numPredict: 600,
    });
  } catch (err) {
    return {
      outcome: "draw",
      reason: `judge LLM failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseVerdict(raw);
}

/**
 * Tolerant JSON parser. Strips code fences, trims, attempts JSON.parse,
 * falls back to regex match if necessary. Exported for tests.
 */
export function parseVerdict(raw: string): JudgeVerdict {
  const parsed = extractJsonObject(raw);
  if (parsed) {
    const outcome = pickOutcome(parsed.outcome);
    const reason =
      typeof parsed.reason === "string" ? parsed.reason : "(no reason)";
    if (outcome) return { outcome, reason };
  }
  // Regex fallback — find an "outcome": "..." pair anywhere.
  const m = raw.match(/"outcome"\s*:\s*"(won|lost|draw)"/i);
  if (m) {
    const outcome = (m[1] ?? "draw").toLowerCase() as EloOutcome;
    const reasonMatch = raw.match(/"reason"\s*:\s*"([^"]+)"/);
    return {
      outcome,
      reason: reasonMatch?.[1] ?? "(no reason)",
    };
  }
  console.warn(
    "[judge] unparseable output (first 300 chars):",
    raw.slice(0, 300),
  );
  return { outcome: "draw", reason: "judge output unparseable", raw };
}

function pickOutcome(v: unknown): EloOutcome | null {
  if (v === "won" || v === "lost" || v === "draw") return v;
  return null;
}
