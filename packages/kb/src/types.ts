/**
 * Storage interfaces for the RAG engine.
 *
 * The package defines these interfaces; consumers provide implementations.
 * The reference implementation (`PgKbStore`) ships with the main sales-guru
 * project and wraps the PostgreSQL + pgvector repos.
 */

export interface KbSearchHit {
  chunk_id: number;
  /** Cosine distance (vector search) or negated BM25 rank (FTS). Lower = closer. */
  distance: number;
  text: string;
  document_id: number;
  source: string;
  title: string;
}

/**
 * Minimal contract the RAG engine needs from whatever storage backend you
 * plug in. Split into two logical groups:
 *
 * - **Search** — called by `answerWithRag` at query time (read-only).
 * - **Ingest** — called by `ingestFile` / `ingestText` / `ingestDirectory`
 *   when indexing documents (read+write).
 */
export interface IKbStore {
  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Pure vector search (cosine distance via pgvector or equivalent).
   * Returns up to `k` hits, optionally filtered by `topic`.
   */
  search(embedding: number[], k: number, topic?: string | null): Promise<KbSearchHit[]>;

  /**
   * Hybrid retrieval: fuse vector + BM25 results via Reciprocal Rank Fusion.
   * Falls back to vector-only when the FTS index returns nothing.
   */
  hybridSearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    topic?: string | null;
  }): Promise<KbSearchHit[]>;

  /**
   * Books-priority search: tries the "books" topic first, falls back to
   * global search when no books-tagged chunks match. Used when `booksPriority`
   * is set on `AnswerInput`.
   */
  prioritySearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    vectorOnly?: boolean;
  }): Promise<KbSearchHit[]>;

  // ── Ingest ──────────────────────────────────────────────────────────────────

  /** Look up an existing document by its source URI. */
  getDocumentBySource(source: string): Promise<{ id: number; content_hash: string } | null>;

  /** Count indexed chunks for a document (used for dedup short-circuit). */
  countChunksForDocument(documentId: number): Promise<number>;

  /** Delete a document and all its chunks (called before re-indexing). */
  deleteDocument(id: number): Promise<boolean>;

  /** Upsert a document record; returns the canonical row id. */
  upsertDocument(input: {
    source: string;
    title: string;
    contentHash: string;
    topic?: string | null;
  }): Promise<{ id: number }>;

  /** Insert one chunk with its embedding vector. */
  insertChunkWithEmbedding(input: {
    documentId: number;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding: number[];
  }): Promise<void>;
}

/** Optional write-only interface for logging unanswered questions. */
export interface IKbSuggestionsStore {
  log(question: string, conversationId: string): Promise<void>;
}
