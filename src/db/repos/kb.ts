import type { Database } from "bun:sqlite";
import { encodeVector } from "../sqlite.ts";

export interface KbDocumentRow {
  id: number;
  source: string;
  title: string;
  content_hash: string;
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
  }): KbDocumentRow {
    const existing = this.db
      .query<KbDocumentRow, [string, string]>(
        `SELECT * FROM kb_documents
         WHERE source = ? AND content_hash = ? LIMIT 1`,
      )
      .get(input.source, input.contentHash);
    if (existing) return existing;
    const row = this.db
      .query<KbDocumentRow, [string, string, string]>(
        `INSERT INTO kb_documents (source, title, content_hash)
         VALUES (?, ?, ?) RETURNING *`,
      )
      .get(input.source, input.title, input.contentHash);
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

  search(embedding: number[], k = 5): KbSearchHit[] {
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
