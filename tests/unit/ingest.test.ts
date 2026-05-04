import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbRepo } from "@/db/repos/kb.ts";
import { openDb } from "@/db/sqlite.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { deriveTopicFromPath, ingestDirectory, ingestFile } from "@/rag/ingest.ts";

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

  test("ingestFile applies deps.topic to the inserted document", async () => {
    const file = join(tmp, "doc.md");
    writeFileSync(file, "content", "utf8");
    const embedder = fakeEmbedder();
    await ingestFile(file, { kb, embedder, topic: "visa" });
    const row = db
      .query<{ topic: string | null }, []>("SELECT topic FROM kb_documents")
      .get();
    expect(row?.topic).toBe("visa");
  });

  test("ingestDirectory derives topic from immediate sub-directory", async () => {
    const visaDir = join(tmp, "visa");
    const paymentDir = join(tmp, "payment");
    require("node:fs").mkdirSync(visaDir, { recursive: true });
    require("node:fs").mkdirSync(paymentDir, { recursive: true });
    writeFileSync(join(visaDir, "v1.md"), "visa doc 1", "utf8");
    writeFileSync(join(paymentDir, "p1.md"), "payment doc 1", "utf8");
    // File directly under tmp gets no topic
    writeFileSync(join(tmp, "untagged.md"), "untagged doc", "utf8");

    const embedder = fakeEmbedder();
    await ingestDirectory(tmp, { kb, embedder });
    const rows = db
      .query<{ title: string; topic: string | null }, []>(
        "SELECT title, topic FROM kb_documents ORDER BY title",
      )
      .all();
    const byTitle = new Map(rows.map((r) => [r.title, r.topic]));
    expect(byTitle.get("v1.md")).toBe("visa");
    expect(byTitle.get("p1.md")).toBe("payment");
    expect(byTitle.get("untagged.md")).toBeNull();
  });

  test("ingestDirectory: explicit deps.topic overrides directory layout", async () => {
    const visaDir = join(tmp, "visa");
    require("node:fs").mkdirSync(visaDir, { recursive: true });
    writeFileSync(join(visaDir, "v.md"), "doc", "utf8");

    const embedder = fakeEmbedder();
    await ingestDirectory(tmp, { kb, embedder, topic: "manual-override" });
    const row = db
      .query<{ topic: string | null }, []>("SELECT topic FROM kb_documents")
      .get();
    expect(row?.topic).toBe("manual-override");
  });
});

describe("deriveTopicFromPath", () => {
  test("returns immediate sub-directory name", () => {
    expect(deriveTopicFromPath("/root/visa/file.md", "/root")).toBe("visa");
    expect(deriveTopicFromPath("/root/payment/sub/file.md", "/root")).toBe("payment");
  });

  test("returns null for files directly under root", () => {
    expect(deriveTopicFromPath("/root/file.md", "/root")).toBeNull();
  });

  test("returns null when file equals root (edge case)", () => {
    expect(deriveTopicFromPath("/root", "/root")).toBeNull();
  });
});
