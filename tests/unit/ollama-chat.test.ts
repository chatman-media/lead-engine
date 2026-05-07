import { describe, expect, test } from "bun:test";
import { ChatApiError, type ChatMessage } from "@/rag/chat.ts";
import { type FetchLike, OllamaChatClient } from "@/rag/providers/ollama-chat.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: {
    model: string;
    messages: ChatMessage[];
    stream: boolean;
    options?: Record<string, unknown>;
    think?: boolean;
    keep_alive?: string;
  };
}

function fakeFetch(responder: (call: RecordedCall) => Response): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = JSON.parse((init?.body as string) ?? "{}");
    calls.push({ url, method: init?.method ?? "GET", body });
    return responder({ url, method: init?.method ?? "GET", body });
  };
  return { fetchImpl, calls };
}

function ok(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OllamaChatClient", () => {
  test("posts /api/chat with stream=false and returns assistant content", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      expect(call.url).toBe("http://ollama.test:11434/api/chat");
      expect(call.method).toBe("POST");
      expect(call.body.model).toBe("llama3.1");
      expect(call.body.stream).toBe(false);
      // disableThinking defaults to true → request carries think:false +
      // /no_think hint as a synthetic system message (idempotent).
      expect(call.body.think).toBe(false);
      expect(call.body.messages).toEqual([
        { role: "system", content: "/no_think" },
        { role: "user", content: "hi" },
      ]);
      // Conservative defaults to keep KV-cache + reply length tight.
      expect(call.body.options?.num_ctx).toBe(4096);
      expect(call.body.options?.num_predict).toBe(256);
      expect(call.body.keep_alive).toBe("30m");
      return ok({
        model: "llama3.1",
        message: { role: "assistant", content: "hello back" },
        done: true,
      });
    });
    const client = new OllamaChatClient({
      host: "http://ollama.test:11434",
      model: "llama3.1",
      fetch: fetchImpl,
    });
    const reply = await client.complete([{ role: "user", content: "hi" }]);
    expect(reply).toBe("hello back");
    expect(calls).toHaveLength(1);
  });

  test("disableThinking:false leaves messages untouched and omits think flag", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      ok({ message: { role: "assistant", content: "x" }, done: true }),
    );
    const client = new OllamaChatClient({
      host: "http://x:1",
      model: "m",
      fetch: fetchImpl,
      disableThinking: false,
    });
    await client.complete([{ role: "user", content: "hi" }]);
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(calls[0]!.body.think).toBeUndefined();
  });

  test("/no_think hint is appended to existing system prompt, not duplicated", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      ok({ message: { role: "assistant", content: "x" }, done: true }),
    );
    const client = new OllamaChatClient({
      host: "http://x:1",
      model: "m",
      fetch: fetchImpl,
    });
    await client.complete([
      { role: "system", content: "Speak Russian only." },
      { role: "user", content: "hi" },
    ]);
    const sys = calls[0]!.body.messages[0]!;
    expect(sys.role).toBe("system");
    expect(sys.content).toBe("/no_think\n\nSpeak Russian only.");
    expect(calls[0]!.body.messages).toHaveLength(2);
  });

  test("forwards temperature via options.temperature", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      ok({ message: { role: "assistant", content: "x" }, done: true }),
    );
    const client = new OllamaChatClient({
      host: "http://x:1",
      model: "m",
      fetch: fetchImpl,
    });
    await client.complete([{ role: "user", content: "y" }], { temperature: 0.3 });
    expect(calls[0]!.body.options?.temperature).toBe(0.3);
  });

  test("strips trailing slash from host before joining /api/chat", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      ok({ message: { role: "assistant", content: "x" }, done: true }),
    );
    const client = new OllamaChatClient({
      host: "http://x:1/",
      model: "m",
      fetch: fetchImpl,
    });
    await client.complete([]);
    expect(calls[0]!.url).toBe("http://x:1/api/chat");
  });

  test("throws ChatApiError on non-2xx", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("bad", { status: 500 }));
    const client = new OllamaChatClient({
      host: "http://x:1",
      model: "m",
      fetch: fetchImpl,
    });
    await expect(client.complete([])).rejects.toBeInstanceOf(ChatApiError);
  });

  test("throws when no message.content present", async () => {
    const { fetchImpl } = fakeFetch(() => ok({ done: true }));
    const client = new OllamaChatClient({
      host: "http://x:1",
      model: "m",
      fetch: fetchImpl,
    });
    await expect(client.complete([])).rejects.toThrow(/content/i);
  });
});
