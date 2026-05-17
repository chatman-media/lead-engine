import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { type ChunkOptions, chunkText } from "./chunk.ts";
import type { EmbeddingClient } from "./embed.ts";
import { parsePdf } from "./parse-pdf.ts";
import type { IKbStore } from "./types.ts";

const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf"]);

export interface IngestDeps {
  kb: IKbStore;
  embedder: EmbeddingClient;
  chunk?: Partial<ChunkOptions>;
  topic?: string | null;
}

export interface IngestFileResult {
  source: string;
  documentId: number;
  chunks: number;
  created: boolean;
}

export async function ingestFile(path: string, deps: IngestDeps): Promise<IngestFileResult> {
  const abs = resolve(path);
  const ext = extname(abs).toLowerCase();
  const raw = ext === ".pdf" ? await parsePdf(abs) : readFileSync(abs, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = `file://${abs}`;
  const title = basename(abs);

  const existing = await deps.kb.getDocumentBySource(source);

  if (existing && existing.content_hash === hash) {
    const chunks = await deps.kb.countChunksForDocument(existing.id);
    if (chunks > 0) {
      return { source, documentId: existing.id, chunks, created: false };
    }
  }

  if (existing) {
    await deps.kb.deleteDocument(existing.id);
  }

  const doc = await deps.kb.upsertDocument({
    source,
    title,
    contentHash: hash,
    ...(deps.topic !== undefined ? { topic: deps.topic } : {}),
  });

  const preparedText = ext === ".pdf" ? raw : stripNonContent(raw);
  const chunks = chunkText(preparedText, deps.chunk);
  if (chunks.length === 0) {
    return { source, documentId: doc.id, chunks: 0, created: true };
  }

  const vectors = await deps.embedder.embed(chunks.map((c) => c.text));
  for (const [i, chunk] of chunks.entries()) {
    const vec = vectors[i];
    if (!vec) throw new Error(`embedder returned no vector for chunk ${i}`);
    await deps.kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: chunk.index,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      embedding: vec,
    });
  }
  return { source, documentId: doc.id, chunks: chunks.length, created: true };
}

/**
 * Ingest a raw text document directly (no filesystem). Used by admin-UI
 * paste path. Source is synthesised as `inline:<sha256[:12]>` so subsequent
 * uploads of identical content dedupe via the `source` UNIQUE lookup.
 */
export async function ingestText(
  input: { title: string; body: string },
  deps: IngestDeps,
): Promise<IngestFileResult> {
  const raw = input.body;
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = `inline:${hash.slice(0, 12)}`;
  const title = input.title.trim() || "untitled";

  const existing = await deps.kb.getDocumentBySource(source);

  if (existing && existing.content_hash === hash) {
    const chunks = await deps.kb.countChunksForDocument(existing.id);
    if (chunks > 0) {
      return { source, documentId: existing.id, chunks, created: false };
    }
  }

  if (existing) {
    await deps.kb.deleteDocument(existing.id);
  }

  const doc = await deps.kb.upsertDocument({
    source,
    title,
    contentHash: hash,
    ...(deps.topic !== undefined ? { topic: deps.topic } : {}),
  });

  const chunks = chunkText(stripNonContent(raw), deps.chunk);
  if (chunks.length === 0) {
    return { source, documentId: doc.id, chunks: 0, created: true };
  }

  const vectors = await deps.embedder.embed(chunks.map((c) => c.text));
  for (const [i, chunk] of chunks.entries()) {
    const vec = vectors[i];
    if (!vec) throw new Error(`embedder returned no vector for chunk ${i}`);
    await deps.kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: chunk.index,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      embedding: vec,
    });
  }
  return { source, documentId: doc.id, chunks: chunks.length, created: true };
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
  const summary: IngestDirectorySummary = { documents: 0, chunks: 0, skipped: 0 };
  const root = resolve(dir);
  for (const file of walk(root)) {
    if (!SUPPORTED_EXTS.has(extname(file).toLowerCase())) {
      summary.skipped++;
      continue;
    }
    const fileDeps: IngestDeps =
      deps.topic !== undefined ? deps : { ...deps, topic: deriveTopicFromPath(file, root) };
    const r = await ingestFile(file, fileDeps);
    summary.documents++;
    summary.chunks += r.chunks;
  }
  return summary;
}

/**
 * Returns the immediate sub-directory name of `file` relative to `root`,
 * or null when the file sits directly under `root`. Exported for unit tests.
 */
export function deriveTopicFromPath(file: string, root: string): string | null {
  const rel = relative(root, dirname(file));
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  const first = rel.split(/[/\\]/)[0];
  return first || null;
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

/**
 * Removes YAML frontmatter and HTML comments from Markdown — noise that
 * pollutes embeddings. The visible body is preserved as-is.
 */
export function stripNonContent(raw: string): string {
  let s = raw;
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return `${s}\n`;
}
