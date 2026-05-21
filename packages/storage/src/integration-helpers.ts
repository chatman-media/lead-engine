// Helpers для integration-тестов поверх живого Postgres'а. НЕ используются
// в production runtime — apps/api/worker подключаются через свои db.ts
// фабрики.
//
// CI поднимает pgvector/pgvector:pg17 в services и экспортирует
// DATABASE_URL=postgres://postgres:postgres@localhost:5432/... — этого
// достаточно. Локально dev/main-разработчики могут использовать
// `pg_isready` + `createdb <name>` (см. README).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";

/**
 * Открывает connection к Postgres'у и проверяет что он отвечает. Если
 * DATABASE_URL не задан или connection падает — возвращает null. Tests
 * вызывают это и if-null'ят весь suite (skip).
 */
export async function tryConnectToPg(databaseUrl: string | undefined): Promise<Sql | null> {
  if (!databaseUrl) return null;
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5 });
  try {
    await sql`SELECT 1`;
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    return null;
  }
}

/**
 * Создаёт чистую тестовую БД (DROP IF EXISTS + CREATE), возвращает её
 * connection-URL. Owner connection используется только для CREATE/DROP;
 * dedicated connection для самих тестов опен'тся через returned URL.
 */
export async function createIsolatedDb(opts: {
  ownerUrl: string;
  testDbName: string;
}): Promise<string> {
  const owner = postgres(opts.ownerUrl, { max: 1 });
  try {
    // Force-disconnect existing connections к target БД.
    await owner.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
        `WHERE datname = '${opts.testDbName}' AND pid <> pg_backend_pid()`,
    );
    await owner.unsafe(`DROP DATABASE IF EXISTS "${opts.testDbName}"`);
    await owner.unsafe(`CREATE DATABASE "${opts.testDbName}"`);
  } finally {
    await owner.end({ timeout: 5 });
  }
  // Derive URL для test-БД из ownerUrl: подменяем path-сегмент.
  const url = new URL(opts.ownerUrl);
  url.pathname = `/${opts.testDbName}`;
  return url.toString();
}

export async function dropIsolatedDb(opts: { ownerUrl: string; testDbName: string }): Promise<void> {
  const owner = postgres(opts.ownerUrl, { max: 1 });
  try {
    await owner.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
        `WHERE datname = '${opts.testDbName}' AND pid <> pg_backend_pid()`,
    );
    await owner.unsafe(`DROP DATABASE IF EXISTS "${opts.testDbName}"`);
  } finally {
    await owner.end({ timeout: 5 });
  }
}

/**
 * Применяет все .sql миграции из packages/storage/migrations/ к connection
 * в правильном порядке (0000, 0001, ...).
 */
export async function applyAllMigrations(sql: Sql, migrationsDir: string): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), "utf-8");
    await sql.unsafe(body);
  }
  return files;
}
