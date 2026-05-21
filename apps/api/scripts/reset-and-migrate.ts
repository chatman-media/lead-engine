#!/usr/bin/env bun
/**
 * Dev/test helper: применяет все миграции с нуля на target БД. DROP'ает
 * существующие public-таблицы (если есть), потом apply 0000…000N в
 * правильном порядке.
 *
 * НЕ ИСПОЛЬЗОВАТЬ В PRODUCTION — destruktivно. Для prod-deploy'я нужна
 * incremental migration с tracking-таблицей (__drizzle_migrations).
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run apps/api/scripts/reset-and-migrate.ts
 *
 * Опционально: --keep-data чтобы не дропать таблицы, только apply новых
 * миграций (полезно когда добавляешь .sql и хочешь test'нуть на dirty db).
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

  if (!keepData) {
    console.log("[reset] dropping all public-schema objects");
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } else {
    console.log("[reset] keeping existing data (--keep-data)");
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
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
  console.log(`[reset] done: applied ${files.length} migrations`);
  await sql.end({ timeout: 0 });
}

main().catch((err) => {
  console.error("[reset] fatal", err);
  process.exit(1);
});
