import type {
  ChatClient,
  ChatMessage,
  EmbeddingClient,
  TokenUsage,
} from "@chatman-media/llm-router";
import { makePlatformMetrics } from "@chatman-media/observability";
import { describe, expect, it } from "bun:test";
import { wrapChatClient, wrapEmbeddingClient } from "./llm-metrics-wrapper.ts";

function fakeChat(behaviour: { reply?: string; throwError?: Error } = {}): ChatClient {
  return {
    async complete(_messages: ChatMessage[]): Promise<string> {
      if (behaviour.throwError) throw behaviour.throwError;
      return behaviour.reply ?? "ok";
    },
  };
}

function fakeEmbed(behaviour: { vec?: number[]; throwError?: Error } = {}): EmbeddingClient {
  return {
    dim: 4,
    async embed(inputs: string[]): Promise<number[][]> {
      if (behaviour.throwError) throw behaviour.throwError;
      const vec = behaviour.vec ?? [0, 0, 0, 0];
      return inputs.map(() => vec);
    },
  };
}

describe("wrapChatClient", () => {
  it("инкрементит llmCalls per .complete()", async () => {
    const metrics = makePlatformMetrics();
    const wrapped = wrapChatClient(fakeChat(), metrics, {
      provider: "openai",
      purpose: "chat",
    });
    await wrapped.complete([{ role: "user", content: "hi" }]);
    await wrapped.complete([{ role: "user", content: "hi again" }]);
    const exposed = metrics.registry.format();
    expect(exposed).toContain(
      'lead_engine_llm_calls_total{provider="openai",purpose="chat"} 2',
    );
  });

  it("прокидывает return value наверх", async () => {
    const metrics = makePlatformMetrics();
    const wrapped = wrapChatClient(fakeChat({ reply: "structured-reply" }), metrics, {
      provider: "openai",
      purpose: "chat",
    });
    const result = await wrapped.complete([{ role: "user", content: "x" }]);
    expect(result).toBe("structured-reply");
  });

  it("exception → llmErrors с kind=err.name, и re-throws", async () => {
    const metrics = makePlatformMetrics();
    class CustomError extends Error {
      constructor() {
        super("boom");
        this.name = "CustomError";
      }
    }
    const wrapped = wrapChatClient(fakeChat({ throwError: new CustomError() }), metrics, {
      provider: "openai",
      purpose: "chat",
    });
    await expect(wrapped.complete([{ role: "user", content: "x" }])).rejects.toThrow("boom");
    const exposed = metrics.registry.format();
    expect(exposed).toContain('lead_engine_llm_calls_total{provider="openai",purpose="chat"} 1');
    expect(exposed).toContain(
      'lead_engine_llm_errors_total{kind="CustomError",provider="openai",purpose="chat"} 1',
    );
  });

  it("разные purpose labels — отдельные counter-series", async () => {
    const metrics = makePlatformMetrics();
    const chat = wrapChatClient(fakeChat(), metrics, { provider: "openai", purpose: "chat" });
    const memory = wrapChatClient(fakeChat(), metrics, {
      provider: "openai",
      purpose: "memory",
    });
    await chat.complete([{ role: "user", content: "x" }]);
    await chat.complete([{ role: "user", content: "x" }]);
    await memory.complete([{ role: "user", content: "x" }]);
    const exposed = metrics.registry.format();
    expect(exposed).toContain(
      'lead_engine_llm_calls_total{provider="openai",purpose="chat"} 2',
    );
    expect(exposed).toContain(
      'lead_engine_llm_calls_total{provider="openai",purpose="memory"} 1',
    );
  });

  it("non-Error throws → kind='unknown'", async () => {
    const metrics = makePlatformMetrics();
    const wrapped: ChatClient = {
      async complete(): Promise<string> {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string error";
      },
    };
    const w = wrapChatClient(wrapped, metrics, { provider: "ollama", purpose: "chat" });
    await expect(w.complete([{ role: "user", content: "x" }])).rejects.toBe("string error");
    expect(metrics.registry.format()).toContain('kind="unknown"');
  });
});

