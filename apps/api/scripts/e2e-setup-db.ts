/**
 * Pretest для admin-ui e2e (Playwright): создаёт (drop-if-exists) и мигрирует
 * изолированную БД lead_engine_e2e, чтобы apps/api в e2e-webServer стартовал на
 * чистой схеме. Идемпотентен и детерминирован — каждый прогон с нуля.
 *
 * Лежит в apps/api/scripts (а не в admin-ui/e2e), потому что @chatman-media/storage
 * резолвится только из бэкенд-контекста (admin-ui его не объявляет в зависимостях).
 * Вызывается из `apps/admin-ui` через `bun run ../api/scripts/e2e-setup-db.ts`
 * (см. admin-ui package.json "test:e2e").
 *
 * Требует поднятый Postgres на :5434 (bun db:up).
 */

import { resolve } from "node:path";
import { applyAllMigrations, createIsolatedDb } from "@chatman-media/storage";
import postgres from "postgres";

const ownerUrl = process.env.E2E_PG_OWNER_URL ?? "postgres://lead:lead@localhost:5434/lead_engine";
const dbName = process.env.E2E_DB_NAME ?? "lead_engine_e2e";
const migrationsDir = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "storage",
  "migrations",
);

const url = await createIsolatedDb({ ownerUrl, testDbName: dbName });
const sql = postgres(url, { max: 2, onnotice: () => {} });
await applyAllMigrations(sql, migrationsDir);
await sql.end({ timeout: 1 });
console.log(`[e2e] DB ready: ${dbName} (migrated)`);
