/**
 * After the bot has generated a reply, optionally ask a small LLM to
 * inspect the (system_prompt → user → assistant) triple and report which
 * of the configured skills (slugs) it actually used. Output goes into
 * `messages.meta_json.telemetry.skills_used` for downstream attribution
 * (Phase 2: ELO over outcomes; Phase 3: self-play).
 *
 * Cost: +1 LLM call per assistant turn. Gated behind RAG_SKILL_GRADING=true
 * because for high-volume single-style production it's overkill — flip on
 * during A/B research windows, off in steady state.
 *
 * Failure-soft: any error → returns empty array, never throws. The whole
 * point is post-hoc analytics, not a hard dependency.
 */
import type { ChatClient } from "./chat.ts";

export interface GradeSkillsInput {
  question: string;
  reply: string;
  /** Slugs offered to the model in the system prompt (only these are valid). */
  availableSlugs: readonly string[];
  chat: ChatClient;
  /** Lightweight model id — falls back to the chat client's default if undefined. */
  model?: string;
}

const SYSTEM = (slugs: readonly string[]) =>
  `You are a sales-conversation auditor. Given a candidate's question and a salesperson's reply, identify which persuasion skills (from the allowed list below) the reply actually demonstrates.\n\nALLOWED SKILLS:\n${slugs.map((s) => `- ${s}`).join("\n")}\n\nReturn ONLY a JSON array of slugs from the allowed list. Empty array if none clearly apply. No commentary, no markdown, no explanation. Be conservative: only include a slug when the reply demonstrably USES the technique, not just touches its theme.\n\nExamples:\n  Reply uses an explicit statistic → include "social-proof-stat".\n  Reply names the candidate's emotion ("звучит, что ты переживаешь") → include "tactical-empathy".\n  Reply asks an open "how" question → include "calibrated-question".\n  Reply just answers a factual question → return [].`;

export async function gradeSkills(input: GradeSkillsInput): Promise<string[]> {
  if (input.availableSlugs.length === 0) return [];
  try {
    const raw = await input.chat.complete(
      [
        { role: "system", content: SYSTEM(input.availableSlugs) },
        {
          role: "user",
          content: `Candidate: ${input.question}\n\nSalesperson reply: ${input.reply}\n\nReturn JSON array of skill slugs used (subset of allowed list).`,
        },
      ],
      {
        temperature: 0,
        ...(input.model ? { model: input.model } : {}),
        numPredict: 80,
      },
    );
    return parseSlugList(raw, input.availableSlugs);
  } catch (err) {
    console.warn("[grade-skills] LLM call failed:", err);
    return [];
  }
}

/** Tolerant parser — accepts a bare JSON array, code-fenced JSON, or
 *  comma-separated text. Filters to allowed slugs. Exported for tests. */
export function parseSlugList(raw: string, allowed: readonly string[]): string[] {
  if (!raw) return [];
  const allowSet = new Set(allowed);
  // Try JSON first.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => allowSet.has(s));
    }
  } catch {
    /* fall through to plain-text split */
  }
  return stripped
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/^["'-]+|["'-]+$/g, ""))
    .filter((s) => allowSet.has(s));
}
