import { describe, expect, it } from "bun:test";
import { ChatApiError, type ChatMessage, type FetchLike } from "../types.ts";
import { OllamaChatClient } from "./ollama-chat.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function ndjsonResponse(lines: string[], status = 200): Response {
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
function client(
  fetch: FetchLike,
  over: Partial<ConstructorParameters<typeof OllamaChatClient>[0]> = {},
) {
  return new OllamaChatClient({ host: "http://ollama:11434/", model: "qwen3", fetch, ...over });
}
const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("OllamaChatClient.complete", () => {
  it("успех: корректный body (think=false, keep_alive, options) и content", async () => {
    const { fn, calls } = capture(() =>
      jsonResponse({ message: { role: "assistant", content: "ответ" }, done: true }),
    );
    const out = await client(fn).complete(MSGS, { temperature: 0.2, numPredict: 64 });
    expect(out).toBe("ответ");
    expect(calls[0]!.url).toBe("http://ollama:11434/api/chat");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.think).toBe(false);
    expect(body.keep_alive).toBe("30m");
    expect(body.options).toMatchObject({ num_ctx: 4096, num_predict: 64, temperature: 0.2 });
  });
  it("HTTP !ok → ChatApiError (текст ошибки)", async () => {
    const { fn } = capture(() => new Response("model not found", { status: 404 }));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("model not found");
  });
  it("non-JSON при 200 → ChatApiError", async () => {
    const { fn } = capture(() => new Response("<html>", { status: 200 }));
    await expect(client(fn).complete(MSGS)).rejects.toBeInstanceOf(ChatApiError);
  });
  it("нет message.content → ChatApiError", async () => {
    const { fn } = capture(() => jsonResponse({ done: true }));
    await expect(client(fn).complete(MSGS)).rejects.toThrow("no message.content");
  });
  it("onUsage: маппит prompt_eval_count/eval_count → prompt/completion токены", async () => {
    const { fn } = capture(() =>
      jsonResponse({
        message: { role: "assistant", content: "ок" },
        done: true,
        prompt_eval_count: 130,
        eval_count: 25,
      }),
    );
    let got: { promptTokens?: number; completionTokens?: number } | undefined;
    await client(fn).complete(MSGS, {
      onUsage: (u) => {
        got = u;
      },
    });
    expect(got).toEqual({ promptTokens: 130, completionTokens: 25 });
  });
  it("onUsage не зовётся когда counts отсутствуют", async () => {
    const { fn } = capture(() =>
      jsonResponse({ message: { role: "assistant", content: "ок" }, done: true }),
    );
    let called = false;
    await client(fn).complete(MSGS, {
      onUsage: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});

describe("OllamaChatClient injectNoThinkHint (через body)", () => {
  it("есть system → /no_think префиксится к нему", async () => {
    const { fn, calls } = capture(() => jsonResponse({ message: { content: "ok" } }));
    await client(fn).complete([
      { role: "system", content: "Ты бот" },
      { role: "user", content: "hi" },
    ]);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages[0]).toMatchObject({ role: "system", content: "/no_think\n\nТы бот" });
  });
  it("нет system → добавляется system-сообщение с /no_think", async () => {
    const { fn, calls } = capture(() => jsonResponse({ message: { content: "ok" } }));
    await client(fn).complete(MSGS);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "/no_think" });
  });
  it("hint уже есть → идемпотентно (не дублируется)", async () => {
    const { fn, calls } = capture(() => jsonResponse({ message: { content: "ok" } }));
    await client(fn).complete([{ role: "system", content: "/no_think base" }, ...MSGS]);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages[0].content).toBe("/no_think base");
  });
  it("disableThinking=false → без инъекции и без think-флага", async () => {
    const { fn, calls } = capture(() => jsonResponse({ message: { content: "ok" } }));
    await client(fn, { disableThinking: false }).complete(MSGS);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages).toEqual(MSGS);
    expect(body.think).toBeUndefined();
  });
});

describe("OllamaChatClient.stream", () => {
  it("парсит NDJSON-токены и стоп на done", async () => {
    const { fn } = capture(() =>
      ndjsonResponse([
        '{"message":{"content":"a"}}\n',
        '{"message":{"content":"b"},"done":true}\n',
        '{"message":{"content":"c"}}\n',
      ]),
    );
    const out: string[] = [];
    for await (const t of client(fn).stream(MSGS)) out.push(t);
    expect(out).toEqual(["a", "b"]); // после done не читаем
  });
  it("!ok → ChatApiError", async () => {
    const { fn } = capture(() => new Response("err", { status: 500 }));
    const it = client(fn).stream(MSGS)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(ChatApiError);
  });
});
