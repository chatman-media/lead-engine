import type { Database } from "bun:sqlite";
import { encodeVector } from "../sqlite.ts";

export interface KbDocumentRow {
  id: number;
  source: string;
  title: string;
  content_hash: string;
  /** Optional thematic tag set at ingest time (visa / payment / locations /
   *  ...). NULL on legacy untagged docs — they're returned unconditionally
   *  by topic-filtered searches so back-compat is automatic. */
  topic: string | null;
  created_at: number;
}

export interface KbChunkRow {
  id: number;
  document_id: number;
  chunk_index: number;
  text: string;
  token_count: number;
  created_at: number;
}

export interface KbSearchHit {
  chunk_id: number;
  distance: number;
  text: string;
  document_id: number;
  source: string;
  title: string;
}

export class KbRepo {
  constructor(private db: Database) {}

  upsertDocument(input: {
    source: string;
    title: string;
    contentHash: string;
    /** Thematic tag (e.g. "visa", "payment"). NULL = untagged. Migration
     *  007 adds the column; existing tagged docs keep their tag through
     *  the unique-on-content_hash early-return below. */
    topic?: string | null;
  }): KbDocumentRow {
    const existing = this.db
      .query<KbDocumentRow, [string, string]>(
        `SELECT * FROM kb_documents
         WHERE source = ? AND content_hash = ? LIMIT 1`,
      )
      .get(input.source, input.contentHash);
    if (existing) return existing;
    const topic = input.topic ?? null;
    const row = this.db
      .query<KbDocumentRow, [string, string, string, string | null]>(
        `INSERT INTO kb_documents (source, title, content_hash, topic)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(input.source, input.title, input.contentHash, topic);
    if (!row) throw new Error("Failed to insert kb_document");
    return row;
  }

  deleteChunksByDocument(documentId: number) {
    const ids = this.db
      .query<{ id: number }, [number]>(
        "SELECT id FROM kb_chunks WHERE document_id = ?",
      )
      .all(documentId)
      .map((r) => r.id);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `DELETE FROM kb_vec WHERE chunk_id IN (${placeholders})`,
      ids as (number | string)[],
    );
    this.db.run(`DELETE FROM kb_chunks WHERE document_id = ?`, [documentId]);
  }

  insertChunkWithEmbedding(input: {
    documentId: number;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding: number[];
  }): KbChunkRow {
    const chunk = this.db
      .query<KbChunkRow, [number, number, string, number]>(
        `INSERT INTO kb_chunks (document_id, chunk_index, text, token_count)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(input.documentId, input.chunkIndex, input.text, input.tokenCount);
    if (!chunk) throw new Error("Failed to insert kb_chunk");
    this.db.run(
      `INSERT INTO kb_vec (chunk_id, embedding) VALUES (?, ?)`,
      [chunk.id, encodeVector(input.embedding)],
    );
    return chunk;
  }

  search(embedding: number[], k = 5, topic?: string | null): KbSearchHit[] {
    // The vector index returns chunks first; we then drop those whose
    // document doesn't match the requested topic. Filtering AFTER `MATCH`
    // is necessary because sqlite-vec's `MATCH` clause and arbitrary WHERE
    // predicates can't be combined in one query — the engine needs `k`
    // to do the KNN scan, and adding a topic filter would shrink the
    // candidate pool unpredictably. Over-fetch (3*k) when a topic is set
    // so we still hand back ~k useful hits after the filter.
    if (topic == null) {
      return this.db
        .query<KbSearchHit, [Uint8Array, number]>(
          `SELECT v.chunk_id AS chunk_id,
                  v.distance AS distance,
                  c.text AS text,
                  c.document_id AS document_id,
                  d.source AS source,
                  d.title AS title
           FROM kb_vec v
           JOIN kb_chunks c ON c.id = v.chunk_id
           JOIN kb_documents d ON d.id = c.document_id
           WHERE v.embedding MATCH ? AND k = ?
           ORDER BY v.distance ASC`,
        )
        .all(encodeVector(embedding), k);
    }
    const overFetched = this.db
      .query<KbSearchHit & { topic: string | null }, [Uint8Array, number]>(
        `SELECT v.chunk_id AS chunk_id,
                v.distance AS distance,
                c.text AS text,
                c.document_id AS document_id,
                d.source AS source,
                d.title AS title,
                d.topic AS topic
         FROM kb_vec v
         JOIN kb_chunks c ON c.id = v.chunk_id
         JOIN kb_documents d ON d.id = c.document_id
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance ASC`,
      )
      .all(encodeVector(embedding), k * 3);
    // Keep only docs tagged with the requested topic OR untagged
    // (NULL topic acts as "neutral" — won't be excluded). Strip the
    // `topic` field before returning so the row shape stays canonical.
    return overFetched
      .filter((h) => h.topic === topic || h.topic === null)
      .slice(0, k)
      .map(({ topic: _t, ...rest }) => rest);
  }

  /**
   * BM25 keyword search over `kb_chunks_fts` (FTS5 virtual table created in
   * migration 005). Returns hits sorted by BM25 score (more negative = better
   * match in SQLite's FTS5). The `distance` field is reused for the BM25
   * score so callers can treat both indexes uniformly — note that BM25 and
   * vector distance are NOT directly comparable; they must be merged by
   * RANK (RRF) not by raw score.
   *
   * Returns [] when:
   *   - the query has no matchable tokens (whitespace / punctuation only)
   *   - FTS5 rejects the query as malformed (operator chars in user input)
   * In both cases hybridSearch falls through to vector-only retrieval.
   */
  searchBm25(query: string, k = 5, topic?: string | null): KbSearchHit[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    // FTS5 plays well with extra WHERE clauses, so the topic filter goes
    // straight into the SQL — no over-fetch needed (unlike the vector
    // side which has the AND-with-MATCH limitation).
    const topicWhere = topic == null ? "" : "AND (d.topic = ? OR d.topic IS NULL)";
    const params: Array<string | number> =
      topic == null ? [ftsQuery, k] : [ftsQuery, topic, k];
    try {
      return this.db
        .query<KbSearchHit, typeof params>(
          `SELECT f.rowid AS chunk_id,
                  bm25(kb_chunks_fts) AS distance,
                  c.text AS text,
                  c.document_id AS document_id,
                  d.source AS source,
                  d.title AS title
           FROM kb_chunks_fts f
           JOIN kb_chunks c ON c.id = f.rowid
           JOIN kb_documents d ON d.id = c.document_id
           WHERE kb_chunks_fts MATCH ? ${topicWhere}
           ORDER BY bm25(kb_chunks_fts) ASC
           LIMIT ?`,
        )
        .all(...params);
    } catch (err) {
      // FTS5 throws SQLITE_ERROR on malformed queries (e.g. unbalanced
      // parens, dangling operators). Treat those as "no BM25 hits" rather
      // than blowing up the whole RAG turn — the vector side still runs.
      console.warn(`[kb] BM25 query failed for "${query}":`, (err as Error).message);
      return [];
    }
  }

  /**
   * Hybrid retrieval: vector search + BM25, fused via reciprocal rank fusion.
   *
   * Why RRF and not score-blending: BM25 scores and L2 distances live in
   * incompatible spaces. Trying to weight them ("0.7*vec + 0.3*bm25")
   * requires per-corpus tuning and breaks when the embedding model changes.
   * RRF only uses RANKS — robust, parameter-light, and the standard fusion
   * choice in production search systems.
   *
   * Pulls 2*k candidates from each side to avoid the merged top-k being
   * starved by one weak index. Returns vector-only hits when BM25 has none
   * (and vice versa) so a single broken side never zeroes out retrieval.
   *
   * The returned `distance` is the FUSED rank (lower = better) — NOT the
   * vector L2 distance. Callers using `maxDistance` thresholds should pass
   * `applyMaxDistanceToVectorOnly: true` (or filter externally) since the
   * fused score is on a different scale.
   */
  hybridSearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    /** Per-side candidate cap. Default `k * 2`. */
    candidatesPerSide?: number;
    /** RRF constant. Default 60 (the value from the original 2009 paper). */
    rrfK?: number;
    /** Restrict both sides to docs with this topic (or NULL). */
    topic?: string | null;
  }): KbSearchHit[] {
    const k = input.k ?? 5;
    const cands = input.candidatesPerSide ?? k * 2;
    const rrfK = input.rrfK ?? 60;
    const topic = input.topic ?? null;

    const vectorHits = this.search(input.embedding, cands, topic);
    const bm25Hits = this.searchBm25(input.query, cands, topic);

    if (bm25Hits.length === 0) return vectorHits.slice(0, k);
    if (vectorHits.length === 0) return bm25Hits.slice(0, k);

    return reciprocalRankFusion(vectorHits, bm25Hits, k, rrfK);
  }

  countDocuments(): number {
    const r = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kb_documents")
      .get();
    return r?.n ?? 0;
  }

  countChunks(): number {
    const r = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kb_chunks")
      .get();
    return r?.n ?? 0;
  }
}

