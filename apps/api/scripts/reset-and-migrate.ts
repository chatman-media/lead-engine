#!/usr/bin/env bun
/**
 * Dev/test helper: применяет миграции на target БД.
 *
 * Без флагов — DROP SCHEMA + применить все миграции с нуля (деструктивно).
 * --keep-data  — применить только миграции, которые ещё не были запущены
 *               (проверяется по таблице _migrations; data не трогается).
 *
 * НЕ ИСПОЛЬЗОВАТЬ В PRODUCTION.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run apps/api/scripts/reset-and-migrate.ts
 *   DATABASE_URL=postgres://... bun run apps/api/scripts/reset-and-migrate.ts --keep-data
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL env required");
  process.exit(1);
}

const keepData = process.argv.includes("--keep-data");
const migrationsDir = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);

async function main() {
  const sql = postgres(databaseUrl as string, { max: 1, prepare: false });

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  if (!keepData) {
    console.log("[reset] dropping all public-schema objects");
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

    for (const file of files) {
      const body = readFileSync(join(migrationsDir, file), "utf-8");
      process.stdout.write(`[reset] → ${file}... `);
      try {
        await sql.unsafe(body);
        console.log("ok");
      } catch (err) {
        console.log("FAILED");
        console.error(err);
        await sql.end({ timeout: 0 });
        process.exit(1);
      }
    }
  } else {
    // Incremental mode: track applied migrations in _migrations table.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
    const appliedSet = new Set(applied.map((r) => r.name));

    // First run with tracking: if _migrations is empty but DB already has tables,
    // seed _migrations with all migrations that exist as files EXCEPT the last one,
    // so we only apply truly new ones. Detect by checking if 'admins' table exists.
    if (appliedSet.size === 0) {
      const [existing] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'admins'
        ) AS exists
      `;
      if (existing?.exists) {
        // Seed _migrations with all files that were presumably already applied.
        // We detect "already applied" by checking if the file's first CREATE TABLE
        // target exists. Simpler: mark everything before 0011 as applied.
        for (const f of files) {
          if (f < "0011_") {
            await sql`INSERT INTO _migrations (name) VALUES (${f}) ON CONFLICT DO NOTHING`;
            appliedSet.add(f);
          }
        }
        console.log(`[reset] seeded _migrations with ${appliedSet.size} pre-existing migrations`);
      }
    }

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[reset] → ${file}... already applied, skipping`);
        continue;
      }
      const body = readFileSync(join(migrationsDir, file), "utf-8");
      process.stdout.write(`[reset] → ${file}... `);
      try {
        await sql.unsafe(body);
        await sql`INSERT INTO _migrations (name) VALUES (${file})`;
        console.log("ok");
        count++;
      } catch (err) {
        console.log("FAILED");
        console.error(err);
        await sql.end({ timeout: 0 });
        process.exit(1);
      }
    }
    console.log(`[reset] done: applied ${count} new migration(s) (${files.length - count} already applied)`);
  }

  if (!keepData) {
    console.log(`[reset] done: applied ${files.length} migrations`);
  }

  await sql.end({ timeout: 0 });
}

main().catch((err) => {
  console.error("[reset] fatal", err);
  process.exit(1);
});
