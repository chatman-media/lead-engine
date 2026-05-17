import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import type { KbRepo } from "../db/repos/kb.ts";
import { type ChunkOptions, chunkText } from "./chunk.ts";
import type { EmbeddingClient } from "./embed.ts";
import { parsePdf } from "./parse-pdf.ts";

const SUPPORTED_EXTS = new Set([".md", ".txt", ".pdf"]);

export interface IngestDeps {
  kb: KbRepo;
  embedder: EmbeddingClient;
  chunk?: Partial<ChunkOptions>;
  /** Optional topic tag for the document(s) being ingested. NULL leaves
   *  docs untagged (still searchable by topic-routed queries via the
   *  NULL fallback). See `kb_documents.topic` and topic-classifier.ts. */
  topic?: string | null;
  /** Overrides the default `file://<abs>` document source. Callers that
   *  ingest from a throwaway temp path (e.g. the admin upload route) pass a
   *  stable, content-addressed source here so re-uploads dedupe. */
  source?: string;
  /** Overrides the default `basename(abs)` document title — useful when the
   *  on-disk filename is a temp name rather than something operator-facing. */
  title?: string;
}

export interface IngestFileResult {
  source: string;
  documentId: number;
  chunks: number;
  /** True if a new document version was inserted; false if content unchanged. */
  created: boolean;
}

export async function ingestFile(path: string, deps: IngestDeps): Promise<IngestFileResult> {
  const abs = resolve(path);
  const ext = extname(abs).toLowerCase();
  // PDF files are parsed async; text files read synchronously.
  const raw = ext === ".pdf" ? await parsePdf(abs) : readFileSync(abs, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const source = deps.source ?? `file://${abs}`;
  const title = deps.title ?? basename(abs);

  const existing = await deps.kb.getDocumentBySource(source);

  if (existing && existing.content_hash === hash) {
    const chunks = await deps.kb.countChunksForDocument(existing.id);
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
  for (let i = 0; i < chunks.length; i++) {
    await deps.kb.insertChunkWithEmbedding({
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

/**
 * Ingest a raw text document directly (no file system). Used by the
 * admin-UI "+ ADD" path so operators can paste markdown without a
 * shell. Source is synthesised as `inline:<sha256[:12]>` so subsequent
 * uploads of identical content dedupe via the existing `source` UNIQUE
 * lookup. Otherwise mirrors `ingestFile`'s semantics: chunk → embed →
 * insert with the same content-hash short-circuit.
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
  for (let i = 0; i < chunks.length; i++) {
    await deps.kb.insertChunkWithEmbedding({
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
  const root = resolve(dir);
  // When `deps.topic` is explicitly set, every file inherits it. Otherwise
  // derive per-file from the IMMEDIATE sub-directory name — a common
  // organisational convention in this codebase: `kb/curated/visa/*.md`,
  // `kb/curated/payment/*.md` etc. Files directly under `dir` (no
  // intermediate folder) stay untagged.
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
 * or null when the file is directly under `root`. Examples (root=`kb/curated`):
 *   visa/foo.md → "visa"
 *   visa/sub/foo.md → "visa"  (only the FIRST level under root counts)
 *   foo.md → null  (no enclosing topic dir)
 *
 * Exported for unit tests.
 */
export function deriveTopicFromPath(file: string, root: string): string | null {
  const rel = relative(root, dirname(file));
  // ".." means file is OUTSIDE root (or equal to root) — no usable topic.
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  // `relative` may use OS separators; normalise.
  const first = rel.split(/[/\\]/)[0]!;
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
 * Removes non-content noise that pollutes embeddings: HTML comments
 * (`<!-- ... -->`, including multi-line), and a leading YAML frontmatter
 * block (`---\n...\n---\n`). The visible markdown body is preserved as-is.
 */
export function stripNonContent(raw: string): string {
  let s = raw;
  // Drop a single YAML frontmatter at the very top, if present.
  s = s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // Drop all HTML comments (greedy match within a single comment).
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Collapse the trail of blank lines that the strip leaves behind.
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return `${s}\n`;
}
