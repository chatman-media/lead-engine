#!/usr/bin/env bun
/**
 * Fully resets the KB: deletes all documents and chunks from the database.
 * Cascade delete handles the chunks when documents are removed.
 */
import { sql } from "../src/db/postgres.ts";

await sql`DELETE FROM kb_chunks`;
await sql`DELETE FROM kb_documents`;
console.log("[kb-wipe] cleared KB documents and chunks");
await sql.end();
