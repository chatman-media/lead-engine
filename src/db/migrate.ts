import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "./postgres.ts";

export async function runMigrations() {
  const schemaPath = resolve(import.meta.dir, "../../migrations/pg_schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  await sql.unsafe(schema);
  console.log("[migrate] PostgreSQL schema applied");
}
