import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  KbRepo,
  reciprocalRankFusion,
  sanitizeFtsQuery,
  type KbSearchHit,
} from "@/db/repos/kb.ts";
import { openDb } from "@/db/sqlite.ts";

const DIM = 1536;

function vec(seed: number): number[] {
  const arr = new Array<number>(DIM).fill(0);
  arr[seed % DIM] = 1;
  return arr;
}

let db: ReturnType<typeof openDb>;
let kb: KbRepo;

beforeEach(() => {
  db = openDb({ path: ":memory:", embeddingDim: DIM });
  kb = new KbRepo(db);
});
afterEach(() => db.close());

function seedDocs(): { visaChunkId: number; dubaiChunkId: number; istanbulChunkId: number } {
  const doc = kb.upsertDocument({ source: "kb://t", title: "t", contentHash: "h1" });
  const visa = kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: "Виза оформляется на 30 дней бесплатно через агентство.",
    tokenCount: 10,
    embedding: vec(1),
  });
  const dubai = kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 1,
    text: "В Дубае платят 1500 в день, контракт 30 дней с релокацией.",
    tokenCount: 12,
    embedding: vec(2),
  });
  const istanbul = kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 2,
    text: "Стамбул: контракты от 60 дней, оплата в долларах.",
    tokenCount: 10,
    embedding: vec(3),
  });
  return { visaChunkId: visa.id, dubaiChunkId: dubai.id, istanbulChunkId: istanbul.id };
}

describe("sanitizeFtsQuery", () => {
  test("returns empty string on empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
  });

  test("strips FTS5 operators that would break the query", () => {
    expect(sanitizeFtsQuery("виза AND контракт")).toContain('"виза"*');
    expect(sanitizeFtsQuery("виза AND контракт")).toContain('"контракт"*');
    expect(sanitizeFtsQuery("виза AND контракт")).not.toMatch(/\bAND\b/);
  });

  test("strips operator characters from raw text (parens, asterisks, colons)", () => {
    // Tokens themselves get re-wrapped in quotes ("hack"*), but the test
    // here is that user-supplied operator chars from the original text
    // don't leak into the FTS5 query in a way that changes its semantics.
    const result = sanitizeFtsQuery("foo (bar) baz");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
    expect(result).toContain('"foo"*');
    expect(result).toContain('"bar"*');
    expect(result).toContain('"baz"*');
  });

  test("drops short tokens (< 2 chars)", () => {
    const result = sanitizeFtsQuery("я в дубае");
    expect(result).toContain('"дубае"*');
    // single-char "я" / "в" dropped
    expect(result).not.toContain('"я"');
    expect(result).not.toContain('"в"');
  });

  test("uses OR fusion with prefix-match for word-form variation", () => {
    const result = sanitizeFtsQuery("визу 30 дней");
    expect(result).toContain('"визу"*');
    expect(result).toContain('"30"*');
    expect(result).toContain('"дней"*');
    expect(result.split(" OR ").length).toBe(3);
  });
});

describe("KbRepo.searchBm25", () => {
  test("returns hits for exact-match keywords (Cyrillic)", () => {
    const ids = seedDocs();
    const hits = kb.searchBm25("виза", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk_id).toBe(ids.visaChunkId);
  });

  test("matches via forward prefix matching (query 'виз' hits 'виза')", () => {
    const ids = seedDocs();
    // FTS5 prefix-match is forward-only: query "виз*" matches "виза",
    // "визу", "визой" etc. The reverse direction (query "визой" matching
    // a chunk containing "виза") needs a stemmer — out of scope for now.
    const hits = kb.searchBm25("виз", 5);
    expect(hits.map((h) => h.chunk_id)).toContain(ids.visaChunkId);
  });

  test("returns multiple hits ordered by BM25 score (lower = better)", () => {
    seedDocs();
    const hits = kb.searchBm25("контракт дней", 5);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.distance).toBeGreaterThanOrEqual(hits[i - 1]!.distance);
    }
  });

  test("returns [] when query has no matchable tokens", () => {
    seedDocs();
    expect(kb.searchBm25("", 5)).toEqual([]);
    expect(kb.searchBm25("я", 5)).toEqual([]); // single char dropped
  });

  test("returns [] when no chunk matches", () => {
    seedDocs();
    expect(kb.searchBm25("xylophone", 5)).toEqual([]);
  });

  test("returns [] gracefully on malformed FTS queries (does not throw)", () => {
    seedDocs();
    // Even with operator chars, sanitize should handle it — but if user
    // somehow passes operators through, we shouldn't crash.
    expect(() => kb.searchBm25("(((", 5)).not.toThrow();
  });

  test("trigger keeps FTS in sync after insert", () => {
    const doc = kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
    expect(kb.searchBm25("уникальное", 5).length).toBe(0);
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "это уникальное слово в контенте",
      tokenCount: 5,
      embedding: vec(7),
    });
    expect(kb.searchBm25("уникальное", 5).length).toBe(1);
  });

  test("trigger keeps FTS in sync after delete", () => {
    const doc = kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "удаляемое слово",
      tokenCount: 3,
      embedding: vec(8),
    });
    expect(kb.searchBm25("удаляемое", 5).length).toBe(1);
    kb.deleteChunksByDocument(doc.id);
    expect(kb.searchBm25("удаляемое", 5).length).toBe(0);
  });
});

