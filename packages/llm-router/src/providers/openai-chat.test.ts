import { describe, expect, it } from "bun:test";
import { ChatApiError, type FetchLike } from "../types.ts";
import { OpenAIChatClient } from "./openai-chat.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function client(fetch: FetchLike, over: Partial<ConstructorParameters<typeof OpenAIChatClient>[0]> = {}) {
  return new OpenAIChatClient({ apiKey: "k", baseUrl: "https://x/v1", model: "gpt-test", fetch, ...over });
}

const MSGS = [{ role: "user" as const, content: "hi" }];

describe("OpenAIChatClient constructor", () => {
  it("требует apiKey", () => {
    expect(() => new OpenAIChatClient({ apiKey: "", baseUrl: "https://x/v1", model: "m" })).toThrow();
  });
  it("срезает хвостовые слэши baseUrl", async () => {
    const { fn, calls } = capture(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await client(fn, { baseUrl: "https://x/v1///" }).complete(MSGS);
    expect(calls[0]!.url).toBe("https://x/v1/chat/completions");
  });
});

describe("OpenAIChatClient.complete", () => {
  it("шлёт корректный запрос и возвращает content", async () => {
    const { fn, calls } = capture(() => jsonResponse({ choices: [{ message: { content: "Привет" } }] }));
    const out = await client(fn).complete(MSGS, { temperature: 0.5, numPredict: 100 });
    expect(out).toBe("Привет");
    expect(calls[0]!.url).toBe("https://x/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ model: "gpt-test", temperature: 0.5, max_tokens: 100 });
    expect(body.messages).toEqual(MSGS);
  });
  it("non-JSON → ChatApiError", async () => {
    const { fn } = capture(() => new Response("<html>", { status: 200 }));
    await expect(client(fn).complete(MSGS)).rejects.toBeInstanceOf(ChatApiError);
  });
  it("HTTP !ok → ChatApiError с message из payload", async () => {
    const { fn } = capture(() => jsonResponse({ error: { message: "bad key" } }, 401));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("bad key");
  });
  it("пустой choices → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [] }));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("no choices");
  });
});

describe("OpenAIChatClient.completeWithTools", () => {
  it("возвращает tool_calls когда модель их вернула", async () => {
    const { fn } = capture(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t1", type: "function", function: { name: "calc", arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
    );
    const res = await client(fn).completeWithTools(MSGS, []);
    expect(res.content).toBeNull();
    expect(res.toolCalls).toEqual([{ id: "t1", name: "calc", args: { a: 1 } }]);
  });
  it("возвращает текст когда tool_calls нет", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [{ message: { role: "assistant", content: "text" } }] }));
    const res = await client(fn).completeWithTools(MSGS, []);
    expect(res).toEqual({ content: "text", toolCalls: [] });
  });
  it("!ok → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ error: { message: "boom" } }, 500));
    await expect(client(fn).completeWithTools(MSGS, [])).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("OpenAIChatClient.completeStructured", () => {
  it("отправляет response_format json_schema и возвращает content", async () => {
    const { fn, calls } = capture(() => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const out = await client(fn).completeStructured(MSGS, { type: "object" });
    expect(out).toBe('{"ok":true}');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
  });
  it("нет content → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [{ message: { content: null } }] }));
    await expect(client(fn).completeStructured(MSGS, {})).rejects.toThrow("no content");
  });
});

describe("OpenAIChatClient.stream", () => {
  it("отдаёт токены из SSE и останавливается на [DONE]", async () => {
    const { fn } = capture(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const out: string[] = [];
    for await (const t of client(fn).stream(MSGS)) out.push(t);
    expect(out).toEqual(["He", "llo"]);
  });
  it("!ok → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ error: { message: "stream fail" } }, 500));
    const it = client(fn).stream(MSGS)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("OpenAIChatClient usage reporting", () => {
  const USAGE = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 };

  it("complete: onUsage получает распарсенные токены", async () => {
    const { fn } = capture(() =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: USAGE }),
    );
    let got: unknown;
    await client(fn).complete(MSGS, {
      onUsage: (u) => {
        got = u;
      },
    });
    expect(got).toEqual({ promptTokens: 42, completionTokens: 7, totalTokens: 49 });
  });

  it("completeWithTools: onUsage вызывается", async () => {
    const { fn } = capture(() =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "t" } }], usage: USAGE }),
    );
    let got: { promptTokens?: number; completionTokens?: number } | undefined;
    await client(fn).completeWithTools(MSGS, [], {
      onUsage: (u) => {
        got = u;
      },
    });
    expect(got).toMatchObject({ promptTokens: 42, completionTokens: 7 });
  });

  it("completeStructured: onUsage вызывается", async () => {
    const { fn } = capture(() =>
      jsonResponse({ choices: [{ message: { content: "{}" } }], usage: USAGE }),
    );
    let got: { promptTokens?: number } | undefined;
    await client(fn).completeStructured(MSGS, {}, {
      onUsage: (u) => {
        got = u;
      },
    });
    expect(got).toMatchObject({ promptTokens: 42 });
  });

  it("usage отсутствует → onUsage не зовётся", async () => {
    const { fn } = capture(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    let called = false;
    await client(fn).complete(MSGS, {
      onUsage: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("частичный usage (только prompt_tokens) → только promptTokens", async () => {
    const { fn } = capture(() =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12 } }),
    );
    let got: Record<string, unknown> | undefined;
    await client(fn).complete(MSGS, {
      onUsage: (u) => {
        got = u as Record<string, unknown>;
      },
    });
    expect(got).toEqual({ promptTokens: 12 });
  });
});
