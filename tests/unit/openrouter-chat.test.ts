import { describe, expect, test } from "bun:test";

import {
  ChatApiError,
  type FetchLike,
  type ChatMessage,
} from "@/rag/chat.ts";
import { OpenRouterChatClient } from "@/rag/providers/openrouter-chat.ts";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function captureFetch(
  impl: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: FetchLike; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    // RequestInit headers can be a few shapes. We only set plain objects in
    // OpenRouterChatClient — tests rely on that.
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body =
      init?.body && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const captured = { url, headers, body };
    calls.push(captured);
    return impl(captured);
  };
  return { fetch: fetchImpl, calls };
}

function ok(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [
        { message: { role: "assistant", content }, finish_reason: "stop" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("OpenRouterChatClient — construction", () => {
  test("throws on missing apiKey", () => {
    expect(
      () =>
        new OpenRouterChatClient({
          apiKey: "",
          model: "anthropic/claude-haiku-4.5",
        }),
    ).toThrow(/apiKey required/);
  });

  test("throws on whitespace-only apiKey", () => {
    expect(
      () =>
        new OpenRouterChatClient({
          apiKey: "   ",
          model: "anthropic/claude-haiku-4.5",
        }),
    ).toThrow(/apiKey required/);
  });

  test("throws on missing model", () => {
    expect(
      () => new OpenRouterChatClient({ apiKey: "sk-or-v1-test", model: "" }),
    ).toThrow(/model required/);
  });
});

describe("OpenRouterChatClient — request shape", () => {
  test("POSTs to {baseUrl}/chat/completions with Authorization header", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test123",
      model: "anthropic/claude-haiku-4.5",
      fetch: cap.fetch,
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(cap.calls.length).toBe(1);
    expect(cap.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(cap.calls[0]!.headers.authorization).toBe("Bearer sk-or-v1-test123");
    expect(cap.calls[0]!.headers["content-type"]).toBe("application/json");
  });

  test("custom baseUrl is honored, trailing slashes stripped", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      baseUrl: "https://my-or-proxy.example.com/v1//",
      fetch: cap.fetch,
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(cap.calls[0]!.url).toBe(
      "https://my-or-proxy.example.com/v1/chat/completions",
    );
  });

  test("siteUrl + appName produce HTTP-Referer + X-Title headers", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      siteUrl: "https://my-app.example.com",
      appName: "tg-chatbot-test",
      fetch: cap.fetch,
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(cap.calls[0]!.headers["HTTP-Referer"]).toBe(
      "https://my-app.example.com",
    );
    expect(cap.calls[0]!.headers["X-Title"]).toBe("tg-chatbot-test");
  });

  test("omits attribution headers when not configured", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(cap.calls[0]!.headers["HTTP-Referer"]).toBeUndefined();
    expect(cap.calls[0]!.headers["X-Title"]).toBeUndefined();
  });

  test("body has model, messages, stream:false", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "anthropic/claude-haiku-4.5",
      fetch: cap.fetch,
    });
    const messages: ChatMessage[] = [
      { role: "system", content: "be a sales bot" },
      { role: "user", content: "hello" },
    ];
    await c.complete(messages);
    expect(cap.calls[0]!.body.model).toBe("anthropic/claude-haiku-4.5");
    expect(cap.calls[0]!.body.stream).toBe(false);
    expect(cap.calls[0]!.body.messages).toEqual(messages);
  });

  test("temperature passed through when provided", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await c.complete([{ role: "user", content: "hi" }], { temperature: 0.85 });
    expect(cap.calls[0]!.body.temperature).toBe(0.85);
  });

  test("temperature omitted from body when not provided (lets API default)", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await c.complete([{ role: "user", content: "hi" }]);
    expect(cap.calls[0]!.body.temperature).toBeUndefined();
  });

  test("system + user messages forwarded as-is (no /no_think injection — that's Ollama-only)", async () => {
    const cap = captureFetch(() => ok("hi"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    const sys = "You are a sales bot.";
    await c.complete([
      { role: "system", content: sys },
      { role: "user", content: "hello" },
    ]);
    const msgs = cap.calls[0]!.body.messages as ChatMessage[];
    expect(msgs[0]?.content).toBe(sys);
    expect(msgs[0]?.content).not.toContain("/no_think");
  });
});

describe("OpenRouterChatClient — response handling", () => {
  test("returns trimmed choices[0].message.content on success", async () => {
    const cap = captureFetch(() => ok("  hello there  \n"));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    const reply = await c.complete([{ role: "user", content: "hi" }]);
    expect(reply).toBe("hello there");
  });
});

describe("OpenRouterChatClient — error paths", () => {
  test("HTTP 401 throws ChatApiError with status + message from payload.error", async () => {
    const cap = captureFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid API key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-bad",
      model: "test/model",
      fetch: cap.fetch,
    });
    let caught: ChatApiError | undefined;
    try {
      await c.complete([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err as ChatApiError;
    }
    expect(caught).toBeInstanceOf(ChatApiError);
    expect(caught?.statusCode).toBe(401);
    expect(caught?.description).toContain("Invalid API key");
  });

  test("HTTP 429 throws with rate-limit message", async () => {
    const cap = captureFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "rate limit hit" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await expect(
      c.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/rate limit/);
  });

  test("payload.error on 200 also throws (OR's pattern for some errors)", async () => {
    const cap = captureFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "model not found", code: 404 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "made-up/model",
      fetch: cap.fetch,
    });
    await expect(
      c.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/model not found/);
  });

  test("missing choices[0].message.content throws", async () => {
    const cap = captureFetch(
      () =>
        new Response(JSON.stringify({ id: "x", choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await expect(
      c.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/no choices/);
  });

  test("empty content treated as protocol violation", async () => {
    const cap = captureFetch(() => ok(""));
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await expect(
      c.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/no choices/);
  });

  test("network error wraps as 'OpenRouter unreachable'", async () => {
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: (async () => {
        throw new TypeError("connection refused");
      }) as FetchLike,
    });
    let caught: ChatApiError | undefined;
    try {
      await c.complete([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err as ChatApiError;
    }
    expect(caught).toBeInstanceOf(ChatApiError);
    expect(caught?.description).toContain("OpenRouter unreachable");
    expect(caught?.description).toContain("connection refused");
  });

  test("non-JSON 200 response throws", async () => {
    const cap = captureFetch(
      () =>
        new Response("<html>oops</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const c = new OpenRouterChatClient({
      apiKey: "sk-or-v1-test",
      model: "test/model",
      fetch: cap.fetch,
    });
    await expect(
      c.complete([{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/non-JSON/);
  });
});
