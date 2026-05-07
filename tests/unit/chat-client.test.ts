import { describe, expect, test } from "bun:test";

import { ChatApiError, type ChatMessage, type FetchLike, OpenAIChatClient } from "@/rag/chat.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { model: string; messages: ChatMessage[]; temperature?: number };
}

function fakeFetch(responder: (call: RecordedCall) => Response): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    const body = JSON.parse((init!.body as string) ?? "{}");
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    return responder(call);
  };
  return { fetchImpl, calls };
}

describe("OpenAIChatClient", () => {
  test("posts /chat/completions and returns assistant text", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      expect(call.url).toBe("https://api.test/v1/chat/completions");
      expect(call.headers.authorization).toBe("Bearer K");
      expect(call.body.model).toBe("gpt-4o-mini");
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "hello back" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new OpenAIChatClient({
      apiKey: "K",
      baseUrl: "https://api.test/v1",
      model: "gpt-4o-mini",
      fetch: fetchImpl,
    });
    const reply = await client.complete([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(reply).toBe("hello back");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  test("throws ChatApiError on non-2xx", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "rate limit" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new OpenAIChatClient({
      apiKey: "K",
      baseUrl: "http://x",
      model: "m",
      fetch: fetchImpl,
    });
    await expect(client.complete([])).rejects.toBeInstanceOf(ChatApiError);
  });

  test("throws when no choices in response", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new OpenAIChatClient({
      apiKey: "K",
      baseUrl: "http://x",
      model: "m",
      fetch: fetchImpl,
    });
    await expect(client.complete([])).rejects.toThrow(/choices/i);
  });

  test("forwards temperature when provided", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "x" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new OpenAIChatClient({
      apiKey: "K",
      baseUrl: "http://x",
      model: "m",
      fetch: fetchImpl,
    });
    await client.complete([{ role: "user", content: "x" }], {
      temperature: 0.1,
    });
    expect(calls[0]!.body.temperature).toBe(0.1);
  });
});
