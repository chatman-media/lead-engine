import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../migrations");

function isDuplicateColumnError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("duplicate column name");
}

export function runMigrations(db: Database, dir: string = MIGRATIONS_DIR) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const applied = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM _migrations")
      .all()
      .map((r) => r.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    let schemaAlreadyMatched = false;
    try {
      db.exec(sql);
    } catch (e) {
      // ALTER ADD COLUMN fails if someone applied the DDL out-of-band or the
      // DB drifted vs `_migrations`. Record the migration so newer files can run.
      if (!isDuplicateColumnError(e)) throw e;
      schemaAlreadyMatched = true;
    }
    db.transaction(() => {
      db.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    })();
    console.log(
      schemaAlreadyMatched
        ? `[migrate] marked ${file} (schema already had change)`
        : `[migrate] applied ${file}`,
    );
  }
}
