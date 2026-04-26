import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbRepo } from "@/db/repos/kb.ts";
import { openDb } from "@/db/sqlite.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { ingestDirectory, ingestFile } from "@/rag/ingest.ts";

const DIM = 1536;

function fakeEmbedder(): EmbeddingClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    dim: DIM,
    calls,
    async embed(inputs: string[]) {
      calls.push([...inputs]);
      return inputs.map((text) => deterministicVec(text, DIM));
    },
  } as EmbeddingClient & { calls: string[][] };
}

function deterministicVec(text: string, dim: number): number[] {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const arr = new Array<number>(dim).fill(0);
  arr[h % dim] = 1;
  return arr;
}

let tmp: string;
let db: ReturnType<typeof openDb>;
let kb: KbRepo;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tg-ingest-"));
  db = openDb({ path: ":memory:", embeddingDim: DIM });
  kb = new KbRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("ingestFile", () => {
  test("inserts a document, chunks, and equal-count vectors", async () => {
    const file = join(tmp, "doc.md");
    writeFileSync(
      file,
      "para one\n\n" + "x".repeat(200) + "\n\npara three",
      "utf8",
    );
    const embedder = fakeEmbedder();

    const result = await ingestFile(file, {
      kb,
      embedder,
      chunk: { maxChars: 80, overlapChars: 10 },
    });

    expect(result.created).toBe(true);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(kb.countDocuments()).toBe(1);
    expect(kb.countChunks()).toBe(result.chunks);
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]!.length).toBe(result.chunks);
  });

  test("re-ingesting the same content is a no-op", async () => {
    const file = join(tmp, "doc.md");
    writeFileSync(file, "stable content", "utf8");
    const embedder = fakeEmbedder();

    const r1 = await ingestFile(file, { kb, embedder });
    const r2 = await ingestFile(file, { kb, embedder });

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(kb.countDocuments()).toBe(1);
    expect(kb.countChunks()).toBe(r1.chunks);
    expect(embedder.calls).toHaveLength(1);
  });

  test("changed content replaces old chunks for the same source", async () => {
    const file = join(tmp, "doc.md");
    writeFileSync(file, "version one", "utf8");
    const embedder = fakeEmbedder();
    const r1 = await ingestFile(file, { kb, embedder });
    expect(r1.created).toBe(true);

    writeFileSync(file, "version two with more text", "utf8");
    const r2 = await ingestFile(file, { kb, embedder });
    expect(r2.created).toBe(true);

    expect(kb.countDocuments()).toBe(1);
    expect(kb.countChunks()).toBe(r2.chunks);

    const hits = kb.search(deterministicVec("version two with more text", DIM), 5);
    expect(hits[0]!.text).toContain("version two");
  });

  test("ingestDirectory recurses over .md and .txt only", async () => {
    writeFileSync(join(tmp, "a.md"), "alpha doc", "utf8");
    writeFileSync(join(tmp, "b.txt"), "beta doc", "utf8");
    writeFileSync(join(tmp, "ignore.json"), '{"x":1}', "utf8");
    const embedder = fakeEmbedder();

    const summary = await ingestDirectory(tmp, { kb, embedder });
    expect(summary.documents).toBe(2);
    expect(kb.countDocuments()).toBe(2);
  });
});
