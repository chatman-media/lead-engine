import type { Sql } from "../postgres.ts";

export interface KbDocumentRow {
  id: number;
  source: string;
  title: string;
  content_hash: string;
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
  constructor(private sql: Sql) {}

  async upsertDocument(input: {
    source: string;
    title: string;
    contentHash: string;
    topic?: string | null;
  }): Promise<KbDocumentRow> {
    const topic = input.topic ?? null;
    // Atomic upsert against uniq_kb_source_hash index. DO UPDATE on a sentinel
    // column lets RETURNING * fire for both new and existing rows (a plain
    // DO NOTHING would silently skip RETURNING on conflict).
    const [row] = await this.sql<KbDocumentRow[]>`
      INSERT INTO kb_documents (source, title, content_hash, topic)
      VALUES (${input.source}, ${input.title}, ${input.contentHash}, ${topic})
      ON CONFLICT (source, content_hash) DO UPDATE SET source = EXCLUDED.source
      RETURNING *
    `;
    if (!row) throw new Error("Failed to upsert kb_document");
    return row;
  }

  async deleteChunksByDocument(documentId: number): Promise<void> {
    await this.sql`DELETE FROM kb_chunks WHERE document_id = ${documentId}`;
  }

  async insertChunkWithEmbedding(input: {
    documentId: number;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding: number[];
  }): Promise<KbChunkRow> {
    const embeddingStr = JSON.stringify(input.embedding);
    const [row] = await this.sql<KbChunkRow[]>`
      INSERT INTO kb_chunks (document_id, chunk_index, text, token_count, embedding)
      VALUES (${input.documentId}, ${input.chunkIndex}, ${input.text}, ${input.tokenCount}, ${embeddingStr}::vector)
      RETURNING id, document_id, chunk_index, text, token_count, created_at
    `;
    if (!row) throw new Error("Failed to insert kb_chunk");
    return row;
  }

  async search(embedding: number[], k = 5, topic?: string | null): Promise<KbSearchHit[]> {
    const embStr = JSON.stringify(embedding);
    if (topic == null) {
      return this.sql<KbSearchHit[]>`
        SELECT c.id AS chunk_id,
               (c.embedding <=> ${embStr}::vector) AS distance,
               c.text, c.document_id, d.source, d.title
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${embStr}::vector ASC
        LIMIT ${k}
      `;
    }
    // With topic filter: over-fetch then filter
    const overFetched = await this.sql<(KbSearchHit & { topic: string | null })[]>`
      SELECT c.id AS chunk_id,
             (c.embedding <=> ${embStr}::vector) AS distance,
             c.text, c.document_id, d.source, d.title, d.topic
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${embStr}::vector ASC
      LIMIT ${k * 3}
    `;
    return overFetched
      .filter((h) => h.topic === topic || h.topic === null)
      .slice(0, k)
      .map(({ topic: _t, ...rest }) => rest);
  }