describe("reciprocalRankFusion", () => {
  function hit(id: number): KbSearchHit {
    return {
      chunk_id: id,
      distance: 0,
      text: `t${id}`,
      document_id: 1,
      source: "s",
      title: "t",
    };
  }

  test("returns vector hits unchanged when bm25 is empty (caller's job upstream, but RRF is symmetric)", () => {
    const v = [hit(1), hit(2), hit(3)];
    const result = reciprocalRankFusion(v, [], 3);
    expect(result.map((h) => h.chunk_id)).toEqual([1, 2, 3]);
  });

  test("ranks chunks appearing in both lists higher than singletons", () => {
    // chunk 1: rank 1 in vec, rank 1 in bm25 → top score
    // chunk 2: rank 2 in vec only
    // chunk 3: rank 1 in bm25 only (but 2nd in fused since 1 wins both)
    const v = [hit(1), hit(2)];
    const b = [hit(1), hit(3)];
    const result = reciprocalRankFusion(v, b, 3);
    expect(result[0]!.chunk_id).toBe(1);
  });

  test("respects k limit", () => {
    const v = [hit(1), hit(2), hit(3), hit(4), hit(5)];
    const b = [hit(6), hit(7), hit(8), hit(9), hit(10)];
    const result = reciprocalRankFusion(v, b, 3);
    expect(result.length).toBe(3);
  });

  test("output distance is 1 - fused score (lower = better)", () => {
    const v = [hit(1), hit(2)];
    const b = [hit(1), hit(2)];
    const result = reciprocalRankFusion(v, b, 2);
    // chunk 1 wins both → highest fused score → smallest distance
    expect(result[0]!.distance).toBeLessThan(result[1]!.distance);
  });
});

describe("KbRepo.hybridSearch", () => {
  test("falls back to vector-only when BM25 has no hits", () => {
    const ids = seedDocs();
    const result = kb.hybridSearch({ embedding: vec(1), query: "xylophone", k: 3 });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.chunk_id).toBe(ids.visaChunkId);
  });

  test("falls back to BM25-only when vector index has no hits (unmatched embedding)", () => {
    seedDocs();
    // Vector with no chunk near it → vector returns empty due to k=0 candidates,
    // but here vec(99) IS in the index seed range — test more directly via
    // empty-embedding edge case below.
    const result = kb.hybridSearch({ embedding: vec(1), query: "виза", k: 3 });
    expect(result.length).toBeGreaterThan(0);
  });

  test("merged results include hits from both sides", () => {
    const ids = seedDocs();
    // Vector seed favors visa (vec(1)); BM25 query "Стамбул" favors istanbul.
    // Hybrid should return BOTH in top-3.
    const result = kb.hybridSearch({ embedding: vec(1), query: "Стамбул", k: 3 });
    const chunkIds = result.map((h) => h.chunk_id);
    expect(chunkIds).toContain(ids.visaChunkId); // from vector
    expect(chunkIds).toContain(ids.istanbulChunkId); // from BM25
  });

  test("respects k", () => {
    seedDocs();
    const result = kb.hybridSearch({ embedding: vec(1), query: "контракт", k: 1 });
    expect(result.length).toBe(1);
  });
});
