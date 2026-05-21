import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { buildToolTelemetry, runToolLoop, type ToolCallRecord } from "../src/tool-loop.ts";
import type { AnyRagTool } from "../src/tools.ts";

type ToolsResponse = {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
};

/** Chat client whose `completeWithTools` replays a scripted sequence of responses. */
function scriptedChat(responses: ToolsResponse[]): ChatClient {
  let i = 0;
  return {
    complete: async () => "unused",
    completeWithTools: async () => {
      const res = responses[i] ?? responses[responses.length - 1];
      i++;
      if (!res) throw new Error("scriptedChat: no response");
      return res;
    },
  };
}

function textResponse(content: string): ToolsResponse {
  return { content, toolCalls: [] };
}

function callResponse(
  calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
): ToolsResponse {
  return {
    content: null,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })),
  };
}

const echoTool: AnyRagTool = {
  name: "echo",
  description: "Echoes its input back.",
  parameters: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ echoed: value }),
};

const addTool: AnyRagTool = {
  name: "add",
  description: "Adds two numbers.",
  parameters: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ sum: a + b }),
};

const boomTool: AnyRagTool = {
  name: "boom",
  description: "Always throws.",
  parameters: z.object({}),
  execute: async () => {
    throw new Error("kaboom");
  },
};

const baseMessages = (): ChatMessage[] => [{ role: "user", content: "hi" }];

describe("runToolLoop", () => {
  test("single cycle: one tool call then a text answer", async () => {
    const messages = baseMessages();
    const res = await runToolLoop({
      chat: scriptedChat([
        callResponse([{ id: "c1", name: "echo", args: { value: "x" } }]),
        textResponse("done"),
      ]),
      messages,
      tools: [echoTool],
      llmOpts: {},
      maxCycles: 4,
    });

    expect(res.content).toBe("done");
    expect(res.exhausted).toBe(false);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({ name: "echo", error: false, cycle: 0 });
    expect(res.toolCalls[0]?.result).toEqual({ echoed: "x" });

    // messages: original user + assistant(tool_calls) + tool result
    expect(messages).toHaveLength(3);
    expect(messages[1]?.tool_calls).toHaveLength(1);
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  test("multi-cycle: tool, result, another tool, then answer", async () => {
    const messages = baseMessages();
    const res = await runToolLoop({
      chat: scriptedChat([
        callResponse([{ id: "c1", name: "echo", args: { value: "first" } }]),
        callResponse([{ id: "c2", name: "add", args: { a: 2, b: 3 } }]),
        textResponse("final"),
      ]),
      messages,
      tools: [echoTool, addTool],
      llmOpts: {},
      maxCycles: 4,
    });

    expect(res.content).toBe("final");
    expect(res.exhausted).toBe(false);
    expect(res.toolCalls.map((c) => c.cycle)).toEqual([0, 1]);
    expect(res.toolCalls[1]?.result).toEqual({ sum: 5 });
  });

  test("parallel tool calls in one cycle produce matched tool messages", async () => {
    const messages = baseMessages();
    const res = await runToolLoop({
      chat: scriptedChat([
        callResponse([
          { id: "p1", name: "echo", args: { value: "a" } },
          { id: "p2", name: "add", args: { a: 1, b: 1 } },
        ]),
        textResponse("ok"),
      ]),
      messages,
      tools: [echoTool, addTool],
      llmOpts: {},
      maxCycles: 4,
    });

    expect(res.toolCalls).toHaveLength(2);
    const assistant = messages[1];
    expect(assistant?.tool_calls).toHaveLength(2);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(["p1", "p2"]);
  });

  test("unknown tool name feeds an error back and the loop continues", async () => {
    const messages = baseMessages();
    const res = await runToolLoop({
      chat: scriptedChat([
        callResponse([{ id: "c1", name: "missing", args: {} }]),
        textResponse("recovered"),
      ]),
      messages,
      tools: [echoTool],
      llmOpts: {},
      maxCycles: 4,
    });

    expect(res.content).toBe("recovered");
    expect(res.toolCalls[0]?.error).toBe(true);
    expect(res.toolCalls[0]?.result).toEqual({ error: "unknown tool: missing" });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  test("a throwing tool feeds the error back; sibling parallel calls still recorded", async () => {
    const messages = baseMessages();
    const res = await runToolLoop({
      chat: scriptedChat([
        callResponse([
          { id: "ok", name: "echo", args: { value: "v" } },
          { id: "bad", name: "boom", args: {} },
        ]),
        textResponse("handled"),
      ]),
      messages,
      tools: [echoTool, boomTool],
      llmOpts: {},
      maxCycles: 4,
    });

    expect(res.toolCalls).toHaveLength(2);
    const ok = res.toolCalls.find((c) => c.name === "echo");
    const bad = res.toolCalls.find((c) => c.name === "boom");
    expect(ok?.error).toBe(false);
    expect(bad?.error).toBe(true);
    expect(bad?.result).toEqual({ error: "kaboom" });
  });

  test("exhaustion: model keeps asking for tools past maxCycles", async () => {
    const messages = baseMessages();
    const res = await runToolLoop({
      chat: scriptedChat([callResponse([{ id: "c", name: "echo", args: { value: "x" } }])]),
      messages,
      tools: [echoTool],
      llmOpts: {},
      maxCycles: 3,
    });

    expect(res.content).toBeNull();
    expect(res.exhausted).toBe(true);
    expect(res.toolCalls).toHaveLength(3);
  });
});

describe("buildToolTelemetry", () => {
  test("returns an empty object for no tool calls", () => {
    expect(buildToolTelemetry([])).toEqual({});
  });

  test("sets toolCall to the first record and toolCalls to the full trace", () => {
    const records: ToolCallRecord[] = [
      { name: "echo", args: { value: "a" }, result: { echoed: "a" }, error: false, cycle: 0 },
      { name: "add", args: { a: 1, b: 2 }, result: { sum: 3 }, error: false, cycle: 1 },
    ];
    const telemetry = buildToolTelemetry(records);
    expect(telemetry.toolCall).toEqual({ name: "echo", result: { echoed: "a" } });
    expect(telemetry.toolCalls).toHaveLength(2);
    expect(telemetry.toolCalls).toBe(records);
  });
});
