#!/usr/bin/env bun
/**
 * Fully resets the KB: documents, chunks, sqlite-vec index, FTS5 mirror.
 *
 * Why not plain `sqlite3 data/bot.db "DELETE …"`?
 * - The bundled `sqlite3` CLI has no sqlite-vec (`vec0`).
 * - `PRAGMA foreign_keys` defaults to OFF → deleting parents can orphan rows.
 * - Orphans + broken virtual tables yield `SQLITE_CORRUPT` / `CORRUPT_VTAB`.
 *
 * Strategy: drop FTS + triggers + `kb_vec`, delete base rows (with FK ON),
 * re-apply `005_kb_fts.sql`, recreate `kb_vec` with the configured dim.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { activeEmbeddingDim } from "../src/config.ts";
import { ensureKbVec } from "../src/db/ensure-kb-vec.ts";
import { openDb } from "../src/db/sqlite.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const db = openDb();

db.transaction(() => {
  db.exec(`DROP TRIGGER IF EXISTS kb_chunks_fts_au`);
  db.exec(`DROP TRIGGER IF EXISTS kb_chunks_fts_ad`);
  db.exec(`DROP TRIGGER IF EXISTS kb_chunks_fts_ai`);
  db.exec(`DROP TABLE IF EXISTS kb_chunks_fts`);
  db.exec(`DROP TABLE IF EXISTS kb_vec`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`DELETE FROM kb_chunks`);
  db.exec(`DELETE FROM kb_documents`);

  const ftsSql = readFileSync(resolve(scriptDir, "../migrations/005_kb_fts.sql"), "utf8");
  db.exec(ftsSql);
})();

ensureKbVec(db, activeEmbeddingDim());
console.log("[kb-wipe] cleared KB and rebuilt FTS + kb_vec scaffold");
