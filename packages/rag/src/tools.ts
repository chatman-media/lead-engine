import { z } from "zod";

/**
 * A tool the LLM can call during `answerWithRag`.
 *
 * Pass one or more tools via `AnswerInput.tools`. When the model decides to
 * use a tool, the library executes `execute()` automatically and feeds the
 * result back to the model for a final answer (single-cycle — one tool call
 * per request).
 *
 * @example
 * ```ts
 * import { answerWithRag, type RagTool } from "@chatman-media/rag";
 * import { z } from "zod";
 *
 * const slotsTool: RagTool = {
 *   name: "getAvailableSlots",
 *   description: "Returns available booking slots for a given date (YYYY-MM-DD).",
 *   parameters: z.object({ date: z.string() }),
 *   execute: async ({ date }) => fetchSlotsFromCRM(date),
 * };
 *
 * const result = await answerWithRag({ question, kb, chat, embedder, tools: [slotsTool] });
 * // result.telemetry.toolCall — name + result if a tool was invoked
 * ```
 */
export interface RagTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema for the tool's input parameters. Used to build the JSON Schema sent to the model. */
  parameters: TParams;
  execute: (args: z.infer<TParams>) => Promise<unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: intentional open type for mixed tool arrays
export type AnyRagTool = RagTool<any>;

/** Converts a `RagTool` to the OpenAI function-calling format. */
export function toolToOpenAIFunction(tool: AnyRagTool): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    },
  };
}

// ── Internal types used by ChatClient ────────────────────────────────────────

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallRequest {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolCallResult {
  /** Tool call id returned by the model. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface CompleteWithToolsResult {
  /** Model text when no tool was called. */
  content: string | null;
  /** Parsed tool calls when the model chose to call a tool. */
  toolCalls: ToolCallResult[];
}
