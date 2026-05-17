import { describe, expect, test } from "bun:test";
import type { AnswerResult } from "../src/answer-types.ts";
import type { EmbeddingClient } from "../src/embed.ts";
import { SemanticCache } from "../src/semantic-cache.ts";

/**
 * Deterministic embedder: each distinct string maps to a unique one-hot
 * vector. Identical strings → cosine similarity 1; different strings →
 * orthogonal vectors → cosine similarity 0.
 */
class OneHotEmbedder implements EmbeddingClient {
  readonly dim = 16;
  private readonly index = new Map<string, number>();

  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((s) => {
      let i = this.index.get(s);
      if (i === undefined) {
        i = this.index.size;
        this.index.set(s, i);
      }
      const v = new Array<number>(this.dim).fill(0);
      v[i % this.dim] = 1;
      return v;
    });
  }
}

function makeResult(text: string): AnswerResult {
  return { text, usedChunkIds: [], hits: [], telemetry: { path: "ok" } };
}

describe("SemanticCache", () => {
  test("misses on the first lookup and runs the producer", async () => {
    const cache = new SemanticCache(new OneHotEmbedder());
    let calls = 0;
    const result = await cache.getOrSet("question one", async () => {
      calls++;
      return makeResult("answer one");
    });
    expect(calls).toBe(1);
    expect(result.text).toBe("answer one");
    expect(cache.misses).toBe(1);
    expect(cache.size).toBe(1);
  });

  test("hits on a repeated question and skips the producer", async () => {
    const cache = new SemanticCache(new OneHotEmbedder());
    await cache.getOrSet("repeat me", async () => makeResult("cached answer"));

    let calls = 0;
    const result = await cache.getOrSet("repeat me", async () => {
      calls++;
      return makeResult("fresh answer");
    });
    expect(calls).toBe(0);
    expect(result.text).toBe("cached answer");
    expect(result.telemetry.path).toBe("cache_hit");
    expect(cache.hits).toBe(1);
  });

  test("misses on an unrelated question", async () => {
    const cache = new SemanticCache(new OneHotEmbedder());
    await cache.getOrSet("first topic", async () => makeResult("a"));
    const result = await cache.getOrSet("second topic", async () => makeResult("b"));
    expect(result.text).toBe("b");
    expect(cache.misses).toBe(2);
  });

  test("prime inserts an entry that later hits", async () => {
    const cache = new SemanticCache(new OneHotEmbedder());
    await cache.prime("primed question", makeResult("primed answer"));
    let calls = 0;
    const result = await cache.getOrSet("primed question", async () => {
      calls++;
      return makeResult("should not run");
    });
    expect(calls).toBe(0);
    expect(result.text).toBe("primed answer");
  });

  test("clear empties the cache", async () => {
    const cache = new SemanticCache(new OneHotEmbedder());
    await cache.getOrSet("something", async () => makeResult("x"));
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
