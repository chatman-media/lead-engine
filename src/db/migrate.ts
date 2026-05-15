import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { activeEmbeddingDim } from "../config.ts";
import { log } from "../log.ts";
import type { Sql } from "./postgres.ts";

const SCHEMA_PATH = resolve(import.meta.dir, "../../migrations/pg_schema.sql");

/**
 * Apply `pg_schema.sql` against the configured DB, adjusting the vector
 * dimension of `kb_chunks.embedding` to match the active embedder.
 *
 * Why this isn't trivial:
 * - `pg_schema.sql` hardcodes `vector(1536)` (the OpenAI default).
 * - `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists,
 *   so a column created at one dimension stays at that dimension forever —
 *   even if `OPENAI_EMBEDDING_DIM` / `OLLAMA_EMBEDDING_DIM` later changes.
 * - The result: inserts fail at runtime with "expected N dimensions, not M"
 *   and the operator has to drop the table by hand. The README has been
 *   advertising auto-recreation for a while; this function makes it real.
 *
 * Strategy: read the active dim from config, patch the schema in-flight,
 * and (if the existing column has a different dim) drop kb_chunks +
 * kb_documents so the patched schema can recreate them cleanly. Data loss
 * is intentional — embeddings can't be cast between dims, KB is always
 * re-ingestable from `kb/`.
 */
export async function runMigrations(
  sql: Sql,
  opts: { embeddingDim?: number } = {},
): Promise<{ recreated: boolean; previous_dim: number | null; new_dim: number }> {
  const targetDim = opts.embeddingDim ?? activeEmbeddingDim();
  const schema = readFileSync(SCHEMA_PATH, "utf8");

  const currentDim = await getKbChunksDim(sql);
  let recreated = false;

  if (currentDim !== null && currentDim !== targetDim) {
    log.warn("kb_chunks embedding dim changed — dropping for recreate", {
      scope: "migrate",
      previous_dim: currentDim,
      new_dim: targetDim,
    });
    // CASCADE clears the dependent indexes (FTS, ivfflat) and the FK in
    // kb_suggestions.kb_document_id. Wiping kb_documents too so re-ingest
    // starts from a clean state — orphan documents with no chunks would
    // confuse the "[server] KB is empty" auto-ingest gate.
    await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
    await sql`DROP TABLE IF EXISTS kb_documents CASCADE`;
    recreated = true;
    log.warn("kb tables dropped — re-ingest will run on next idle", {
      scope: "migrate",
    });
  }

  // Patch the hardcoded vector(N) in the schema to the active dim. Idempotent
  // when the table already exists at the right dim (CREATE TABLE IF NOT EXISTS
  // is a no-op). When we just dropped the table above, this creates it fresh.
  const patched = schema.replace(/embedding\s+vector\(\d+\)/g, `embedding vector(${targetDim})`);
  await sql.unsafe(patched);

  console.log("[migrate] PostgreSQL schema applied");
  return { recreated, previous_dim: currentDim, new_dim: targetDim };
}

/**
 * Read the configured dimension of `kb_chunks.embedding`. Returns null when
 * the table doesn't exist yet (first-ever migration on a fresh DB) so the
 * caller can distinguish "first install" from "dim drift detected".
 *
 * pgvector stores the dim in `pg_attribute.atttypmod` on the column.
 */
export async function getKbChunksDim(sql: Sql): Promise<number | null> {
  const rows = await sql<{ atttypmod: number }[]>`
    SELECT atttypmod
    FROM pg_attribute
    WHERE attrelid = to_regclass('kb_chunks')
      AND attname = 'embedding'
      AND NOT attisdropped
  `;
  const row = rows[0];
  if (!row || row.atttypmod <= 0) return null;
  return row.atttypmod;
}
