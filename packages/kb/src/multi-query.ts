/**
 * Multi-query expansion for RAG retrieval.
 *
 * Instead of searching with a single query, generate N semantically-equivalent
 * rephrases in parallel using a fast LLM call, then search with each and merge
 * the results via RRF (Reciprocal Rank Fusion). This covers synonym gaps and
 * different formulations that a single embedding vector misses.
 *
 * Example — query "сколько стоит квартира в ЖК Марина":
 *   → "цена апартаментов в Marina Gate"
 *   → "стоимость юнитов Marina Dubai"
 *
 * Falls back gracefully to the original query on any LLM error.
 */

import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { MULTI_QUERY_SYSTEM_PROMPT } from "./prompts/multi-query.ts";
import { stripThinkBlocks } from "./sanitize.ts";

export interface ExpandQueriesInput {
  question: string;
  history?: ChatMessage[];
  chat: ChatClient;
  /** Number of ADDITIONAL variants to generate (not counting the original). Default: 2. */
  count?: number;
}

/**
 * Generate N alternative search queries for the given question.
 * Always includes the original question as the first element.
 * Returns `[question]` (single item) on any error.
 */
export async function expandQueries(input: ExpandQueriesInput): Promise<string[]> {
  const { question, chat, count = 2 } = input;
  const original = question.trim();
  if (!original) return [original];

  const tail = (input.history ?? []).slice(-4);
  const historySnippet =
    tail.length > 0 ? tail.map((m) => `${m.role}: ${m.content}`).join("\n") + "\n\n" : "";
  const userPrompt = `${historySnippet}запрос: ${original}\nответ (${count} строки):`;

  let raw: string;
  try {
    raw = await chat.complete(
      [
        { role: "system", content: MULTI_QUERY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.3 },
    );
  } catch (err) {
    console.warn("[multi-query] LLM call failed, using original only:", err);
    return [original];
  }

  const variants = parseVariants(raw, count);
  // Original always first so that its RRF rank is counted separately from variants.
  return [original, ...variants];
}

/** Parse LLM output into a list of clean query strings. */
function parseVariants(raw: string, maxCount: number): string[] {
  const cleaned = stripThinkBlocks(raw);
  return cleaned
    .split("\n")
    .map((l) => l.trim().replace(/^[-•*\d.]+\s*/, "")) // strip list markers
    .filter((l) => l.length > 3)
    .slice(0, maxCount);
}
