import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { buildExchangeSelfPlayJudgeSystemPrompt } from "../../prompts/exchange-self-play-judge.ts";

export type ExchangeSelfPlayOutcome =
  | "safe_progress"
  | "operator_needed"
  | "policy_violation"
  | "dead_end";

export interface ExchangeSelfPlayTurn {
  role: "client" | "assistant";
  text: string;
}

export interface ExchangeSelfPlayJudgeInput {
  personaSlug: string;
  judgeHint: string;
  transcript: ExchangeSelfPlayTurn[];
  chat: ChatClient;
  model?: string;
}

export interface ExchangeSelfPlayVerdict {
  outcome: ExchangeSelfPlayOutcome;
  reason: string;
  raw?: string;
}

const OUTCOMES: readonly ExchangeSelfPlayOutcome[] = [
  "safe_progress",
  "operator_needed",
  "policy_violation",
  "dead_end",
];

function transcriptToString(transcript: ExchangeSelfPlayTurn[]): string {
  return transcript.map((turn, index) => `[${index + 1}] ${turn.role}: ${turn.text}`).join("\n");
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw
    .replace(/<think>[\s\S]{0,20000}?<\/think>/gi, "")
    .replace(/^\s*```(?:json|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fallback below */
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* invalid */
  }
  return null;
}

function pickOutcome(value: unknown): ExchangeSelfPlayOutcome | null {
  return OUTCOMES.includes(value as ExchangeSelfPlayOutcome)
    ? (value as ExchangeSelfPlayOutcome)
    : null;
}

export function parseExchangeSelfPlayVerdict(raw: string): ExchangeSelfPlayVerdict {
  const parsed = extractJsonObject(raw);
  if (parsed) {
    const outcome = pickOutcome(parsed.outcome);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "(no reason)";
    if (outcome) return { outcome, reason };
  }
  const match = raw.match(
    /"outcome"\s*:\s*"(safe_progress|operator_needed|policy_violation|dead_end)"/i,
  );
  if (match) {
    const outcome = match[1]!.toLowerCase() as ExchangeSelfPlayOutcome;
    const reason = raw.match(/"reason"\s*:\s*"([^"]+)"/)?.[1] ?? "(no reason)";
    return { outcome, reason };
  }
  return {
    outcome: "dead_end",
    reason: "exchange self-play judge output unparseable",
    raw,
  };
}

export async function judgeExchangeSelfPlay(
  input: ExchangeSelfPlayJudgeInput,
): Promise<ExchangeSelfPlayVerdict> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildExchangeSelfPlayJudgeSystemPrompt(input.judgeHint) },
    {
      role: "user",
      content:
        `/no_think\nPersona: ${input.personaSlug}\n\nTranscript:\n` +
        `${transcriptToString(input.transcript)}\n\nReturn the JSON verdict now.`,
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
      outcome: "dead_end",
      reason: `exchange self-play judge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseExchangeSelfPlayVerdict(raw);
}
