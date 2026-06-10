import {
	type IKbStore,
	type KbScope,
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

	private vecOrNull(embedding: number[] | null) {
		if (!embedding) return sql`NULL`;
		return sql`${this.vec(embedding)}::vector`;
	}

	private scopePredicate(scope?: KbScope | null) {
		if (!scope) return sql`TRUE`;
		if (scope.scopeType === "global") return sql`d.scope_type = 'global'`;
		if (scope.scopeType === "funnel") {
			return sql`d.scope_type = 'funnel' AND d.funnel_id = ${scope.funnelId ?? null}`;
		}
		return sql`d.scope_type = 'stage' AND d.funnel_id = ${scope.funnelId ?? null} AND d.stage_slug = ${scope.stageSlug ?? null}`;
	}

	// ── Search ──────────────────────────────────────────────────────────────

	async search(
		embedding: number[],
		k: number,
		topic?: string | null,
		scope?: KbScope | null,
	): Promise<KbSearchHit[]> {
		const e = this.vec(embedding);
		const t = this.ctx.tenantId;
		const scopePredicate = this.scopePredicate(scope);

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
          AND ${scopePredicate}
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
        AND ${scopePredicate}
      ORDER BY c.embedding <=> ${e}::vector ASC
      LIMIT ${k * 3}
    `)) as unknown as Array<KbSearchHit & { topic: string | null }>;
		return overFetched
			.filter((h) => h.topic === topic || h.topic === null)
			.slice(0, k)
			.map(({ topic: _t, ...rest }) => rest);
	}

	private async searchBm25(
		query: string,
		k: number,
		topic?: string | null,
		scope?: KbScope | null,
	): Promise<KbSearchHit[]> {
		const ftsQuery = sanitizeFtsQuery(query);
		if (!ftsQuery) return [];
		const t = this.ctx.tenantId;
		const scopePredicate = this.scopePredicate(scope);
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
            AND ${scopePredicate}
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
          AND ${scopePredicate}
        ORDER BY ts_rank(c.fts, to_tsquery('russian', ${ftsQuery})) DESC
        LIMIT ${k}
      `);
			return rows as unknown as KbSearchHit[];
		} catch (err) {
			// BM25-fail должен быть transient (плохой query, dictionary mismatch);
			// не пускаем его наверх — pipeline вернёт пустой hybrid и fallback'нет
			// на чистый vector.
			console.warn(
				`[kb] BM25 query failed for "${query}":`,
				(err as Error).message,
			);
			return [];
		}
	}

	/** BM25-only text search (без vector embeddings). Используется MCP-сервером. */
	async textSearch(
		query: string,
		k = 5,
		topic?: string | null,
		scope?: KbScope | null,
	): Promise<KbSearchHit[]> {
		return this.searchBm25(query, k, topic, scope);
	}

	async hybridSearch(input: {
		embedding: number[];
		query: string;
		k?: number;
		topic?: string | null;
		scope?: KbScope | null;
	}): Promise<KbSearchHit[]> {
		const k = input.k ?? 5;
		const cands = k * 2;
		const topic = input.topic ?? null;
		const scope = input.scope ?? null;

		const vectorHits = await this.search(input.embedding, cands, topic, scope);
		const bm25Hits = await this.searchBm25(input.query, cands, topic, scope);

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
		return this.hybridSearch({
			embedding: input.embedding,
			query: input.query,
			k,
		});
	}

	// ── Ingest ──────────────────────────────────────────────────────────────

	async getDocumentBySource(
		source: string,
	): Promise<{ id: number; content_hash: string } | null> {
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
		scope?: KbScope | null;
	}): Promise<{ id: number }> {
		const t = this.ctx.tenantId;
		const topic = input.topic ?? null;
		const scope = input.scope ?? null;
		const scopeType = scope?.scopeType ?? "global";
		const funnelId = scope?.funnelId ?? null;
		const stageSlug = scope?.stageSlug ?? null;
		// UNIQUE на (source, content_hash) — БЕЗ tenant_id в схеме (legacy);
		// на cross-tenant конфликт rely'ем что source включает tenant_slug
		// (recommended convention) либо контентом dedup'имся в seed-скрипте.
		const rows = (await this.ctx.db.execute(sql`
      INSERT INTO kb_documents (tenant_id, source, title, content_hash, topic, scope_type, funnel_id, stage_slug)
      VALUES (${t}, ${input.source}, ${input.title}, ${input.contentHash}, ${topic}, ${scopeType}, ${funnelId}, ${stageSlug})
      ON CONFLICT (source, content_hash) DO UPDATE SET
        title = EXCLUDED.title,
        topic = EXCLUDED.topic,
        scope_type = EXCLUDED.scope_type,
        funnel_id = EXCLUDED.funnel_id,
        stage_slug = EXCLUDED.stage_slug
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
		embedding: number[] | null;
	}): Promise<void> {
		const t = this.ctx.tenantId;
		const e = this.vecOrNull(input.embedding);
		await this.ctx.db.execute(sql`
      INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, text, token_count, embedding)
      VALUES (${t}, ${input.documentId}, ${input.chunkIndex}, ${input.text}, ${input.tokenCount}, ${e})
    `);
	}
}

/**
 * Runtime wrapper that scopes retrieval to the current operational context.
 *
 * Search order:
 *   stage docs -> funnel docs -> global docs.
 *
 * It deliberately falls back to broader scopes when a narrower scope has no
 * hits, so sparse per-stage KB does not make the bot silent.
 */
export class ScopedKbStore implements IKbStore {
	constructor(
		private readonly inner: IKbStore,
		private readonly scope: KbScope | null,
	) {}

	private scopes(): KbScope[] {
		if (!this.scope || this.scope.scopeType === "global") {
			return [{ scopeType: "global" }];
		}
		if (this.scope.scopeType === "funnel") {
			return [
				{ scopeType: "funnel", funnelId: this.scope.funnelId ?? null },
				{ scopeType: "global" },
			];
		}
		return [
			{
				scopeType: "stage",
				funnelId: this.scope.funnelId ?? null,
				stageSlug: this.scope.stageSlug ?? null,
			},
			{ scopeType: "funnel", funnelId: this.scope.funnelId ?? null },
			{ scopeType: "global" },
		];
	}

	private async firstNonEmpty(
		search: (scope: KbScope) => Promise<KbSearchHit[]>,
	): Promise<KbSearchHit[]> {
		for (const scope of this.scopes()) {
			const hits = await search(scope);
			if (hits.length > 0) return hits;
		}
		return [];
	}

	async search(
		embedding: number[],
		k: number,
		topic?: string | null,
	): Promise<KbSearchHit[]> {
		return this.firstNonEmpty((scope) =>
			this.inner.search(embedding, k, topic, scope),
		);
	}

	async hybridSearch(input: {
		embedding: number[];
		query: string;
		k?: number;
		topic?: string | null;
	}): Promise<KbSearchHit[]> {
		return this.firstNonEmpty((scope) =>
			this.inner.hybridSearch({ ...input, scope }),
		);
	}

	async prioritySearch(input: {
		embedding: number[];
		query: string;
		k?: number;
		vectorOnly?: boolean;
	}): Promise<KbSearchHit[]> {
		const k = input.k ?? 5;
		const booksHits = await this.firstNonEmpty((scope) =>
			this.inner.search(input.embedding, k, "books", scope),
		);
		if (booksHits.length > 0) return booksHits;
		if (input.vectorOnly) return this.search(input.embedding, k);
		return this.hybridSearch({
			embedding: input.embedding,
			query: input.query,
			k,
		});
	}

	getDocumentBySource(source: string) {
		return this.inner.getDocumentBySource(source);
	}

	countChunksForDocument(documentId: number) {
		return this.inner.countChunksForDocument(documentId);
	}

	deleteDocument(id: number) {
		return this.inner.deleteDocument(id);
	}

	upsertDocument(input: Parameters<IKbStore["upsertDocument"]>[0]) {
		return this.inner.upsertDocument(input);
	}

	insertChunkWithEmbedding(
		input: Parameters<IKbStore["insertChunkWithEmbedding"]>[0],
	) {
		return this.inner.insertChunkWithEmbedding(input);
	}
}