/**
 * Strip FTS5 query operators from raw user text and join meaningful tokens
 * with implicit AND. We pass an OR-joined token list instead so any of the
 * keywords matches — better recall on conversational queries where exact
 * phrases are rare ("сколько платят в Дубае" should hit both "Дубай"-only
 * and "оплата"-only chunks).
 *
 * Drops tokens shorter than 2 chars (mostly noise) and prefix-matches all
 * remaining tokens with `*`. Note: FTS5 prefix matching is forward-only —
 * query "виз*" matches indexed "виза"/"визу"/"визой", but query "визой*"
 * does NOT match indexed "виза". For full Russian morphology you'd need a
 * snowball stemmer — out of scope here. The vector side of hybrid search
 * picks up morphology variants via embeddings, so the gap is mostly closed
 * end-to-end even with this limitation.
 *
 * Exported for unit tests.
 */
export function sanitizeFtsQuery(raw: string): string {
  if (!raw) return "";
  // FTS5 query operators we don't want users to control via raw text.
  const stripped = raw
    .replace(/["'()*:.\\^]/g, " ")
    .replace(/\s+(AND|OR|NOT|NEAR)\s+/gi, " ");
  const tokens = stripped
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  // Prefix match each token + OR fusion so word-form variations all hit.
  // Quote each token to neutralize any residual operator chars defensively.
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

/**
 * Reciprocal Rank Fusion of two ranked hit lists. Each hit gets a fused
 * score of Σ(1 / (rrfK + rank)) across the lists where it appears.
 * Higher score = better match. We then re-pack the top-k results into
 * `KbSearchHit` shape with `distance` = (1 - fusedScore) so the `distance`
 * field stays "lower is better" like its vector counterpart.
 *
 * Exported for unit tests.
 */
export function reciprocalRankFusion(
  vectorHits: KbSearchHit[],
  bm25Hits: KbSearchHit[],
  k: number,
  rrfK = 60,
): KbSearchHit[] {
  const scores = new Map<number, { hit: KbSearchHit; score: number }>();

  const addRanked = (hits: KbSearchHit[]) => {
    hits.forEach((h, i) => {
      const rank = i + 1;
      const inc = 1 / (rrfK + rank);
      const prev = scores.get(h.chunk_id);
      if (prev) {
        prev.score += inc;
      } else {
        scores.set(h.chunk_id, { hit: h, score: inc });
      }
    });
  };
  addRanked(vectorHits);
  addRanked(bm25Hits);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ hit, score }) => ({
      ...hit,
      // Re-cast fused score to a "lower-is-better" distance so the rest of
      // the pipeline can treat hybrid hits uniformly with vector hits.
      distance: 1 - score,
    }));
}
