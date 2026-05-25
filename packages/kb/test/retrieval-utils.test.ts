import { describe, expect, it } from "bun:test";
import { applyDynamicThreshold, mmrDiversify, rrfMerge } from "../src/retrieval-utils.ts";
import type { KbSearchHit } from "../src/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function hit(chunk_id: number, distance: number, text: string): KbSearchHit {
  return { chunk_id, distance, text, document_id: chunk_id, source: "test", title: "Test" };
}

// ── applyDynamicThreshold ────────────────────────────────────────────────────

describe("applyDynamicThreshold", () => {
  it("keeps hits with distance <= threshold", () => {
    const hits = [hit(1, 0.1, "a"), hit(2, 0.4, "b"), hit(3, 0.5, "c")];
    expect(applyDynamicThreshold(hits, { threshold: 0.45 })).toHaveLength(2);
  });

  it("respects minHits — never returns empty array when hits are present", () => {
    const hits = [hit(1, 0.9, "a"), hit(2, 0.95, "b")];
    const result = applyDynamicThreshold(hits, { threshold: 0.3, minHits: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.chunk_id).toBe(1); // keeps the closest
  });

  it("returns all hits when all are within threshold", () => {
    const hits = [hit(1, 0.1, "a"), hit(2, 0.2, "b")];
    expect(applyDynamicThreshold(hits, { threshold: 0.5 })).toHaveLength(2);
  });

  it("returns empty array when input is empty", () => {
    expect(applyDynamicThreshold([])).toHaveLength(0);
  });

  it("uses default threshold of 0.45", () => {
    const hits = [hit(1, 0.3, "a"), hit(2, 0.46, "b")];
    const result = applyDynamicThreshold(hits);
    expect(result).toHaveLength(1);
    expect(result[0]!.chunk_id).toBe(1);
  });
});

// ── mmrDiversify ─────────────────────────────────────────────────────────────

describe("mmrDiversify", () => {
  it("returns same order when lambda=1 (pure relevance)", () => {
    const hits = [hit(1, 0.1, "alpha beta"), hit(2, 0.2, "gamma delta"), hit(3, 0.3, "epsilon")];
    const result = mmrDiversify(hits, { lambda: 1.0 });
    // With lambda=1 the relevance term dominates — order preserved
    expect(result.map((h) => h.chunk_id)).toEqual([1, 2, 3]);
  });

  it("respects topK — returns at most topK hits", () => {
    const hits = [hit(1, 0.1, "a"), hit(2, 0.2, "b"), hit(3, 0.3, "c"), hit(4, 0.4, "d")];
    expect(mmrDiversify(hits, { topK: 2 })).toHaveLength(2);
  });

  it("returns single-hit input unchanged", () => {
    const hits = [hit(1, 0.2, "only one")];
    const result = mmrDiversify(hits);
    expect(result).toHaveLength(1);
    expect(result[0]!.chunk_id).toBe(1);
  });

  it("returns empty array for empty input", () => {
    expect(mmrDiversify([])).toHaveLength(0);
  });

  it("de-duplicates near-identical chunks when lambda < 0.5", () => {
    // Two nearly identical chunks and one different one.
    const text = "the quick brown fox jumps over the lazy dog";
    const same1 = hit(1, 0.1, text);
    const same2 = hit(2, 0.15, text + " again"); // very similar
    const different = hit(3, 0.3, "mortgage rates real estate investment property dubai");

    // With diversity weight high, the MMR should skip same2 and prefer different
    const result = mmrDiversify([same1, same2, different], { lambda: 0.3, topK: 2 });
    expect(result.map((h) => h.chunk_id)).toContain(1);
    expect(result.map((h) => h.chunk_id)).toContain(3);
    // same2 should be bumped out
    expect(result.map((h) => h.chunk_id)).not.toContain(2);
  });

  it("first hit is always the most relevant (chunk_id=1 with lowest distance)", () => {
    const hits = [
      hit(1, 0.1, "abc def ghi"),
      hit(2, 0.2, "xyz uvw rst"),
      hit(3, 0.3, "one two three"),
    ];
    const result = mmrDiversify(hits, { lambda: 0.6 });
    expect(result[0]!.chunk_id).toBe(1);
  });
});

// ── rrfMerge ─────────────────────────────────────────────────────────────────

describe("rrfMerge", () => {
  it("single list → returns it unchanged", () => {
    const list = [hit(1, 0.1, "a"), hit(2, 0.2, "b")];
    const result = rrfMerge([list]);
    expect(result.map((h) => h.chunk_id)).toEqual([1, 2]);
  });

  it("empty input → empty output", () => {
    expect(rrfMerge([])).toEqual([]);
  });

  it("deduplicates by chunk_id across lists", () => {
    const listA = [hit(1, 0.1, "a"), hit(2, 0.2, "b")];
    const listB = [hit(2, 0.15, "b"), hit(3, 0.3, "c")];
    const result = rrfMerge([listA, listB]);
    const ids = result.map((h) => h.chunk_id);
    // no duplicates
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });

  it("chunk appearing in multiple lists ranks higher", () => {
    // chunk_id=2: rank-2 in listA + rank-1 in listB → score 1/62 + 1/61 ≈ 0.0325
    // chunk_id=1: rank-1 in listA only              → score 1/61 ≈ 0.0164
    // So chunk_id=2 (multi-list boost) should outrank chunk_id=1 (single-list top)
    const listA = [hit(1, 0.05, "a"), hit(2, 0.1, "b")];
    const listB = [hit(2, 0.08, "b2"), hit(3, 0.2, "c")];
    const result = rrfMerge([listA, listB]);
    const ids = result.map((h) => h.chunk_id);
    expect(ids[0]).toBe(2); // boosted by appearing in both lists
    expect(ids[1]).toBe(1); // only in listA at rank-1
  });

  it("respects topN", () => {
    const listA = [hit(1, 0.1, "a"), hit(2, 0.2, "b"), hit(3, 0.3, "c")];
    const listB = [hit(4, 0.1, "d"), hit(5, 0.2, "e")];
    const result = rrfMerge([listA, listB], { topN: 2 });
    expect(result).toHaveLength(2);
  });

  it("distance output is in (0, 1] — lower for higher-ranked chunks", () => {
    const listA = [hit(1, 0.1, "a"), hit(2, 0.5, "b")];
    const listB = [hit(3, 0.2, "c"), hit(4, 0.6, "d")];
    const result = rrfMerge([listA, listB]);
    for (const h of result) {
      expect(h.distance).toBeGreaterThan(0);
      expect(h.distance).toBeLessThanOrEqual(1);
    }
    // best ranked chunk has lowest distance
    expect(result[0]!.distance).toBeLessThan(result[result.length - 1]!.distance);
  });
});
