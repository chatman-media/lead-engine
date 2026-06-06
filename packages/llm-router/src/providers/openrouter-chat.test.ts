import { describe, expect, it } from "bun:test";
import { ChatApiError, type FetchLike } from "../types.ts";
import { OpenRouterChatClient } from "./openrouter-chat.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function sseResponse(lines: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(stream, { status });
}
function capture(make: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return make();
  }) as unknown as FetchLike;
  return { fn, calls };
}
function throwingFetch(): FetchLike {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as FetchLike;
}
function client(fetch: FetchLike, over: Partial<ConstructorParameters<typeof OpenRouterChatClient>[0]> = {}) {
  return new OpenRouterChatClient({ apiKey: "k", model: "anthropic/claude", fetch, ...over });
}
const MSGS = [{ role: "user" as const, content: "hi" }];

describe("OpenRouterChatClient constructor", () => {
  it("требует apiKey и model", () => {
    expect(() => new OpenRouterChatClient({ apiKey: "", model: "m" })).toThrow("apiKey");
    expect(() => new OpenRouterChatClient({ apiKey: "k", model: "" })).toThrow("model");
  });
  it("дефолтный baseUrl = openrouter.ai/api/v1", async () => {
    const { fn, calls } = capture(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await client(fn).complete(MSGS);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("OpenRouterChatClient.complete", () => {
  it("возвращает trimmed content + проставляет attribution-заголовки", async () => {
    const { fn, calls } = capture(() => jsonResponse({ choices: [{ message: { content: "  hey  " } }] }));
    const out = await client(fn, { siteUrl: "https://app", appName: "LE" }).complete(MSGS);
    expect(out).toBe("hey");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["HTTP-Referer"]).toBe("https://app");
    expect(h["X-Title"]).toBe("LE");
  });
  it("сеть недоступна → ChatApiError(status 0)", async () => {
    await expect(client(throwingFetch()).complete(MSGS)).rejects.toMatchObject({ statusCode: 0 });
  });
  it("non-JSON → ChatApiError", async () => {
    const { fn } = capture(() => new Response("nope", { status: 200 }));
    await expect(client(fn).complete(MSGS)).rejects.toBeInstanceOf(ChatApiError);
  });
  it("HTTP !ok → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ error: { message: "rate limited" } }, 429));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("rate limited");
  });
  it("200 но payload.error → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ error: { message: "model down" } }, 200));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("model down");
  });
  it("пустой content → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [{ message: { content: "   " } }] }));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("no choices");
  });
});

describe("OpenRouterChatClient.completeWithTools", () => {
  it("возвращает tool_calls", async () => {
    const { fn } = capture(() =>
      jsonResponse({
        choices: [{ message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] } }],
      }),
    );
    const res = await client(fn).completeWithTools(MSGS, []);
    expect(res.toolCalls[0]).toMatchObject({ id: "t1", name: "f", args: {} });
  });
  it("сеть недоступна → ChatApiError(0)", async () => {
    await expect(client(throwingFetch()).completeWithTools(MSGS, [])).rejects.toMatchObject({ statusCode: 0 });
  });
});

describe("OpenRouterChatClient.completeStructured", () => {
  it("возвращает content", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [{ message: { content: "{}" } }] }));
    expect(await client(fn).completeStructured(MSGS, {})).toBe("{}");
  });
  it("нет content → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [{ message: { content: "" } }] }));
    await expect(client(fn).completeStructured(MSGS, {})).rejects.toThrow("no content");
  });
});

describe("OpenRouterChatClient.stream", () => {
  it("отдаёт токены и стоп на [DONE]", async () => {
    const { fn } = capture(() =>
      sseResponse(['data: {"choices":[{"delta":{"content":"A"}}]}\n', "data: [DONE]\n"]),
    );
    const out: string[] = [];
    for await (const t of client(fn).stream(MSGS)) out.push(t);
    expect(out).toEqual(["A"]);
  });
  it("!ok → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ error: { message: "x" } }, 500));
    const it = client(fn).stream(MSGS)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(ChatApiError);
  });
  it("сеть недоступна → ChatApiError(0)", async () => {
    const it = client(throwingFetch()).stream(MSGS)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ statusCode: 0 });
  });
});
