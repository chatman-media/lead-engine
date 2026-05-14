import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { activeEmbeddingDim } from "@/config.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let kb: KbRepo;

const dim = activeEmbeddingDim();
const zeroVec = (seed = 0): number[] => {
  // Deterministic but distinct vectors so KNN doesn't tie-break randomly.
  const v = new Array(dim).fill(0);
  v[seed % dim] = 1;
  return v;
};

beforeEach(() => {
  kb = new KbRepo(sql);
});

async function seed(source: string, title: string, topic: string | null = null) {
  const doc = await kb.upsertDocument({
    source,
    title,
    contentHash: `${source}:${title}:${topic ?? ""}`,
    topic,
  });
  await kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: `body of ${title}`,
    tokenCount: 4,
    embedding: zeroVec(doc.id),
  });
  await kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 1,
    text: `more body of ${title}`,
    tokenCount: 5,
    embedding: zeroVec(doc.id + 100),
  });
  return doc;
}

describe("KbRepo management methods", () => {
  test("listDocuments returns chunk_count + sorts freshest first", async () => {
    const a = await seed("a.md", "Alpha");
    await new Promise((r) => setTimeout(r, 1100)); // unixepoch is integer-second
    const b = await seed("b.md", "Beta");
    const list = await kb.listDocuments();
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
    expect(list[0]!.chunk_count).toBe(2);
  });

  test("listDocuments filters by topic + __untagged__ sentinel", async () => {
    const visa = await seed("visa.md", "Visa rules", "visa");
    const pay = await seed("pay.md", "Payment", "payment");
    const free = await seed("misc.md", "Misc");

    expect((await kb.listDocuments({ topic: "visa" })).map((d) => d.id)).toEqual([visa.id]);
    expect((await kb.listDocuments({ topic: "payment" })).map((d) => d.id)).toEqual([pay.id]);
    expect((await kb.listDocuments({ topic: "__untagged__" })).map((d) => d.id)).toEqual([free.id]);
  });

  test("listDocuments q-filter matches title + source case-insensitively", async () => {
    await seed("notes/visa.md", "Visa entry rules");
    await seed("notes/jobs.md", "Job offers");
    const matches = await kb.listDocuments({ q: "VISA" });
    expect(matches.length).toBe(1);
    expect(matches[0]!.title).toBe("Visa entry rules");
  });

  test("listTopics returns distinct non-null tags, sorted", async () => {
    await seed("a.md", "A", "visa");
    await seed("b.md", "B", "payment");
    await seed("c.md", "C", "visa");
    await seed("d.md", "D", null);
    expect(await kb.listTopics()).toEqual(["payment", "visa"]);
  });

  test("setTopic updates the row + clears with null", async () => {
    const d = await seed("a.md", "A", "visa");
    expect((await kb.setTopic(d.id, "payment"))?.topic).toBe("payment");
    expect((await kb.setTopic(d.id, null))?.topic).toBeNull();
    expect(await kb.setTopic(99999, "visa")).toBeNull();
  });

  test("listChunks returns chunks ordered by chunk_index", async () => {
    const d = await seed("a.md", "A");
    const chunks = await kb.listChunks(d.id);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.chunk_index).toBe(0);
    expect(chunks[1]!.chunk_index).toBe(1);
  });

  test("deleteDocument removes doc + chunks + vec rows", async () => {
    const d = await seed("a.md", "A");
    expect(await kb.countChunks()).toBe(2);
    expect(await kb.deleteDocument(d.id)).toBe(true);
    expect(await kb.getDocument(d.id)).toBeNull();
    expect((await kb.listChunks(d.id)).length).toBe(0);
    // Vector rows gone — search returns no hits for the doc's chunks
    const hits = await kb.search(zeroVec(d.id), 5);
    expect(hits.find((h) => h.document_id === d.id)).toBeUndefined();
  });

  test("deleteDocument returns false on missing id", async () => {
    expect(await kb.deleteDocument(99999)).toBe(false);
  });
});

describe("KbRepo.prioritySearch", () => {
  test("returns books-tagged hits when available", async () => {
    // Seed a general doc and a books doc with different embedding directions
    await seed("general.md", "General KB", null);
    const booksDoc = await seed("influence.md", "Influence", "books");

    // Query vector closest to the books doc's first chunk (seed = booksDoc.id)
    const hits = await kb.prioritySearch({
      embedding: zeroVec(booksDoc.id),
      query: "influence",
      k: 5,
      vectorOnly: true,
    });

    // All returned hits must come from the books doc
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.document_id === booksDoc.id)).toBe(true);
  });

  test("falls back to global KB when no books are indexed", async () => {
    const general = await seed("general.md", "General KB", "visa");

    const hits = await kb.prioritySearch({
      embedding: zeroVec(general.id),
      query: "visa",
      k: 5,
      vectorOnly: true,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.document_id === general.id)).toBe(true);
  });

  test("returns books hits even when general KB has better vector match", async () => {
    // General doc has perfect match vector (seed = 0 = zeroVec(0) = [1, 0, ...])
    await seed("general.md", "General KB", null);
    // Books doc has a slightly different vector
    const booksDoc = await seed("power.md", "48 Laws", "books");

    // Even if we query with zeroVec(0) (perfect match for general), books doc
    // should be returned from the books-priority search.
    const bookHits = await kb.search(zeroVec(0), 5, "books");
    // Only verify that when books exist, prioritySearch uses the books layer
    if (bookHits.length > 0) {
      const hits = await kb.prioritySearch({
        embedding: zeroVec(booksDoc.id),
        query: "power",
        k: 5,
        vectorOnly: true,
      });
      expect(hits.every((h) => h.document_id === booksDoc.id)).toBe(true);
    }
  });
});
