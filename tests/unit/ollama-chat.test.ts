import { describe, expect, test } from "bun:test";

import {
  OllamaChatClient,
  type FetchLike,
} from "@/rag/providers/ollama-chat.ts";
import { ChatApiError, type ChatMessage } from "@/rag/chat.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: {
    model: string;
    messages: ChatMessage[];
    stream: boolean;
    options?: Record<string, unknown>;
  };
}

function fakeFetch(
  responder: (call: RecordedCall) => Response,
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
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
      expect(call.body.messages).toEqual([
        { role: "user", content: "hi" },
      ]);
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
    const { fetchImpl } = fakeFetch(
      () => new Response("bad", { status: 500 }),
    );
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
