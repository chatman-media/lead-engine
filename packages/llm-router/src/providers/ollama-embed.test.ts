import { describe, expect, it } from "bun:test";
import { EmbeddingApiError, type FetchLike } from "../types.ts";
import { OllamaEmbeddingClient } from "./ollama-embed.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function capture(make: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return make();
  }) as unknown as FetchLike;
  return { fn, calls };
}
function client(fetch: FetchLike, dim = 3) {
  return new OllamaEmbeddingClient({ host: "http://ollama:11434//", model: "embed", dim, fetch });
}

describe("OllamaEmbeddingClient.embed", () => {
  it("пустой вход → [] (без запроса)", async () => {
    const { fn, calls } = capture(() => jsonResponse({}));
    expect(await client(fn).embed([])).toEqual([]);
    expect(calls.length).toBe(0);
  });
  it("успех: возвращает векторы и шлёт на /api/embed", async () => {
    const { fn, calls } = capture(() =>
      jsonResponse({
        embeddings: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      }),
    );
    const out = await client(fn).embed(["a", "b"]);
    expect(out).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(calls[0]!.url).toBe("http://ollama:11434/api/embed");
  });
  it("HTTP !ok → EmbeddingApiError", async () => {
    const { fn } = capture(() => new Response("oom", { status: 500 }));
    await expect(client(fn).embed(["a"])).rejects.toBeInstanceOf(EmbeddingApiError);
  });
  it("non-JSON → EmbeddingApiError", async () => {
    const { fn } = capture(() => new Response("nope", { status: 200 }));
    await expect(client(fn).embed(["a"])).rejects.toBeInstanceOf(EmbeddingApiError);
  });
  it("нет поля embeddings → EmbeddingApiError", async () => {
    const { fn } = capture(() => jsonResponse({ foo: 1 }));
    await expect(client(fn).embed(["a"])).rejects.toThrow("missing embeddings");
  });
  it("несовпадение количества → EmbeddingApiError", async () => {
    const { fn } = capture(() => jsonResponse({ embeddings: [[1, 2, 3]] }));
    await expect(client(fn).embed(["a", "b"])).rejects.toThrow("expected 2");
  });
  it("несовпадение размерности → Error", async () => {
    const { fn } = capture(() => jsonResponse({ embeddings: [[1, 2]] }));
    await expect(client(fn, 3).embed(["a"])).rejects.toThrow("dim mismatch");
  });
});
