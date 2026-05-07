import { describe, expect, test } from "bun:test";

import { EmbeddingApiError } from "@/rag/embed.ts";
import { type FetchLike, OllamaEmbeddingClient } from "@/rag/providers/ollama-embed.ts";

interface RecordedCall {
  url: string;
  body: { model: string; input: string[] | string };
}

function fakeFetch(responder: (call: RecordedCall) => Response): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = JSON.parse((init?.body as string) ?? "{}");
    calls.push({ url, body });
    return responder({ url, body });
  };
  return { fetchImpl, calls };
}

function ok(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OllamaEmbeddingClient", () => {
  test("posts /api/embed with input array and returns vectors in same order", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      expect(call.url).toBe("http://ollama.test:11434/api/embed");
      expect(call.body.model).toBe("nomic-embed-text");
      expect(call.body.input).toEqual(["a", "b"]);
      return ok({
        model: "nomic-embed-text",
        embeddings: [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
      });
    });
    const client = new OllamaEmbeddingClient({
      host: "http://ollama.test:11434",
      model: "nomic-embed-text",
      dim: 4,
      fetch: fetchImpl,
    });
    const out = await client.embed(["a", "b"]);
    expect(out).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
    ]);
    expect(calls).toHaveLength(1);
  });

  test("throws EmbeddingApiError on non-2xx", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("nope", { status: 500 }));
    const client = new OllamaEmbeddingClient({
      host: "http://x:1",
      model: "m",
      dim: 3,
      fetch: fetchImpl,
    });
    await expect(client.embed(["x"])).rejects.toBeInstanceOf(EmbeddingApiError);
  });

  test("throws when returned vector dim mismatches configured dim", async () => {
    const { fetchImpl } = fakeFetch(() => ok({ embeddings: [[1, 2, 3]] }));
    const client = new OllamaEmbeddingClient({
      host: "http://x:1",
      model: "m",
      dim: 4,
      fetch: fetchImpl,
    });
    await expect(client.embed(["x"])).rejects.toThrow(/dim/i);
  });

  test("empty input returns [] without making a request", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response("", { status: 200 });
    };
    const client = new OllamaEmbeddingClient({
      host: "http://x:1",
      model: "m",
      dim: 4,
      fetch: fetchImpl,
    });
    expect(await client.embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  test("throws when count of returned vectors mismatches inputs", async () => {
    const { fetchImpl } = fakeFetch(() => ok({ embeddings: [[1, 0]] }));
    const client = new OllamaEmbeddingClient({
      host: "http://x:1",
      model: "m",
      dim: 2,
      fetch: fetchImpl,
    });
    await expect(client.embed(["a", "b"])).rejects.toThrow(/expected 2/i);
  });
});
