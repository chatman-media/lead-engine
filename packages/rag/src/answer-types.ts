import type { z } from "zod";
import type { ChatClient, ChatMessage } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";
import type { FunnelStage, SkillForPrompt, Style } from "./styles.ts";
import type { AnyRagTool } from "./tools.ts";
import type { IKbStore, KbSearchHit } from "./types.ts";

export const NO_CONTEXT_MARKER = "__NO_CONTEXT__";

export interface Persona {
  name: string;
  role: "human" | "assistant";
  company?: string;
  /**
   * Fixed personal facts about the persona — bypasses RAG for direct personal
   * questions and injects into the system prompt as inviolable grounding.
   * Known keys: "city", "age", "status", "experience", "phone".
   */
  facts?: Record<string, string>;
}

export interface AnswerInput {
  question: string;
  kb: IKbStore;
  embedder: EmbeddingClient;
  chat: ChatClient;
  history?: ChatMessage[];
  topK?: number;
  maxDistance?: number;
  persona?: Persona;
  style?: Style;
  stage?: FunnelStage;
  includeFewShot?: boolean;
  numPredict?: number;
  userFacts?: Record<string, string>;
  rewriteQueryBeforeRetrieval?: boolean;
  reflect?: boolean;
  hybridSearch?: boolean;
  conversationSummary?: string;
  topicRouting?: boolean;
  vacanciesBlock?: string;
  vacancyGuard?: boolean;
  skills?: readonly SkillForPrompt[];
  booksPriority?: boolean;
  /**
   * Called after every `answerWithRag` or `answerWithRagStream` call with the
   * final telemetry. Useful for logging, metrics, or A/B experiment recording
   * without having to unwrap the return value.
   */
  onTelemetry?: (telemetry: AnswerTelemetry) => void;
  /**
   * Optional tools the LLM can call during answer generation (single-cycle).
   * When the model decides to call a tool, `execute()` is called automatically
   * and the result is fed back for a final answer.
   * Requires `chat` to implement `completeWithTools` (e.g. `OpenAIChatClient`),
   * otherwise falls back to prompt-based tool injection.
   */
  tools?: AnyRagTool[];
  /**
   * When provided, the LLM is instructed to return a JSON object matching this
   * Zod schema. The parsed and validated value is available as `result.output`.
   * Uses OpenAI's native `response_format` when available; falls back to prompt
   * injection for other providers (Ollama, OpenRouter, etc.).
   *
   * @example
   * ```ts
   * const result = await answerWithRag({
   *   question: "Classify this lead",
   *   kb, chat, embedder,
   *   outputSchema: z.object({
   *     intent: z.enum(["buy", "info", "not_interested"]),
   *     budget: z.number().optional(),
   *     nextAction: z.string(),
   *   }),
   * });
   * console.log(result.output.intent); // "buy" | "info" | "not_interested"
   * ```
   */
  outputSchema?: z.ZodTypeAny;
}

export interface AnswerTelemetry {
  path: "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok" | "cache_hit";
  total_ms?: number;
  retrieval_ms?: number;
  generation_ms?: number;
  top_distances?: number[];
  hybrid?: boolean;
  topic?: string | null;
  original_query?: string;
  rewritten_query?: string;
  factCheck?: { grounded: boolean; vacancyOk: boolean; reason?: string };
  /** Populated when a tool was called during answer generation. */
  toolCall?: { name: string; result: unknown };
}

export interface AnswerResult<TOutput = unknown> {
  text: string;
  usedChunkIds: number[];
  hits: KbSearchHit[];
  telemetry: AnswerTelemetry;
  /** Parsed and validated output when `outputSchema` was passed to `answerWithRag`. */
  output?: TOutput;
}
