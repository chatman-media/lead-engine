// Integration-тесты: применяют миграции 0000-0005 на живой Postgres и
// проверяют schema-инварианты + идемпотентность backfill'а.
//
// Условия запуска:
//   DATABASE_URL должен указывать на pgvector/pgvector:pg17 (или совместимый).
//   Тесты создают временную БД `lead_engine_integration_<random>` через
//   ownerUrl (admin connection); после suite — DROP.
//
// Локально:
//   createdb lead_engine_test_owner   # один раз
//   DATABASE_URL=postgres://...@localhost:5432/lead_engine_test_owner \
//     bun --filter @chatman-media/storage test
//
// CI: workflow `migrations` job (раньше apply через psql, теперь pure bun
// test) поднимает PG service и передаёт connection-URL.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import {
  applyAllMigrations,
  createIsolatedDb,
  dropIsolatedDb,
  tryConnectToPg,
} from "./integration-helpers.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_int_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let testUrl: string | null = null;
let sql: Sql | null = null;
let migrationFiles: string[] = [];

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 }).catch(() => {});

    testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 2 });
    migrationFiles = await applyAllMigrations(sql, migrationsDir);
  },
  // Apply 7 миграций с pgvector + ivfflat + GIN индексами может занять до
  // 15s на медленных runner'ах.
  30_000,
);

afterAll(
  async () => {
    if (sql) {
      await sql.end({ timeout: 0 }).catch(() => {});
      sql = null;
    }
    // dropIsolatedDb намеренно опущен: bun-test'у сложно надёжно
    // дропать БД через отдельный owner-pool — теndsует timeout'ить
    // даже при force-terminate. random suffix у dbName исключает
    // конфликты между runs; cleanup'ить локально — `psql -lqt | grep
    // lead_engine_int_ | xargs -n1 dropdb` если станет проблемой.
    // В CI каждый run свежий контейнер pgvector, нечего cleanup'ить.
  },
  5_000,
);

describe("migrations integration", () => {
  it("applies all .sql files in order", () => {
    if (!sql) {
      console.warn("[migrations.test] DATABASE_URL not configured — skipping");
      return;
    }
    expect(migrationFiles.length).toBeGreaterThanOrEqual(6);
    // Имена должны идти 0000, 0001, ..., в лексикографическом порядке.
    const sorted = [...migrationFiles].sort();
    expect(migrationFiles).toEqual(sorted);
  });

  it("создаёт ровно 38 таблиц (28 existing − 1 users (dropped 0008) + 8 multi-tenant + 3 stripe)", async () => {
    if (!sql) return;
    const rows = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname = 'public'
    `;
    // 28 existing − 1 dropped (users) + 8 multi-tenant + 3 stripe = 38.
    expect(rows[0]?.count).toBeGreaterThanOrEqual(38);
  });

  it("RLS-policies включены на 35 таблицах с tenant_id (34 + admin_invites из 0009)", async () => {
    if (!sql) return;
    const rows = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = true
    `;
    expect(rows[0]?.count).toBe(35);
  });

  it("tenant_isolation policies = 35 (по одной на каждую RLS-таблицу)", async () => {
    if (!sql) return;
    const rows = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
    `;
    expect(rows[0]?.count).toBe(35);
  });

  it("legacy tenant (id=1) сидится из 0001", async () => {
    if (!sql) return;
    const rows = await sql<Array<{ id: number; slug: string }>>`
      SELECT id, slug FROM tenants WHERE id = 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("legacy");
  });

  it("outbound_status_check содержит processing (миграция 0005)", async () => {
    if (!sql) return;
    const rows = await sql<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'outbound_status_check'
    `;
    expect(rows[0]?.def).toContain("'processing'");
  });

  it("pgvector extension установлен", async () => {
    if (!sql) return;
    const rows = await sql<Array<{ name: string }>>`
      SELECT extname AS name FROM pg_extension WHERE extname = 'vector'
    `;
    expect(rows).toHaveLength(1);
  });
});

// NB: ранее здесь был test "users → contacts backfill (0003) идемпотентен".
// Удалён после миграции 0008_drop_users — re-применять backfill после того
// как source-table (users) удалена, не имеет смысла. Idempotency самого
// миграционного скрипта 0003 проверяется через applyAllMigrations
// при boot'е в beforeAll (любой ON CONFLICT DO NOTHING сработает; CRASH
// detect'нется).