describe("wrapEmbeddingClient", () => {
  it("инкрементит llmCalls per .embed() (батчем не per-input)", async () => {
    const metrics = makePlatformMetrics();
    const wrapped = wrapEmbeddingClient(fakeEmbed(), metrics, {
      provider: "openai",
      purpose: "embed",
    });
    await wrapped.embed(["a", "b", "c"]);
    await wrapped.embed(["d"]);
    expect(metrics.registry.format()).toContain(
      'lead_engine_llm_calls_total{provider="openai",purpose="embed"} 2',
    );
  });

  it("прокидывает dim из inner", () => {
    const metrics = makePlatformMetrics();
    const wrapped = wrapEmbeddingClient(fakeEmbed(), metrics, {
      provider: "openai",
      purpose: "embed",
    });
    expect(wrapped.dim).toBe(4);
  });

  it("exception → llmErrors с kind, и re-throws", async () => {
    const metrics = makePlatformMetrics();
    const wrapped = wrapEmbeddingClient(
      fakeEmbed({ throwError: new TypeError("network down") }),
      metrics,
      { provider: "openai", purpose: "embed" },
    );
    await expect(wrapped.embed(["x"])).rejects.toThrow("network down");
    expect(metrics.registry.format()).toContain(
      'lead_engine_llm_errors_total{kind="TypeError",provider="openai",purpose="embed"} 1',
    );
  });

  it("onComplete success=true + model label на успешном embed", async () => {
    const metrics = makePlatformMetrics();
    const calls: Array<{ success: boolean; model?: string; latencyMs: number }> = [];
    const wrapped = wrapEmbeddingClient(
      fakeEmbed({ vec: [1, 2, 3, 4] }),
      metrics,
      { provider: "ollama", purpose: "embed", model: "bge-m3" },
      (info) =>
        calls.push({
          success: info.success,
          model: info.model,
          latencyMs: info.latencyMs,
        }),
    );
    const result = await wrapped.embed(["a", "b"]);
    expect(result).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ success: true, model: "bge-m3" });
    expect(calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("onComplete success=false + errorKind при ошибке embed", async () => {
    const metrics = makePlatformMetrics();
    const calls: Array<{ success: boolean; model?: string; errorKind?: string }> = [];
    const wrapped = wrapEmbeddingClient(
      fakeEmbed({ throwError: new RangeError("embed down") }),
      metrics,
      { provider: "ollama", purpose: "embed", model: "bge-m3" },
      (info) =>
        calls.push({
          success: info.success,
          model: info.model,
          errorKind: info.errorKind,
        }),
    );
    await expect(wrapped.embed(["x"])).rejects.toThrow("embed down");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      success: false,
      model: "bge-m3",
      errorKind: "RangeError",
    });
  });

  it("onComplete без model label не добавляет поле model", async () => {
    const metrics = makePlatformMetrics();
    const calls: Array<Record<string, unknown>> = [];
    const wrapped = wrapEmbeddingClient(
      fakeEmbed(),
      metrics,
      { provider: "openai", purpose: "embed" },
      (info) => calls.push(info as unknown as Record<string, unknown>),
    );
    await wrapped.embed(["x"]);
    expect(calls).toHaveLength(1);
    expect("model" in calls[0]!).toBe(false);
  });
});

