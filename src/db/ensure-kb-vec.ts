import type { Database } from "bun:sqlite";

/** Reads the configured dimension from the `kb_vec` virtual table SQL. */
export function getKbVecDim(db: Database): number | null {
  const row = db
    .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name = 'kb_vec'")
    .get();
  if (!row?.sql) return null;
  const match = /FLOAT\[(\d+)\]/i.exec(row.sql);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

export type EnsureAction = "noop" | "created" | "recreated";

/**
 * Ensures the `kb_vec` virtual table is created with `dim` floats. If a table
 * with a different dim already exists, it is dropped and recreated — chunks in
 * `kb_chunks` keep their text but lose their embeddings, so the caller MUST
 * re-ingest the knowledge base.
 */
export function ensureKbVec(db: Database, dim: number): EnsureAction {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`Invalid embedding dim: ${dim}`);
  }
  const current = getKbVecDim(db);
  if (current === dim) return "noop";
  const existed = current !== null;
  if (existed) {
    console.warn(
      `[kb_vec] dim changed ${current} -> ${dim}; dropping vector table. Re-ingest required.`,
    );
    db.exec("DROP TABLE kb_vec");
  }
  db.exec(
    `CREATE VIRTUAL TABLE kb_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`,
  );
  return existed ? "recreated" : "created";
}
