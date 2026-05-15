// Exercise the dim-aware migrate path. The pre-existing setup function
// `setupTestDb` patches the schema to a small dim (8) for fast tests —
// here we use `runMigrations` directly to verify it:
//   1. Detects a dim drift on an existing kb_chunks
//   2. Drops + recreates at the new dim
//   3. No-ops when the dim already matches
//   4. Handles the first-install case (table doesn't exist yet) cleanly

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getKbChunksDim, runMigrations } from "@/db/migrate.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const sql = getTestSql();
// One test inserts into kb_chunks to verify wipe-on-recreate; that triggers
// the FTS GENERATED column (`to_tsvector('russian', …)`) which needs the
// snowball dict. pgvector/pgvector:pg16 (CI) has it; stock brew Postgres on
// macOS often doesn't. Probe + skip just that one case when missing.
let FTS_AVAILABLE = true;

beforeAll(async () => {
  await setupTestDb(sql, { embeddingDim: 8 });
  try {
    await sql`SELECT to_tsvector('russian', 'тест')`;
  } catch {
    FTS_AVAILABLE = false;
  }
});
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

describe("getKbChunksDim", () => {
  test("returns the column's vector dim", async () => {
    expect(await getKbChunksDim(sql)).toBe(8);
  });

  test("returns null when kb_chunks doesn't exist", async () => {
    await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
    expect(await getKbChunksDim(sql)).toBeNull();
    // Restore for the next test in the same file.
    await setupTestDb(sql, { embeddingDim: 8 });
  });
});

describe("runMigrations — dim aware", () => {
  test("no-op when target dim already matches", async () => {
    const result = await runMigrations(sql, { embeddingDim: 8 });
    expect(result.recreated).toBe(false);
    expect(result.previous_dim).toBe(8);
    expect(result.new_dim).toBe(8);
    // Dim unchanged.
    expect(await getKbChunksDim(sql)).toBe(8);
  });

  test("recreates kb_chunks at the new dim when target differs", async () => {
    // Pure dim-drift check — doesn't depend on FTS so runs anywhere.
    const result = await runMigrations(sql, { embeddingDim: 16 });

    expect(result.recreated).toBe(true);
    expect(result.previous_dim).toBe(8);
    expect(result.new_dim).toBe(16);
    expect(await getKbChunksDim(sql)).toBe(16);

    // Reset for downstream tests in the same file.
    await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
    await sql`DROP TABLE IF EXISTS kb_documents CASCADE`;
    await setupTestDb(sql, { embeddingDim: 8 });
  });

  test("wipes existing rows when forced to recreate at a new dim", async () => {
    if (!FTS_AVAILABLE) return; // dict_snowball needed for kb_chunks INSERT

    await sql`
      INSERT INTO kb_documents (source, title, content_hash)
      VALUES ('file://test.md', 'test', 'hash-1')
    `;
    const [doc] = await sql<
      { id: number }[]
    >`SELECT id FROM kb_documents WHERE source = 'file://test.md'`;
    await sql`
      INSERT INTO kb_chunks (document_id, chunk_index, text, token_count, embedding)
      VALUES (${doc!.id}, 0, 'chunk text', 2, '[1,0,0,0,0,0,0,0]'::vector)
    `;

    const result = await runMigrations(sql, { embeddingDim: 16 });
    expect(result.recreated).toBe(true);

    // chunks AND documents both wiped (kb_suggestions.kb_document_id FK
    // cleared by CASCADE — safe to re-ingest from scratch).
    const after = await sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM kb_chunks`;
    expect(after[0]?.n).toBe(0);
    const docs = await sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM kb_documents`;
    expect(docs[0]?.n).toBe(0);

    // Reset.
    await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
    await sql`DROP TABLE IF EXISTS kb_documents CASCADE`;
    await setupTestDb(sql, { embeddingDim: 8 });
  });

  test("first install (no kb_chunks yet) creates at target dim", async () => {
    // Pretend we're on a fresh DB. Drop kb_chunks and verify migrate creates
    // it back at the requested dim, with previous_dim reported as null.
    await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
    await sql`DROP TABLE IF EXISTS kb_documents CASCADE`;

    const result = await runMigrations(sql, { embeddingDim: 32 });

    expect(result.recreated).toBe(false); // nothing existed to recreate
    expect(result.previous_dim).toBeNull();
    expect(result.new_dim).toBe(32);
    expect(await getKbChunksDim(sql)).toBe(32);

    // Reset for any subsequent tests that expect the file-default dim of 8.
    await sql`DROP TABLE IF EXISTS kb_chunks CASCADE`;
    await sql`DROP TABLE IF EXISTS kb_documents CASCADE`;
    await setupTestDb(sql, { embeddingDim: 8 });
  });
});
