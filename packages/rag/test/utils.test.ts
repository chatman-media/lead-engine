import { describe, expect, test } from "bun:test";
import type { KbSearchHit } from "../src/types.ts";
import { reciprocalRankFusion, sanitizeFtsQuery } from "../src/utils.ts";

function hit(chunk_id: number, distance = 0): KbSearchHit {
  return {
    chunk_id,
    distance,
    text: `chunk ${chunk_id}`,
    document_id: 1,
    source: "test",
    title: "Test",
  };
}

describe("reciprocalRankFusion", () => {
  test("returns vector hits sliced to k when bm25 is empty", () => {
    const vec = [hit(1), hit(2), hit(3)];
    const fused = reciprocalRankFusion(vec, [], 2);
    expect(fused.map((h) => h.chunk_id)).toEqual([1, 2]);
  });

  test("returns bm25 hits sliced to k when vector is empty", () => {
    const bm25 = [hit(4), hit(5), hit(6)];
    const fused = reciprocalRankFusion([], bm25, 2);
    expect(fused.map((h) => h.chunk_id)).toEqual([4, 5]);
  });

  test("a chunk present in both lists outranks chunks present in only one", () => {
    const vec = [hit(1), hit(2)];
    const bm25 = [hit(3), hit(1)];
    const fused = reciprocalRankFusion(vec, bm25, 3);
    expect(fused[0]?.chunk_id).toBe(1);
  });

  test("truncates the fused result to k", () => {
    const vec = [hit(1), hit(2), hit(3)];
    const bm25 = [hit(4), hit(5), hit(6)];
    expect(reciprocalRankFusion(vec, bm25, 2)).toHaveLength(2);
  });

  test("remaps distance to 1 - fused score and sorts descending by score", () => {
    const vec = [hit(1), hit(2)];
    const bm25 = [hit(1)];
    const fused = reciprocalRankFusion(vec, bm25, 2);
    // chunk 1 scores in both lists, chunk 2 only in vector → 1 ranks first.
    expect(fused[0]?.chunk_id).toBe(1);
    expect(fused[1]?.chunk_id).toBe(2);
    // distance = 1 - score, and a higher score means a lower distance.
    expect(fused[0]?.distance).toBeLessThan(fused[1]?.distance ?? Number.NaN);
  });

  test("a smaller rrfK widens the score gap between ranks", () => {
    const vec = [hit(1), hit(2)];
    const bm25 = [hit(1), hit(2)];
    const tight = reciprocalRankFusion(vec, bm25, 2, 1);
    const loose = reciprocalRankFusion(vec, bm25, 2, 1000);
    const tightGap = (tight[1]?.distance ?? 0) - (tight[0]?.distance ?? 0);
    const looseGap = (loose[1]?.distance ?? 0) - (loose[0]?.distance ?? 0);
    expect(tightGap).toBeGreaterThan(looseGap);
  });
});

describe("sanitizeFtsQuery", () => {
  test("returns empty string for empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
  });

  test("builds prefix-OR query from multiple tokens", () => {
    expect(sanitizeFtsQuery("виза оформляется")).toBe("виза:* | оформляется:*");
  });

  test("drops tokens shorter than 2 characters", () => {
    expect(sanitizeFtsQuery("я виза")).toBe("виза:*");
  });

  test("strips tsquery operators and boolean keywords to prevent injection", () => {
    expect(sanitizeFtsQuery('OR "injection"')).toBe("injection:*");
  });

  test("returns empty string when no usable tokens remain", () => {
    expect(sanitizeFtsQuery("( ) * :")).toBe("");
  });
});
