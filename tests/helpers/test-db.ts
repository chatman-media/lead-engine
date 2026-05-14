import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

export type TestSql = ReturnType<typeof postgres>;

export function getTestSql(): TestSql {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set for DB tests");
  // Each call creates a new isolated connection pool. Callers call sql.end()
  // in afterAll, which only closes their own pool — no cross-file interference.
  return postgres(url, { max: 3 });
}

export async function setupTestDb(sql: TestSql): Promise<void> {
  const schemaPath = resolve(import.meta.dir, "../../migrations/pg_schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  await sql.unsafe(schema);
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
             skill_outcomes, self_play_matches, pairwise_matches, coach_proposals,
             shadow_evaluations, leads, lead_events, lead_notes, vacancies,
             kb_suggestions, questionnaire_tokens, userbot_session
    RESTART IDENTITY CASCADE
  `;
}
