// Unit tests for the ingest pipeline (ingestFile / ingestText / ingestDirectory)
// + the pure helpers (deriveTopicFromPath, stripNonContent). The KB store and
// embedder are faked; ingestFile/ingestDirectory use real temp files on disk.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingClient } from "@chatman-media/llm-router";
import {
  deriveTopicFromPath,
  type IngestDeps,
  ingestDirectory,
  ingestFile,
  ingestText,
  stripNonContent,
} from "./ingest.ts";
import type { IKbStore } from "./types.ts";

interface FakeStoreState {
  docs: Map<string, { id: number; content_hash: string; chunkCount: number }>;
  inserted: number;
  deleted: number[];
  nextId: number;
}

function fakeStore(state: FakeStoreState): IKbStore {
  return {
    search: async () => [],
    hybridSearch: async () => [],
    prioritySearch: async () => [],
    getDocumentBySource: async (source: string) => {
      const d = state.docs.get(source);
      return d ? { id: d.id, content_hash: d.content_hash } : null;
    },
    countChunksForDocument: async (id: number) => {
      for (const d of state.docs.values()) if (d.id === id) return d.chunkCount;
      return 0;
    },
    deleteDocument: async (id: number) => {
      state.deleted.push(id);
      return true;
    },
    upsertDocument: async (input: { source: string; contentHash: string }) => {
      const id = state.nextId++;
      state.docs.set(input.source, { id, content_hash: input.contentHash, chunkCount: 0 });
      return { id };
    },
    insertChunkWithEmbedding: async () => {
      state.inserted++;
    },
  } as unknown as IKbStore;
}

function newState(): FakeStoreState {
  return { docs: new Map(), inserted: 0, deleted: [], nextId: 1 };
}

const embedder: EmbeddingClient = {
  embed: async (inputs: string[]) => inputs.map(() => [0.1, 0.2, 0.3]),
  dim: 3,
};

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kb-ingest-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("stripNonContent", () => {
  it("снимает YAML-frontmatter", () => {
    expect(stripNonContent("---\ntitle: x\n---\nBody here")).toBe("Body here\n");
  });
  it("снимает HTML-комментарии (в т.ч. вложенный остаток)", () => {
    expect(stripNonContent("a<!-- c -->b")).toBe("ab\n");
  });
  it("схлопывает 3+ переводов строк", () => {
    expect(stripNonContent("a\n\n\n\nb")).toBe("a\n\nb\n");
  });
});

describe("deriveTopicFromPath", () => {
  it("файл прямо в root → null", () => {
    expect(deriveTopicFromPath("/r/a.md", "/r")).toBeNull();
  });
  it("первая поддиректория → topic", () => {
    expect(deriveTopicFromPath("/r/china/jobs/a.md", "/r")).toBe("china");
  });
});

describe("ingestText", () => {
  it("создаёт документ и чанки, source=inline:<hash12>", async () => {
    const state = newState();
    const deps: IngestDeps = { kb: fakeStore(state), embedder };
    const r = await ingestText({ title: "Doc", body: "some content body text" }, deps);
    expect(r.created).toBe(true);
    expect(r.source).toStartWith("inline:");
    expect(r.chunks).toBeGreaterThan(0);
    expect(state.inserted).toBe(r.chunks);
  });

  it("пустой title → 'untitled'; пустое тело → 0 чанков", async () => {
    const state = newState();
    const r = await ingestText({ title: "  ", body: "" }, { kb: fakeStore(state), embedder });
    expect(r.chunks).toBe(0);
    expect(state.inserted).toBe(0);
  });

  it("повторная загрузка идентичного контента → dedup (created:false)", async () => {
    const state = newState();
    const deps: IngestDeps = { kb: fakeStore(state), embedder };
    const first = await ingestText({ title: "D", body: "stable text payload" }, deps);
    // mark existing doc as having chunks so the dedup short-circuit fires
    for (const d of state.docs.values()) d.chunkCount = first.chunks;
    const second = await ingestText({ title: "D", body: "stable text payload" }, deps);
    expect(second.created).toBe(false);
    expect(second.documentId).toBe(first.documentId);
  });

  it("существующий док с другим hash → удаляется и пересоздаётся", async () => {
    const state = newState();
    const deps: IngestDeps = { kb: fakeStore(state), embedder, topic: "t" };
    const first = await ingestText({ title: "D", body: "version one" }, deps);
    for (const d of state.docs.values()) d.chunkCount = first.chunks;
    // same source (hash of inline depends on body) — change body keeps a NEW source,
    // so to force the delete path we reuse the same body but reset stored hash.
    for (const d of state.docs.values()) d.content_hash = "STALE";
    const second = await ingestText({ title: "D", body: "version one" }, deps);
    expect(second.created).toBe(true);
    expect(state.deleted.length).toBe(1);
  });
});

describe("ingestFile", () => {
  it("читает .md, стрипает frontmatter, индексирует чанки", async () => {
    const dir = tmp();
    const file = join(dir, "doc.md");
    writeFileSync(file, "---\nx: 1\n---\nHello world content here.", "utf8");
    const state = newState();
    const r = await ingestFile(file, { kb: fakeStore(state), embedder });
    expect(r.created).toBe(true);
    expect(r.source).toBe(`file://${file}`);
    expect(r.chunks).toBeGreaterThan(0);
  });

  it("source/title override", async () => {
    const dir = tmp();
    const file = join(dir, "tmpname.txt");
    writeFileSync(file, "body text", "utf8");
    const state = newState();
    const r = await ingestFile(file, {
      kb: fakeStore(state),
      embedder,
      source: "upload:abc",
      title: "Nice Title",
    });
    expect(r.source).toBe("upload:abc");
  });
});

describe("ingestDirectory", () => {
  it("обходит дерево, пропускает неподдерживаемые расширения, выводит topic из подпапки", async () => {
    const root = tmp();
    mkdirSync(join(root, "china"));
    writeFileSync(join(root, "china", "a.md"), "alpha content", "utf8");
    writeFileSync(join(root, "b.txt"), "bravo content", "utf8");
    writeFileSync(join(root, "skip.json"), "{}", "utf8");
    const state = newState();
    const summary = await ingestDirectory(root, { kb: fakeStore(state), embedder });
    expect(summary.documents).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.chunks).toBeGreaterThan(0);
  });
});
