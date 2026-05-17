import type { IKbStore, KbSearchHit } from "../types.ts";
import { reciprocalRankFusion } from "../utils.ts";

interface StoredDocument {
  id: number;
  source: string;
  title: string;
  contentHash: string;
  topic: string | null;
}

interface StoredChunk {
  chunkId: number;
  documentId: number;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  embedding: number[];
}

/**
 * Zero-dependency in-memory `IKbStore` implementation.
 *
 * Suitable for:
 * - Unit / integration tests (no database required)
 * - Quick prototyping and examples
 * - Demos and tutorials
 *
 * Limitations vs a real pgvector store:
 * - O(n) linear scan for every search (no index) — fine up to ~50k chunks
 * - BM25 is a minimal TF-IDF approximation, not a full BM25 implementation
 * - Data is not persisted across process restarts
 *
 * @example
 * ```ts
 * import { InMemoryKbStore, ingestText, OllamaEmbeddingClient } from "@chatman-media/rag";
 *
 * const kb = new InMemoryKbStore();
 * const embedder = new OllamaEmbeddingClient({ host: "http://localhost:11434", model: "nomic-embed-text", dim: 768 });
 *
 * await ingestText({ title: "FAQ", body: "..." }, { kb, embedder });
 * const hits = await kb.search(await embedder.embed(["query"])[0], 5);
 * ```
 */
export class InMemoryKbStore implements IKbStore {
  private docs: StoredDocument[] = [];
  private chunks: StoredChunk[] = [];
  private nextDocId = 1;
  private nextChunkId = 1;

  // ── Search ────────────────────────────────────────────────────────────────

  async search(embedding: number[], k: number, topic?: string | null): Promise<KbSearchHit[]> {
    const pool = topic
      ? this.chunks.filter((c) => this.topicOf(c.documentId) === topic)
      : this.chunks;
    return pool
      .map((c) => ({ chunk: c, distance: cosineDistance(embedding, c.embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k)
      .map(({ chunk, distance }) => this.toHit(chunk, distance));
  }

  async hybridSearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    topic?: string | null;
  }): Promise<KbSearchHit[]> {
    const k = input.k ?? 5;
    const pool = input.topic
      ? this.chunks.filter((c) => this.topicOf(c.documentId) === input.topic)
      : this.chunks;

    const vec = pool
      .map((c) => ({ chunk: c, distance: cosineDistance(input.embedding, c.embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k * 2)
      .map(({ chunk, distance }) => this.toHit(chunk, distance));

    const bm25 = simpleBm25(input.query, pool)
      .slice(0, k * 2)
      .map(({ chunk, score }) => this.toHit(chunk, -score));

    if (bm25.length === 0) return vec.slice(0, k);
    return reciprocalRankFusion(vec, bm25, k);
  }

  async prioritySearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    vectorOnly?: boolean;
  }): Promise<KbSearchHit[]> {
    const k = input.k ?? 5;
    const booksHits = input.vectorOnly
      ? await this.search(input.embedding, k, "books")
      : await this.hybridSearch({ ...input, k, topic: "books" });
    if (booksHits.length > 0) return booksHits;
    return input.vectorOnly ? this.search(input.embedding, k) : this.hybridSearch({ ...input, k });
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  async getDocumentBySource(source: string): Promise<{ id: number; content_hash: string } | null> {
    const doc = this.docs.find((d) => d.source === source);
    return doc ? { id: doc.id, content_hash: doc.contentHash } : null;
  }

  async countChunksForDocument(documentId: number): Promise<number> {
    return this.chunks.filter((c) => c.documentId === documentId).length;
  }

  async deleteDocument(id: number): Promise<boolean> {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => d.id !== id);
    this.chunks = this.chunks.filter((c) => c.documentId !== id);
    return this.docs.length < before;
  }

  async upsertDocument(input: {
    source: string;
    title: string;
    contentHash: string;
    topic?: string | null;
  }): Promise<{ id: number }> {
    const existing = this.docs.find((d) => d.source === input.source);
    if (existing) {
      existing.title = input.title;
      existing.contentHash = input.contentHash;
      existing.topic = input.topic ?? null;
      return { id: existing.id };
    }
    const id = this.nextDocId++;
    this.docs.push({
      id,
      source: input.source,
      title: input.title,
      contentHash: input.contentHash,
      topic: input.topic ?? null,
    });
    return { id };
  }

  async insertChunkWithEmbedding(input: {
    documentId: number;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding: number[];
  }): Promise<void> {
    this.chunks.push({
      chunkId: this.nextChunkId++,
      documentId: input.documentId,
      chunkIndex: input.chunkIndex,
      text: input.text,
      tokenCount: input.tokenCount,
      embedding: input.embedding,
    });
  }

  /** Total number of indexed chunks. Useful in tests. */
  get chunkCount(): number {
    return this.chunks.length;
  }

  /** Total number of indexed documents. Useful in tests. */
  get documentCount(): number {
    return this.docs.length;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private topicOf(documentId: number): string | null {
    return this.docs.find((d) => d.id === documentId)?.topic ?? null;
  }

  private toHit(chunk: StoredChunk, distance: number): KbSearchHit {
    const doc = this.docs.find((d) => d.id === chunk.documentId);
    return {
      chunk_id: chunk.chunkId,
      distance,
      text: chunk.text,
      document_id: chunk.documentId,
      source: doc?.source ?? "",
      title: doc?.title ?? "",
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Minimal TF-IDF approximation — good enough for in-memory BM25 ranking. */
function simpleBm25(
  query: string,
  chunks: StoredChunk[],
): Array<{ chunk: StoredChunk; score: number }> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const df = new Map<string, number>();
  const N = chunks.length;
  for (const chunk of chunks) {
    const terms = new Set(tokenize(chunk.text));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }

  return chunks
    .map((chunk) => {
      const words = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
      const dl = words.length;
      const avgdl = 50;
      const k1 = 1.5;
      const b = 0.75;

      let score = 0;
      for (const t of tokens) {
        const idf = Math.log((N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5) + 1);
        const tfVal = tf.get(t) ?? 0;
        score += idf * ((tfVal * (k1 + 1)) / (tfVal + k1 * (1 - b + b * (dl / avgdl))));
      }
      return { chunk, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}
