import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { KbRepo } from "@/db/repos/kb.ts";
import { activeEmbeddingDim } from "@/config.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;
let kb: KbRepo;

const dim = activeEmbeddingDim();
const zeroVec = (seed = 0): number[] => {
  // Deterministic but distinct vectors so KNN doesn't tie-break randomly.
  const v = new Array(dim).fill(0);
  v[seed % dim] = 1;
  return v;
};

beforeEach(() => {
  db = openDb({ path: ":memory:" });
  kb = new KbRepo(db);
});
afterEach(() => db.close());

function seed(source: string, title: string, topic: string | null = null) {
  const doc = kb.upsertDocument({
    source,
    title,
    contentHash: `${source}:${title}:${topic ?? ""}`,
    topic,
  });
  kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: `body of ${title}`,
    tokenCount: 4,
    embedding: zeroVec(doc.id),
  });
  kb.insertChunkWithEmbedding({
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
    const a = seed("a.md", "Alpha");
    await new Promise((r) => setTimeout(r, 1100)); // unixepoch is integer-second
    const b = seed("b.md", "Beta");
    const list = kb.listDocuments();
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
    expect(list[0]!.chunk_count).toBe(2);
  });

  test("listDocuments filters by topic + __untagged__ sentinel", () => {
    const visa = seed("visa.md", "Visa rules", "visa");
    const pay = seed("pay.md", "Payment", "payment");
    const free = seed("misc.md", "Misc");

    expect(kb.listDocuments({ topic: "visa" }).map((d) => d.id)).toEqual([
      visa.id,
    ]);
    expect(kb.listDocuments({ topic: "payment" }).map((d) => d.id)).toEqual([
      pay.id,
    ]);
    expect(kb.listDocuments({ topic: "__untagged__" }).map((d) => d.id)).toEqual([
      free.id,
    ]);
  });

  test("listDocuments q-filter matches title + source case-insensitively", () => {
    seed("notes/visa.md", "Visa entry rules");
    seed("notes/jobs.md", "Job offers");
    const matches = kb.listDocuments({ q: "VISA" });
    expect(matches.length).toBe(1);
    expect(matches[0]!.title).toBe("Visa entry rules");
  });

  test("listTopics returns distinct non-null tags, sorted", () => {
    seed("a.md", "A", "visa");
    seed("b.md", "B", "payment");
    seed("c.md", "C", "visa");
    seed("d.md", "D", null);
    expect(kb.listTopics()).toEqual(["payment", "visa"]);
  });

  test("setTopic updates the row + clears with null", () => {
    const d = seed("a.md", "A", "visa");
    expect(kb.setTopic(d.id, "payment")?.topic).toBe("payment");
    expect(kb.setTopic(d.id, null)?.topic).toBeNull();
    expect(kb.setTopic(99999, "visa")).toBeNull();
  });

  test("listChunks returns chunks ordered by chunk_index", () => {
    const d = seed("a.md", "A");
    const chunks = kb.listChunks(d.id);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.chunk_index).toBe(0);
    expect(chunks[1]!.chunk_index).toBe(1);
  });

  test("deleteDocument removes doc + chunks + vec rows", () => {
    const d = seed("a.md", "A");
    expect(kb.countChunks()).toBe(2);
    expect(kb.deleteDocument(d.id)).toBe(true);
    expect(kb.getDocument(d.id)).toBeNull();
    expect(kb.listChunks(d.id).length).toBe(0);
    // Vector rows gone — search returns no hits for the doc's chunks
    const hits = kb.search(zeroVec(d.id), 5);
    expect(hits.find((h) => h.document_id === d.id)).toBeUndefined();
  });

  test("deleteDocument returns false on missing id", () => {
    expect(kb.deleteDocument(99999)).toBe(false);
  });
});
