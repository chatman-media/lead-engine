import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { KbRepo } from "@/db/repos/kb.ts";
import { ensureKbVec, getKbVecDim } from "@/db/ensure-kb-vec.ts";
import { openDb } from "@/db/sqlite.ts";

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb({ path: ":memory:" });
});
afterEach(() => db.close());

describe("ensureKbVec", () => {
  test("does nothing when current dim matches requested", () => {
    const before = getKbVecDim(db);
    expect(before).toBe(1536);
    const action = ensureKbVec(db, 1536);
    expect(action).toBe("noop");
    expect(getKbVecDim(db)).toBe(1536);
  });

  test("recreates the table when dim changes (data is dropped)", () => {
    const kb = new KbRepo(db);
    const doc = kb.upsertDocument({
      source: "s://t",
      title: "t",
      contentHash: "h",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "anything",
      tokenCount: 1,
      embedding: new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    });

    const action = ensureKbVec(db, 768);
    expect(action).toBe("recreated");
    expect(getKbVecDim(db)).toBe(768);

    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kb_vec")
      .get();
    expect(count?.n).toBe(0);
  });

  test("throws on bogus dim", () => {
    expect(() => ensureKbVec(db, 0)).toThrow();
    expect(() => ensureKbVec(db, -1)).toThrow();
    expect(() => ensureKbVec(db, 1.5)).toThrow();
  });
});
