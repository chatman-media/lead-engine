import {
  type IKbStore,
  type KbSearchHit,
  reciprocalRankFusion,
  sanitizeFtsQuery,
} from "@chatman-media/kb";
import { sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

/**
 * Drizzle/Postgres implementation `IKbStore` контракта из @chatman-media/kb.
 * Все запросы tenant_id-scoped: WHERE c.tenant_id = ? AND d.tenant_id = ?.
 *
 * Ingest-методы реализованы — пакет нужен и admin'ам (через
 * @chatman-media/kb's ingestFile/Directory) и runtime (search).
 *
 * Особенности относительно legacy kb-store implementation:
 *   - tenant_id обязателен в KOAЖ-дый JOIN'е (защита от cross-tenant leak)
 *   - конструируем pgvector литерал как '[...]' строку → cast ::vector
 *   - sanitizeFtsQuery импортируется из @chatman-media/kb (общая логика)
 *   - hybridSearch использует RRF из @chatman-media/kb
 */
export class DrizzleKbStore implements IKbStore {
  constructor(private readonly ctx: RepoCtx) {}

  private vec(embedding: number[]): string {
    return `[${embedding.join(",")}]`;
  }

  // ── Search ──────────────────────────────────────────────────────────────

  async search(embedding: number[], k: number, topic?: string | null): Promise<KbSearchHit[]> {
    const e = this.vec(embedding);
    const t = this.ctx.tenantId;

    if (topic == null) {
      const rows = await this.ctx.db.execute(sql`
        SELECT c.id AS chunk_id,
               (c.embedding <=> ${e}::vector) AS distance,
               c.text, c.document_id, d.source, d.title
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE c.embedding IS NOT NULL
          AND c.tenant_id = ${t}
          AND d.tenant_id = ${t}
        ORDER BY c.embedding <=> ${e}::vector ASC
        LIMIT ${k}
      `);
      return rows as unknown as KbSearchHit[];
    }
    // Over-fetch & post-filter по topic (исторически tg-chatbot также не
    // строгий равенство — допускает NULL-topic).
    const overFetched = (await this.ctx.db.execute(sql`
      SELECT c.id AS chunk_id,
             (c.embedding <=> ${e}::vector) AS distance,
             c.text, c.document_id, d.source, d.title, d.topic
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL
        AND c.tenant_id = ${t}
        AND d.tenant_id = ${t}
      ORDER BY c.embedding <=> ${e}::vector ASC
      LIMIT ${k * 3}
    `)) as unknown as Array<KbSearchHit & { topic: string | null }>;
    return overFetched
      .filter((h) => h.topic === topic || h.topic === null)
      .slice(0, k)
      .map(({ topic: _t, ...rest }) => rest);
  }

  private async searchBm25(query: string, k: number, topic?: string | null): Promise<KbSearchHit[]> {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const t = this.ctx.tenantId;
    try {
      if (topic == null) {
        const rows = await this.ctx.db.execute(sql`
          SELECT c.id AS chunk_id,
                 -ts_rank(c.fts, to_tsquery('russian', ${ftsQuery})) AS distance,
                 c.text, c.document_id, d.source, d.title
          FROM kb_chunks c
          JOIN kb_documents d ON d.id = c.document_id
          WHERE c.fts @@ to_tsquery('russian', ${ftsQuery})
            AND c.tenant_id = ${t}
            AND d.tenant_id = ${t}
          ORDER BY ts_rank(c.fts, to_tsquery('russian', ${ftsQuery})) DESC
          LIMIT ${k}
        `);
        return rows as unknown as KbSearchHit[];
      }
      const rows = await this.ctx.db.execute(sql`
        SELECT c.id AS chunk_id,
               -ts_rank(c.fts, to_tsquery('russian', ${ftsQuery})) AS distance,
               c.text, c.document_id, d.source, d.title
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        WHERE c.fts @@ to_tsquery('russian', ${ftsQuery})
          AND c.tenant_id = ${t}
          AND d.tenant_id = ${t}
          AND (d.topic = ${topic} OR d.topic IS NULL)
        ORDER BY ts_rank(c.fts, to_tsquery('russian', ${ftsQuery})) DESC
        LIMIT ${k}
      `);
      return rows as unknown as KbSearchHit[];
    } catch (err) {
      // BM25-fail должен быть transient (плохой query, dictionary mismatch);
      // не пускаем его наверх — pipeline вернёт пустой hybrid и fallback'нет
      // на чистый vector.
      console.warn(`[kb] BM25 query failed for "${query}":`, (err as Error).message);
      return [];
    }
  }

  /** BM25-only text search (без vector embeddings). Используется MCP-сервером. */
  async textSearch(query: string, k = 5, topic?: string | null): Promise<KbSearchHit[]> {
    return this.searchBm25(query, k, topic);
  }

  async hybridSearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    topic?: string | null;
  }): Promise<KbSearchHit[]> {
    const k = input.k ?? 5;
    const cands = k * 2;
    const topic = input.topic ?? null;

    const vectorHits = await this.search(input.embedding, cands, topic);
    const bm25Hits = await this.searchBm25(input.query, cands, topic);

    if (bm25Hits.length === 0) return vectorHits.slice(0, k);
    if (vectorHits.length === 0) return bm25Hits.slice(0, k);
    return reciprocalRankFusion(vectorHits, bm25Hits, k, 60);
  }

  async prioritySearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    vectorOnly?: boolean;
  }): Promise<KbSearchHit[]> {
    const k = input.k ?? 5;
    // Books-strict: фильтр по topic='books'; если пусто — global fallback.
    const booksHits = await this.search(input.embedding, k, "books");
    if (booksHits.length > 0) return booksHits;
    if (input.vectorOnly) return this.search(input.embedding, k);
    return this.hybridSearch({ embedding: input.embedding, query: input.query, k });
  }

  // ── Ingest ──────────────────────────────────────────────────────────────

  async getDocumentBySource(source: string): Promise<{ id: number; content_hash: string } | null> {
    const t = this.ctx.tenantId;
    const rows = (await this.ctx.db.execute(sql`
      SELECT id, content_hash
      FROM kb_documents
      WHERE source = ${source} AND tenant_id = ${t}
      LIMIT 1
    `)) as unknown as Array<{ id: number; content_hash: string }>;
    return rows[0] ?? null;
  }

  async countChunksForDocument(documentId: number): Promise<number> {
    const t = this.ctx.tenantId;
    const rows = (await this.ctx.db.execute(sql`
      SELECT COUNT(*)::INTEGER AS n
      FROM kb_chunks
      WHERE document_id = ${documentId} AND tenant_id = ${t}
    `)) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  async deleteDocument(id: number): Promise<boolean> {
    const t = this.ctx.tenantId;
    await this.ctx.db.execute(sql`
      DELETE FROM kb_chunks
      WHERE document_id = ${id} AND tenant_id = ${t}
    `);
    const result = await this.ctx.db.execute(sql`
      DELETE FROM kb_documents
      WHERE id = ${id} AND tenant_id = ${t}
    `);
    // execute() returns implementation-specific result; safe path —
    // отдельно проверить что row реально удалён.
    const check = (await this.ctx.db.execute(sql`
      SELECT 1 AS exists FROM kb_documents WHERE id = ${id} AND tenant_id = ${t}
    `)) as unknown as Array<{ exists: number }>;
    void result;
    return check.length === 0;
  }

  async upsertDocument(input: {
    source: string;
    title: string;
    contentHash: string;
    topic?: string | null;
  }): Promise<{ id: number }> {
    const t = this.ctx.tenantId;
    const topic = input.topic ?? null;
    // UNIQUE на (source, content_hash) — БЕЗ tenant_id в схеме (legacy);
    // на cross-tenant конфликт rely'ем что source включает tenant_slug
    // (recommended convention) либо контентом dedup'имся в seed-скрипте.
    const rows = (await this.ctx.db.execute(sql`
      INSERT INTO kb_documents (tenant_id, source, title, content_hash, topic)
      VALUES (${t}, ${input.source}, ${input.title}, ${input.contentHash}, ${topic})
      ON CONFLICT (source, content_hash) DO UPDATE SET source = EXCLUDED.source
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    if (!rows[0]) throw new Error("kb_documents upsert returned no row");
    return rows[0];
  }

  async insertChunkWithEmbedding(input: {
    documentId: number;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding: number[];
  }): Promise<void> {
    const t = this.ctx.tenantId;
    const e = this.vec(input.embedding);
    await this.ctx.db.execute(sql`
      INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, text, token_count, embedding)
      VALUES (${t}, ${input.documentId}, ${input.chunkIndex}, ${input.text}, ${input.tokenCount}, ${e}::vector)
    `);
  }
}
