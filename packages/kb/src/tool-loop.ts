import type { AnswerTelemetry } from "./answer-types.ts";
import type { ChatClient, ChatCompletionOpts, ChatMessage } from "@chatman-media/llm-router";
import type { AnyRagTool } from "./tools.ts";
import { toolToOpenAIFunction } from "./tools.ts";

/** Default maximum number of agentic tool-calling cycles. */
export const DEFAULT_MAX_TOOL_CYCLES = 4;

/** A single tool execution recorded during an agentic tool loop. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** True when the tool was unknown or `execute()` threw — `result` holds `{ error }`. */
  error?: boolean;
  /** Zero-based index of the loop cycle this call belongs to. */
  cycle: number;
}

export interface ToolLoopResult {
  /** Final assistant text when the model stopped calling tools, else null. */
  content: string | null;
  /** Every tool call executed across all cycles, in order. */
  toolCalls: ToolCallRecord[];
  /** True when the loop stopped because `maxCycles` was hit while the model still wanted tools. */
  exhausted: boolean;
}

/**
 * Runs an agentic tool-calling loop. Mutates `messages` in place, appending an
 * assistant message (carrying all tool calls) and one `tool` message per call
 * for every cycle. Returns the final model text (when produced) and the full
 * tool-call trace.
 *
 * Unknown tools and thrown `execute()` errors are fed back to the model as the
 * tool result so it can recover — the loop never throws on tool failure.
 *
 * The caller must guarantee `chat.completeWithTools` exists and `tools` is non-empty.
 */
export async function runToolLoop(opts: {
  chat: ChatClient;
  messages: ChatMessage[];
  tools: AnyRagTool[];
  llmOpts: ChatCompletionOpts;
  maxCycles: number;
}): Promise<ToolLoopResult> {
  const { chat, messages, tools, llmOpts, maxCycles } = opts;
  const completeWithTools = chat.completeWithTools;
  if (!completeWithTools) throw new Error("runToolLoop: chat.completeWithTools is required");
  const toolDefs = tools.map(toolToOpenAIFunction);
  const toolCalls: ToolCallRecord[] = [];

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const res = await completeWithTools.call(chat, messages, toolDefs, llmOpts);

    if (res.toolCalls.length === 0) {
      return { content: res.content, toolCalls, exhausted: false };
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });

    const settled = await Promise.allSettled(
      res.toolCalls.map((tc) => {
        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) return Promise.reject(new Error(`unknown tool: ${tc.name}`));
        return tool.execute(tc.args);
      }),
    );

    for (let i = 0; i < res.toolCalls.length; i++) {
      const tc = res.toolCalls[i] as (typeof res.toolCalls)[number];
      const outcome = settled[i] as PromiseSettledResult<unknown>;
      let payload: unknown;
      let isError = false;
      if (outcome.status === "fulfilled") {
        payload = outcome.value;
      } else {
        isError = true;
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        payload = { error: message };
        console.warn(`[tool-loop] tool "${tc.name}" failed: ${message}`);
      }
      toolCalls.push({ name: tc.name, args: tc.args, result: payload, error: isError, cycle });
      messages.push({ role: "tool", content: JSON.stringify(payload), tool_call_id: tc.id });
    }
  }

  return { content: null, toolCalls, exhausted: true };
}

/** Builds the tool-related telemetry fields from a tool-call trace. */
export function buildToolTelemetry(
  records: ToolCallRecord[],
): Pick<AnswerTelemetry, "toolCall" | "toolCalls"> {
  const first = records[0];
  if (!first) return {};
  return {
    toolCall: { name: first.name, result: first.result },
    toolCalls: records,
  };
}
