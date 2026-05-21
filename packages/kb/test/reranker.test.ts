import { describe, expect, test } from "bun:test";
import { CohereReranker, JinaReranker } from "../src/reranker.ts";
import type { KbSearchHit } from "../src/types.ts";

function hit(chunk_id: number): KbSearchHit {
  return {
    chunk_id,
    distance: 0,
    text: `chunk ${chunk_id}`,
    document_id: 1,
    source: "test",
    title: "Test",
  };
}

/** Builds a `fetch` stub that returns the given rerank `results` payload. */
function mockFetch(results: Array<{ index: number; relevance_score: number }>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe.each([
  ["CohereReranker", (f: typeof fetch) => new CohereReranker({ apiKey: "k", fetch: f })],
  ["JinaReranker", (f: typeof fetch) => new JinaReranker({ apiKey: "k", fetch: f })],
] as const)("%s", (_name, make) => {
  test("returns hits unchanged for an empty input", async () => {
    const reranker = make(mockFetch([]));
    expect(await reranker.rerank("q", [])).toEqual([]);
  });

  test("drops results whose index is out of range", async () => {
    const hits = [hit(10), hit(20)];
    const reranker = make(
      mockFetch([
        { index: 0, relevance_score: 0.9 },
        { index: 5, relevance_score: 0.8 }, // out of range — must be dropped
        { index: 1, relevance_score: 0.7 },
      ]),
    );
    const out = await reranker.rerank("q", hits, 3);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.chunk_id)).toEqual([10, 20]);
    // No malformed hit leaks through — every result keeps its KB fields.
    for (const h of out) {
      expect(typeof h.chunk_id).toBe("number");
      expect(typeof h.text).toBe("string");
    }
  });

  test("remaps relevance_score to distance (1 - score)", async () => {
    const reranker = make(mockFetch([{ index: 0, relevance_score: 0.75 }]));
    const out = await reranker.rerank("q", [hit(10)]);
    expect(out[0]?.distance).toBeCloseTo(0.25);
  });
});