  async searchBm25(query: string, k = 5, topic?: string | null): Promise<KbSearchHit[]> {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      if (topic == null) {
        return this.sql<KbSearchHit[]>`
          SELECT c.id AS chunk_id,
                 -ts_rank(c.fts, plainto_tsquery('russian', ${query})) AS distance,
                 c.text, c.document_id, d.source, d.title
          FROM kb_chunks c
          JOIN kb_documents d ON d.id = c.document_id
          WHERE c.fts @@ plainto_tsquery('russian', ${query})
          ORDER BY ts_rank(c.fts, plainto_tsquery('russian', ${query})) DESC
          LIMIT ${k}
        `;
      }
      return this.sql<KbSearchHit[]>`
        SELECT c.id AS chunk_id,
               -ts_rank(c.fts, plainto_tsquery('russian', ${query})) AS distance,
               c.text, c.document_id, d.source, d.title
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE c.fts @@ plainto_tsquery('russian', ${query})
          AND (d.topic = ${topic} OR d.topic IS NULL)
        ORDER BY ts_rank(c.fts, plainto_tsquery('russian', ${query})) DESC
        LIMIT ${k}
      `;
    } catch (err) {
      console.warn(`[kb] BM25 query failed for "${query}":`, (err as Error).message);
      return [];
    }
  }

  async hybridSearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    candidatesPerSide?: number;
    rrfK?: number;
    topic?: string | null;
  }): Promise<KbSearchHit[]> {
    const k = input.k ?? 5;
    const cands = input.candidatesPerSide ?? k * 2;
    const rrfK = input.rrfK ?? 60;
    const topic = input.topic ?? null;

    const vectorHits = await this.search(input.embedding, cands, topic);
    const bm25Hits = await this.searchBm25(input.query, cands, topic);

    if (bm25Hits.length === 0) return vectorHits.slice(0, k);
    if (vectorHits.length === 0) return bm25Hits.slice(0, k);

    return reciprocalRankFusion(vectorHits, bm25Hits, k, rrfK);
  }

  async listDocuments(opts?: {
    topic?: string | null;
    q?: string;
    limit?: number;
  }): Promise<Array<KbDocumentRow & { chunk_count: number }>> {
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);

    // Build conditionally
    const isUntagged = opts?.topic === "__untagged__";
    const hasTopic = !isUntagged && typeof opts?.topic === "string";
    const hasQ = !!opts?.q?.trim();
    const qPat = hasQ ? `%${opts!.q!.trim().toLowerCase()}%` : null;

    if (isUntagged && hasQ) {
      return this.sql<Array<KbDocumentRow & { chunk_count: number }>>`
        SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
        FROM kb_documents d
        WHERE d.topic IS NULL
          AND (LOWER(d.title) LIKE ${qPat} OR LOWER(d.source) LIKE ${qPat})
        ORDER BY d.created_at DESC
        LIMIT ${limit}
      `;
    }
    if (isUntagged) {
      return this.sql<Array<KbDocumentRow & { chunk_count: number }>>`
        SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
        FROM kb_documents d
        WHERE d.topic IS NULL
        ORDER BY d.created_at DESC
        LIMIT ${limit}
      `;
    }
    if (hasTopic && hasQ) {
      return this.sql<Array<KbDocumentRow & { chunk_count: number }>>`
        SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
        FROM kb_documents d
        WHERE d.topic = ${opts!.topic!}
          AND (LOWER(d.title) LIKE ${qPat} OR LOWER(d.source) LIKE ${qPat})
        ORDER BY d.created_at DESC
        LIMIT ${limit}
      `;
    }
    if (hasTopic) {
      return this.sql<Array<KbDocumentRow & { chunk_count: number }>>`
        SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
        FROM kb_documents d
        WHERE d.topic = ${opts!.topic!}
        ORDER BY d.created_at DESC
        LIMIT ${limit}
      `;
    }
    if (hasQ) {
      return this.sql<Array<KbDocumentRow & { chunk_count: number }>>`
        SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
        FROM kb_documents d
        WHERE LOWER(d.title) LIKE ${qPat} OR LOWER(d.source) LIKE ${qPat}
        ORDER BY d.created_at DESC
        LIMIT ${limit}
      `;
    }
    return this.sql<Array<KbDocumentRow & { chunk_count: number }>>`
      SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
      FROM kb_documents d
      ORDER BY d.created_at DESC
      LIMIT ${limit}
    `;
  }

  async getDocument(id: number): Promise<KbDocumentRow | null> {
    const [row] = await this.sql<KbDocumentRow[]>`
      SELECT * FROM kb_documents WHERE id = ${id}
    `;
    return row ?? null;
  }

  async getDocumentBySource(source: string): Promise<KbDocumentRow | null> {
    const [row] = await this.sql<KbDocumentRow[]>`
      SELECT * FROM kb_documents WHERE source = ${source} LIMIT 1
    `;
    return row ?? null;
  }

  async countChunksForDocument(documentId: number): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM kb_chunks WHERE document_id = ${documentId}
    `;
    return row?.n ?? 0;
  }

  async listChunks(documentId: number): Promise<KbChunkRow[]> {
    return this.sql<KbChunkRow[]>`
      SELECT id, document_id, chunk_index, text, token_count, created_at
      FROM kb_chunks WHERE document_id = ${documentId} ORDER BY chunk_index ASC
    `;
  }

  async listTopics(): Promise<string[]> {
    const rows = await this.sql<{ topic: string }[]>`
      SELECT DISTINCT topic FROM kb_documents WHERE topic IS NOT NULL ORDER BY topic ASC
    `;
    return rows.map((r) => r.topic);
  }

  async setTopic(id: number, topic: string | null): Promise<KbDocumentRow | null> {
    const [row] = await this.sql<KbDocumentRow[]>`
      UPDATE kb_documents SET topic = ${topic} WHERE id = ${id} RETURNING *
    `;
    return row ?? null;
  }

  async deleteDocument(id: number): Promise<boolean> {
    await this.deleteChunksByDocument(id);
    const result = await this.sql`DELETE FROM kb_documents WHERE id = ${id}`;
    return result.count > 0;
  }

  private async searchBooksStrict(embedding: number[], k: number): Promise<KbSearchHit[]> {
    const embStr = JSON.stringify(embedding);
    const overFetched = await this.sql<(KbSearchHit & { topic: string | null })[]>`
      SELECT c.id AS chunk_id,
             (c.embedding <=> ${embStr}::vector) AS distance,
             c.text, c.document_id, d.source, d.title, d.topic
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${embStr}::vector ASC
      LIMIT ${k * 3}
    `;
    return overFetched
      .filter((h) => h.topic === "books")
      .slice(0, k)
      .map(({ topic: _t, ...rest }) => rest);
  }

  async prioritySearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    vectorOnly?: boolean;
  }): Promise<KbSearchHit[]> {
    const k = input.k ?? 5;

    const bookHits = await this.searchBooksStrict(input.embedding, k);
    if (bookHits.length > 0) return bookHits;

    return input.vectorOnly
      ? this.search(input.embedding, k)
      : this.hybridSearch({ embedding: input.embedding, query: input.query, k });
  }

  async countDocuments(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM kb_documents`;
    return r?.n ?? 0;
  }

  async countChunks(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM kb_chunks`;
    return r?.n ?? 0;
  }
}

export function sanitizeFtsQuery(raw: string): string {
  if (!raw) return "";
  const stripped = raw.replace(/["'()*:.\\^]/g, " ").replace(/\s+(AND|OR|NOT|NEAR)\s+/gi, " ");
  const tokens = stripped
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

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
      distance: 1 - score,
    }));
}
