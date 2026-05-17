import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryKbStore } from "../src/stores/memory-store.ts";

let kb: InMemoryKbStore;
let docId: number;

beforeEach(async () => {
  kb = new InMemoryKbStore();
  ({ id: docId } = await kb.upsertDocument({
    source: "doc-1",
    title: "Doc 1",
    contentHash: "hash-1",
  }));
  await kb.insertChunkWithEmbedding({
    documentId: docId,
    chunkIndex: 0,
    text: "Dubai salary information",
    tokenCount: 5,
    embedding: [1, 0],
  });
  await kb.insertChunkWithEmbedding({
    documentId: docId,
    chunkIndex: 1,
    text: "Visa requirements guide",
    tokenCount: 5,
    embedding: [0, 1],
  });
});

describe("InMemoryKbStore counters", () => {
  test("tracks document and chunk counts", () => {
    expect(kb.documentCount).toBe(1);
    expect(kb.chunkCount).toBe(2);
  });
});

describe("InMemoryKbStore.search", () => {
  test("returns the cosine-nearest chunk first", async () => {
    const hits = await kb.search([1, 0], 1);
    expect(hits.map((h) => h.text)).toEqual(["Dubai salary information"]);
    expect(hits[0]?.distance).toBeCloseTo(0);
  });

  test("orders all chunks by distance", async () => {
    const hits = await kb.search([0, 1], 2);
    expect(hits.map((h) => h.text)).toEqual([
      "Visa requirements guide",
      "Dubai salary information",
    ]);
  });
});

describe("InMemoryKbStore.hybridSearch", () => {
  test("fuses vector and BM25 results", async () => {
    const hits = await kb.hybridSearch({ embedding: [0, 1], query: "visa", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toBe("Visa requirements guide");
  });
});

describe("InMemoryKbStore topic filtering", () => {
  test("search restricts the pool to a topic", async () => {
    const { id: booksId } = await kb.upsertDocument({
      source: "books",
      title: "Books",
      contentHash: "hash-books",
      topic: "books",
    });
    await kb.insertChunkWithEmbedding({
      documentId: booksId,
      chunkIndex: 0,
      text: "book content",
      tokenCount: 2,
      embedding: [1, 1],
    });
    const hits = await kb.search([1, 1], 5, "books");
    expect(hits.map((h) => h.text)).toEqual(["book content"]);
  });
});

describe("InMemoryKbStore ingest helpers", () => {
  test("getDocumentBySource returns id and content hash", async () => {
    const doc = await kb.getDocumentBySource("doc-1");
    expect(doc).toEqual({ id: docId, content_hash: "hash-1" });
  });

  test("getDocumentBySource returns null for an unknown source", async () => {
    expect(await kb.getDocumentBySource("missing")).toBeNull();
  });

  test("upsertDocument updates an existing document in place", async () => {
    const { id } = await kb.upsertDocument({
      source: "doc-1",
      title: "Renamed",
      contentHash: "hash-2",
    });
    expect(id).toBe(docId);
    expect(kb.documentCount).toBe(1);
  });

  test("countChunksForDocument counts indexed chunks", async () => {
    expect(await kb.countChunksForDocument(docId)).toBe(2);
  });

  test("deleteDocument removes the document and its chunks", async () => {
    expect(await kb.deleteDocument(docId)).toBe(true);
    expect(kb.documentCount).toBe(0);
    expect(kb.chunkCount).toBe(0);
    expect(await kb.deleteDocument(docId)).toBe(false);
  });
});
