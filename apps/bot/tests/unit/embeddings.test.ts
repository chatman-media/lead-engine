import { describe, expect, test } from "bun:test";

import { EmbeddingApiError, type FetchLike, OpenAIEmbeddingClient } from "@/rag/embed.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAIEmbeddingClient", () => {
  test("posts to /embeddings with model + input and returns vectors in order", async () => {
    const dim = 4;
    const { fetchImpl, calls } = fakeFetch((call) => {
      const body = call.body as { model: string; input: string[] };
      expect(call.url).toBe("https://api.test/v1/embeddings");
      expect(call.method).toBe("POST");
      expect(call.headers.authorization).toBe("Bearer KEY");
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.input).toEqual(["a", "b"]);
      return jsonResponse({
        data: [
          { index: 0, embedding: [1, 0, 0, 0] },
          { index: 1, embedding: [0, 1, 0, 0] },
        ],
      });
    });
    const client = new OpenAIEmbeddingClient({
      apiKey: "KEY",
      baseUrl: "https://api.test/v1",
      model: "text-embedding-3-small",
      dim,
      fetch: fetchImpl,
    });
    const vectors = await client.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([1, 0, 0, 0]);
    expect(vectors[1]).toEqual([0, 1, 0, 0]);
    expect(calls).toHaveLength(1);
  });

  test("preserves input order even if API returns out-of-order indices", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      }),
    );
    const client = new OpenAIEmbeddingClient({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      dim: 2,
      fetch: fetchImpl,
    });
    const v = await client.embed(["first", "second"]);
    expect(v[0]).toEqual([1, 1]);
    expect(v[1]).toEqual([9, 9]);
  });

  test("throws EmbeddingApiError on non-2xx with description", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: { message: "bad key" } }, 401));
    const client = new OpenAIEmbeddingClient({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      dim: 2,
      fetch: fetchImpl,
    });
    await expect(client.embed(["x"])).rejects.toBeInstanceOf(EmbeddingApiError);
  });

  test("throws when returned vector dimension mismatches configured dim", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    );
    const client = new OpenAIEmbeddingClient({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      dim: 4,
      fetch: fetchImpl,
    });
    await expect(client.embed(["x"])).rejects.toThrow(/dim/i);
  });

  test("empty input returns empty array without making a request", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response("", { status: 200 });
    };
    const client = new OpenAIEmbeddingClient({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      dim: 2,
      fetch: fetchImpl,
    });
    expect(await client.embed([])).toEqual([]);
    expect(called).toBe(false);
  });
});
