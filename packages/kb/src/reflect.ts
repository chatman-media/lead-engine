import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { REFLECT_SYSTEM_PROMPT } from "./prompts/reflect.ts";
import { stripCodeFences, stripThinkBlocks } from "./sanitize.ts";

/**
 * Verifies that all factual claims in `answer` are grounded in `context`
 * (the KB chunks retrieved for this turn). Used as a post-generation
 * hallucination guard — if the LLM invented a number/city/condition, this
 * catches it before the message reaches the candidate.
 *
 * Returns `{ grounded: true }` when the answer is fully supported by the
 * context, or `{ grounded: false, reason }` when it isn't. The webhook
 * caller is responsible for deciding what to do with `grounded:false` —
 * typically: drop the reply (silent → mode stays "ai") or escalate.
 */
export interface ReflectInput {
  question: string;
  answer: string;
  /** The same KB CONTEXT that was passed to the generator. */
  context: string;
  chat: ChatClient;
}

export interface ReflectResult {
  grounded: boolean;
  reason?: string;
}

export async function verifyAnswer(input: ReflectInput): Promise<ReflectResult> {
  // Trivial / empty answers don't need a verifier — they cannot hallucinate.
  // This guards against pointless LLM calls on the NO_CONTEXT path and on
  // the smalltalk/persona-fact short-circuits (those return without context).
  const trimmed = input.answer.trim();
  if (trimmed.length === 0) return { grounded: true };
  if (input.context.trim().length === 0) {
    // If the generator had no KB context but produced a non-empty answer,
    // we can't verify anything — let it through. The KB-grounding rules in
    // the system prompt already force NO_CONTEXT_MARKER on missing data.
    return { grounded: true };
  }

  const userPrompt = `ВОПРОС: ${input.question}\n\nКОНТЕКСТ:\n${input.context}\n\nОТВЕТ: ${trimmed}\n\nJSON:`;

  const messages: ChatMessage[] = [
    { role: "system", content: REFLECT_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, { temperature: 0.0 });
  } catch (err) {
    console.error("[reflect] LLM call failed; treating as grounded:", err);
    return { grounded: true };
  }

  return parseReflection(raw);
}

/** Parses the verifier's JSON output. Defaults to `grounded:true` on parse
 *  failure — false negatives are cheap (one wasted reply), but false positives
 *  here would silently drop legitimate answers. Exported for unit tests. */
export function parseReflection(raw: string): ReflectResult {
  const s = stripCodeFences(stripThinkBlocks(raw)).trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { grounded: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
    /* c8 ignore next */
  } catch {
    return { grounded: true };
  }

  /* c8 ignore next */
  if (typeof parsed !== "object" || parsed === null) return { grounded: true };
  const obj = parsed as Record<string, unknown>;
  const grounded = obj.grounded;
  if (typeof grounded !== "boolean") return { grounded: true };
  if (grounded) return { grounded: true };
  const reason = typeof obj.reason === "string" ? obj.reason : "unknown";
  return { grounded: false, reason };
}
