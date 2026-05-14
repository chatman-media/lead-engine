import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

export type TestSql = ReturnType<typeof postgres>;

export function getTestSql(): TestSql {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set for DB tests");
  // Each call creates a new isolated connection pool. Callers call sql.end()
  // in afterAll, which only closes their own pool — no cross-file interference.
  // BIGINT → number cast mirrors src/db/postgres.ts so tests see the same types
  // as production (Telegram IDs fit in Number.MAX_SAFE_INTEGER).
  //
  // `max: 1` is intentional: with 50+ test files each owning a pool, even
  // max:3 risks blowing past Postgres's default `max_connections=100` when
  // the harness runs files in parallel. Tests inside a single file are
  // serial, so one connection suffices; the constraint is between-file.
  return postgres(url, {
    max: 1,
    idle_timeout: 5,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
}

export async function setupTestDb(
  sql: TestSql,
  opts: { embeddingDim?: number } = {},
): Promise<void> {
  const schemaPath = resolve(import.meta.dir, "../../migrations/pg_schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  // Most tests use fake embedders with a small dim (default 8) to avoid the
  // overhead of real 1536-d vectors. Patch the schema's hardcoded
  // `vector(1536)` in-flight so chunks insertion doesn't fail with a dim
  // mismatch.
  const dim = opts.embeddingDim ?? 8;
  // Test files run sequentially against the SAME database, so the first
  // file's `CREATE TABLE IF NOT EXISTS kb_chunks` wins and locks the
  // embedding column to its chosen dim. Drop kb_chunks (CASCADE clears the
  // dependent indexes and the generated `fts` column) before re-applying
  // schema so each file gets its requested dim.
  await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
  const patched = schema.replace(/embedding\s+vector\(\d+\)/g, `embedding vector(${dim})`);
  await sql.unsafe(patched);
  // IVFFlat requires many rows before its index is useful; in tests we only
  // insert a handful of KB chunks. Replace it with an HNSW index which works
  // correctly at any cardinality (no minimum row count for recall).
  await sql`DROP INDEX IF EXISTS idx_kb_chunks_embedding`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_hnsw
      ON kb_chunks USING hnsw (embedding vector_cosine_ops)
  `;
}

export async function cleanTestDb(sql: TestSql): Promise<void> {
  await sql`
    TRUNCATE users, conversations, messages, kb_documents, kb_chunks,
             admins, sessions, styles, experiments, skills, style_skills,
             skill_outcomes, style_ratings, self_play_matches, pairwise_matches,
             coach_proposals, shadow_evaluations, leads, lead_events, lead_notes,
             vacancies, kb_suggestions, questionnaire_tokens, userbot_session,
             userbot_send_queue
    RESTART IDENTITY CASCADE
  `;
}
