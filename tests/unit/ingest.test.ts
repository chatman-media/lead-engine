import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbRepo } from "@/db/repos/kb.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { deriveTopicFromPath, ingestDirectory, ingestFile, ingestText } from "@/rag/ingest.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

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

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let tmp: string;
let kb: KbRepo;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tg-ingest-"));
  kb = new KbRepo(sql);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("ingestFile", () => {
  test("inserts a document, chunks, and equal-count vectors", async () => {
    const file = join(tmp, "doc.md");
    writeFileSync(file, `para one\n\n${"x".repeat(200)}\n\npara three`, "utf8");
    const embedder = fakeEmbedder();

    const result = await ingestFile(file, {
      kb,
      embedder,
      chunk: { maxChars: 80, overlapChars: 10 },
    });

    expect(result.created).toBe(true);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(await kb.countDocuments()).toBe(1);
    expect(await kb.countChunks()).toBe(result.chunks);
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
    expect(await kb.countDocuments()).toBe(1);
    expect(await kb.countChunks()).toBe(r1.chunks);
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

    expect(await kb.countDocuments()).toBe(1);
    expect(await kb.countChunks()).toBe(r2.chunks);

    const hits = await kb.search(deterministicVec("version two with more text", DIM), 5);
    expect(hits[0]!.text).toContain("version two");
  });

  test("ingestDirectory recurses over .md and .txt only", async () => {
    writeFileSync(join(tmp, "a.md"), "alpha doc", "utf8");
    writeFileSync(join(tmp, "b.txt"), "beta doc", "utf8");
    writeFileSync(join(tmp, "ignore.json"), '{"x":1}', "utf8");
    const embedder = fakeEmbedder();

    const summary = await ingestDirectory(tmp, { kb, embedder });
    expect(summary.documents).toBe(2);
    expect(await kb.countDocuments()).toBe(2);
  });

  test("ingestFile applies deps.topic to the inserted document", async () => {
    const file = join(tmp, "doc.md");
    writeFileSync(file, "content", "utf8");
    const embedder = fakeEmbedder();
    await ingestFile(file, { kb, embedder, topic: "visa" });
    const [row] = await sql<[{ topic: string | null }]>`SELECT topic FROM kb_documents LIMIT 1`;
    expect(row?.topic).toBe("visa");
  });

  test("ingestDirectory derives topic from immediate sub-directory", async () => {
    const visaDir = join(tmp, "visa");
    const paymentDir = join(tmp, "payment");
    mkdirSync(visaDir, { recursive: true });
    mkdirSync(paymentDir, { recursive: true });
    writeFileSync(join(visaDir, "v1.md"), "visa doc 1", "utf8");
    writeFileSync(join(paymentDir, "p1.md"), "payment doc 1", "utf8");
    // File directly under tmp gets no topic
    writeFileSync(join(tmp, "untagged.md"), "untagged doc", "utf8");

    const embedder = fakeEmbedder();
    await ingestDirectory(tmp, { kb, embedder });
    const rows = await sql<{ title: string; topic: string | null }[]>`
      SELECT title, topic FROM kb_documents ORDER BY title
    `;
    const byTitle = new Map(rows.map((r) => [r.title, r.topic]));
    expect(byTitle.get("v1.md")).toBe("visa");
    expect(byTitle.get("p1.md")).toBe("payment");
    expect(byTitle.get("untagged.md")).toBeNull();
  });

  test("ingestDirectory: explicit deps.topic overrides directory layout", async () => {
    const visaDir = join(tmp, "visa");
    mkdirSync(visaDir, { recursive: true });
    writeFileSync(join(visaDir, "v.md"), "doc", "utf8");

    const embedder = fakeEmbedder();
    await ingestDirectory(tmp, { kb, embedder, topic: "manual-override" });
    const [row] = await sql<[{ topic: string | null }]>`SELECT topic FROM kb_documents LIMIT 1`;
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

describe("ingestText", () => {
  test("inserts a document, chunks, and embeds — like ingestFile but inline", async () => {
    const embedder = fakeEmbedder();
    const result = await ingestText(
      { title: "korea-faq.md", body: `para one\n\n${"x".repeat(200)}\n\npara three` },
      { kb, embedder, chunk: { maxChars: 80, overlapChars: 10 } },
    );
    expect(result.created).toBe(true);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(await kb.countDocuments()).toBe(1);
    expect(await kb.countChunks()).toBe(result.chunks);
    expect(embedder.calls.length).toBe(1);
    expect(result.source.startsWith("inline:")).toBe(true);
  });

  test("identical body returns the existing document (idempotent)", async () => {
    const embedder = fakeEmbedder();
    const r1 = await ingestText({ title: "x", body: "stable content" }, { kb, embedder });
    const r2 = await ingestText({ title: "x", body: "stable content" }, { kb, embedder });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r1.documentId).toBe(r2.documentId);
    expect(await kb.countDocuments()).toBe(1);
  });

  test("topic is applied to the inserted document when set", async () => {
    const embedder = fakeEmbedder();
    await ingestText({ title: "v.md", body: "visa info" }, { kb, embedder, topic: "visa" });
    const [row] = await sql<[{ topic: string | null }]>`SELECT topic FROM kb_documents LIMIT 1`;
    expect(row?.topic).toBe("visa");
  });

  test("empty title falls back to 'untitled'", async () => {
    const embedder = fakeEmbedder();
    const r = await ingestText({ title: "  ", body: "some body" }, { kb, embedder });
    expect(r.created).toBe(true);
    const [row] = await sql<[{ title: string }]>`SELECT title FROM kb_documents LIMIT 1`;
    expect(row?.title).toBe("untitled");
  });
});
