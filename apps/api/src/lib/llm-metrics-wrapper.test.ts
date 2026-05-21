import type { ChatClient, ChatMessage, EmbeddingClient } from "@chatman-media/llm-router";
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
});