// ── completeWithTools / completeStructured / stream (optional methods) ────────
describe("wrapChatClient — optional methods forwarded", () => {
  it("completeWithTools — инкрементит llmCalls, пробрасывает результат", async () => {
    const metrics = makePlatformMetrics();
    const innerWithTools: ChatClient = {
      async complete() { return "ok"; },
      async completeWithTools(_m, _t, _o) { return { content: "tool-result", toolCalls: [] }; },
    };
    const w = wrapChatClient(innerWithTools, metrics, { provider: "openai", purpose: "chat" });
    const result = await w.completeWithTools!([], [], {});
    expect(result.content).toBe("tool-result");
    expect(metrics.registry.format()).toContain(
      'lead_engine_llm_calls_total{provider="openai",purpose="chat"} 1',
    );
  });

  it("completeWithTools error → llmErrors + re-throws", async () => {
    const metrics = makePlatformMetrics();
    const innerErr: ChatClient = {
      async complete() { return "ok"; },
      async completeWithTools() { throw new RangeError("tools-down"); },
    };
    const w = wrapChatClient(innerErr, metrics, { provider: "openai", purpose: "chat" });
    await expect(w.completeWithTools!([], [], {})).rejects.toThrow("tools-down");
    expect(metrics.registry.format()).toContain('kind="RangeError"');
  });

  it("completeStructured — пробрасывает напрямую (без обёртки метрик)", async () => {
    const metrics = makePlatformMetrics();
    const innerStruct: ChatClient = {
      async complete() { return "ok"; },
      async completeStructured() { return JSON.stringify({ result: 42 }); },
    };
    const w = wrapChatClient(innerStruct, metrics, { provider: "openai", purpose: "chat" });
    // biome-ignore lint/suspicious/noExplicitAny: stub
    const res = await w.completeStructured!([], {} as any, {});
    expect((JSON.parse(res) as { result: number }).result).toBe(42);
  });

  it("stream — пробрасывается когда inner поддерживает", async () => {
    const metrics = makePlatformMetrics();
    async function* fakeStream() { yield "chunk1"; yield "chunk2"; }
    const innerStream: ChatClient = {
      async complete() { return "ok"; },
      stream: () => fakeStream(),
    };
    const w = wrapChatClient(innerStream, metrics, { provider: "openai", purpose: "chat" });
    const chunks: string[] = [];
    for await (const chunk of w.stream!([])) chunks.push(chunk);
    expect(chunks).toEqual(["chunk1", "chunk2"]);
  });

  it("клиент без completeWithTools → wrapper не добавляет метод", () => {
    const metrics = makePlatformMetrics();
    const w = wrapChatClient(fakeChat(), metrics, { provider: "openai", purpose: "chat" });
    expect(w.completeWithTools).toBeUndefined();
    expect(w.stream).toBeUndefined();
  });

  it("onComplete callback вызывается с latencyMs и success=true", async () => {
    const metrics = makePlatformMetrics();
    const calls: { success: boolean; latencyMs: number }[] = [];
    const w = wrapChatClient(
      fakeChat({ reply: "hi" }),
      metrics,
      { provider: "openai", purpose: "chat" },
      (info) => calls.push({ success: info.success, latencyMs: info.latencyMs }),
    );
    await w.complete([{ role: "user", content: "x" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.success).toBe(true);
    expect(calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("onComplete callback вызывается с success=false при ошибке", async () => {
    const metrics = makePlatformMetrics();
    const calls: { success: boolean }[] = [];
    const w = wrapChatClient(
      fakeChat({ throwError: new Error("fail") }),
      metrics,
      { provider: "openai", purpose: "chat" },
      (info) => calls.push({ success: info.success }),
    );
    await expect(w.complete([{ role: "user", content: "x" }])).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.success).toBe(false);
  });
});

// ── token usage capture ──────────────────────────────────────────────────────
describe("wrapChatClient — token usage capture", () => {
  function chatWithUsage(usage: TokenUsage): ChatClient {
    return {
      async complete(_m, opts) {
        opts?.onUsage?.(usage);
        return "ok";
      },
      async completeWithTools(_m, _t, opts) {
        opts?.onUsage?.(usage);
        return { content: "ok", toolCalls: [] };
      },
    };
  }

  it("complete: provider onUsage → onComplete получает токены", async () => {
    const metrics = makePlatformMetrics();
    const calls: Array<{ promptTokens?: number; completionTokens?: number }> = [];
    const w = wrapChatClient(
      chatWithUsage({ promptTokens: 100, completionTokens: 20 }),
      metrics,
      { provider: "openai", purpose: "chat" },
      (info) =>
        calls.push({
          promptTokens: info.promptTokens,
          completionTokens: info.completionTokens,
        }),
    );
    await w.complete([{ role: "user", content: "x" }]);
    expect(calls).toEqual([{ promptTokens: 100, completionTokens: 20 }]);
  });

  it("completeWithTools: provider onUsage → onComplete получает токены", async () => {
    const metrics = makePlatformMetrics();
    const calls: Array<{ promptTokens?: number; completionTokens?: number }> = [];
    const w = wrapChatClient(
      chatWithUsage({ promptTokens: 7, completionTokens: 3 }),
      metrics,
      { provider: "openai", purpose: "chat" },
      (info) =>
        calls.push({
          promptTokens: info.promptTokens,
          completionTokens: info.completionTokens,
        }),
    );
    await w.completeWithTools!([], [], {});
    expect(calls).toEqual([{ promptTokens: 7, completionTokens: 3 }]);
  });

  it("provider без usage → onComplete без token-полей", async () => {
    const metrics = makePlatformMetrics();
    const calls: Array<Record<string, unknown>> = [];
    const w = wrapChatClient(
      fakeChat({ reply: "ok" }),
      metrics,
      { provider: "openai", purpose: "chat" },
      (info) => calls.push(info as unknown as Record<string, unknown>),
    );
    await w.complete([{ role: "user", content: "x" }]);
    expect("promptTokens" in calls[0]!).toBe(false);
    expect("completionTokens" in calls[0]!).toBe(false);
  });

  it("сохраняет onUsage вызывающего (chaining, не затирает)", async () => {
    const metrics = makePlatformMetrics();
    const callerSeen: TokenUsage[] = [];
    const recorded: Array<{ promptTokens?: number }> = [];
    const w = wrapChatClient(
      chatWithUsage({ promptTokens: 5 }),
      metrics,
      { provider: "openai", purpose: "chat" },
      (info) => recorded.push({ promptTokens: info.promptTokens }),
    );
    await w.complete([{ role: "user", content: "x" }], {
      onUsage: (u) => callerSeen.push(u),
    });
    expect(recorded).toEqual([{ promptTokens: 5 }]);
    expect(callerSeen).toEqual([{ promptTokens: 5 }]);
  });
});
