import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { KbRepo } from "../db/repos/kb.ts";
import { chunkText, type ChunkOptions } from "./chunk.ts";
import type { EmbeddingClient } from "./embed.ts";

const SUPPORTED_EXTS = new Set([".md", ".txt"]);

export interface IngestDeps {
  kb: KbRepo;
  embedder: EmbeddingClient;
  chunk?: Partial<ChunkOptions>;
}

export interface IngestFileResult {
  source: string;
  documentId: number;
  chunks: number;
  /** True if a new document version was inserted; false if content unchanged. */
  created: boolean;
}

interface ExistingDoc {
  id: number;
  content_hash: string;
}

export async function ingestFile(
  path: string,
  deps: IngestDeps,
): Promise<IngestFileResult> {
  const abs = resolve(path);
  const raw = readFileSync(abs, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = `file://${abs}`;
  const title = basename(abs);
  const db = getDb(deps.kb);

  const existing = db
    .query<ExistingDoc, [string]>(
      "SELECT id, content_hash FROM kb_documents WHERE source = ? LIMIT 1",
    )
    .get(source);

  if (existing && existing.content_hash === hash) {
    const chunks = countChunksForDoc(db, existing.id);
    if (chunks > 0) {
      return {
        source,
        documentId: existing.id,
        chunks,
        created: false,
      };
    }
  }

  if (existing) {
    deps.kb.deleteChunksByDocument(existing.id);
    db.run("DELETE FROM kb_documents WHERE id = ?", [existing.id]);
  }

  const doc = deps.kb.upsertDocument({
    source,
    title,
    contentHash: hash,
  });

  const chunks = chunkText(raw, deps.chunk);
  if (chunks.length === 0) {
    return { source, documentId: doc.id, chunks: 0, created: true };
  }

  const vectors = await deps.embedder.embed(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i++) {
    deps.kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: chunks[i]!.index,
      text: chunks[i]!.text,
      tokenCount: chunks[i]!.tokenCount,
      embedding: vectors[i]!,
    });
  }
  return {
    source,
    documentId: doc.id,
    chunks: chunks.length,
    created: true,
  };
}

export interface IngestDirectorySummary {
  documents: number;
  chunks: number;
  skipped: number;
}

export async function ingestDirectory(
  dir: string,
  deps: IngestDeps,
): Promise<IngestDirectorySummary> {
  const summary: IngestDirectorySummary = {
    documents: 0,
    chunks: 0,
    skipped: 0,
  };
  for (const file of walk(resolve(dir))) {
    if (!SUPPORTED_EXTS.has(extname(file).toLowerCase())) {
      summary.skipped++;
      continue;
    }
    const r = await ingestFile(file, deps);
    summary.documents++;
    summary.chunks += r.chunks;
  }
  return summary;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function getDb(kb: KbRepo): Database {
  return (kb as unknown as { db: Database }).db;
}

function countChunksForDoc(db: Database, docId: number): number {
  const r = db
    .query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM kb_chunks WHERE document_id = ?",
    )
    .get(docId);
  return r?.n ?? 0;
}
