import { describe, expect, it } from "bun:test";
import {
  ChatApiError,
  ChatTruncatedError,
  EmbeddingApiError,
  NullEmbeddingClient,
  parseOpenAiSseStream,
} from "./types.ts";

function sse(...lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of stream) out.push(t);
  return out;
}

describe("parseOpenAiSseStream", () => {
  it("отдаёт content-дельты в порядке", async () => {
    const out = await collect(
      parseOpenAiSseStream(
        sse(
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        ),
      ),
    );
    expect(out).toEqual(["Hel", "lo"]);
  });
  it("останавливается на [DONE]", async () => {
    const out = await collect(
      parseOpenAiSseStream(
        sse('data: {"choices":[{"delta":{"content":"a"}}]}\n', "data: [DONE]\n", 'data: {"choices":[{"delta":{"content":"b"}}]}\n'),
      ),
    );
    expect(out).toEqual(["a"]);
  });
  it("пропускает битые JSON и не-data строки", async () => {
    const out = await collect(
      parseOpenAiSseStream(sse(": comment\n", "data: {broken\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n')),
    );
    expect(out).toEqual(["ok"]);
  });
  it("пропускает дельты без content", async () => {
    const out = await collect(
      parseOpenAiSseStream(sse('data: {"choices":[{"delta":{}}]}\n', 'data: {"choices":[{"delta":{"content":"x"}}]}\n')),
    );
    expect(out).toEqual(["x"]);
  });
});

describe("ошибки", () => {
  it("ChatApiError несёт statusCode и форматирует message", () => {
    const e = new ChatApiError(429, "rate limited");
    expect(e.statusCode).toBe(429);
    expect(e.name).toBe("ChatApiError");
    expect(e.message).toContain("429");
    expect(e.message).toContain("rate limited");
  });
  it("EmbeddingApiError форматирует message", () => {
    const e = new EmbeddingApiError(500, "oom");
    expect(e.message).toContain("500");
    expect(e.name).toBe("EmbeddingApiError");
  });
  it("ChatTruncatedError — подкласс ChatApiError, несёт partial/finishReason", () => {
    const e = new ChatTruncatedError("частичный ответ", 256, "length");
    expect(e).toBeInstanceOf(ChatApiError);
    expect(e.statusCode).toBe(599);
    expect(e.partial).toBe("частичный ответ");
    expect(e.numPredict).toBe(256);
    expect(e.message).toContain("finish_reason=length");
  });
});

describe("NullEmbeddingClient", () => {
  it("возвращает нулевые векторы заданной размерности по числу входов", async () => {
    const c = new NullEmbeddingClient(4);
    expect(c.dim).toBe(4);
    const out = await c.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual([0, 0, 0, 0]);
  });
});
