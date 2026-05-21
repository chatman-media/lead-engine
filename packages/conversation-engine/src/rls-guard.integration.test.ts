// Integration-тест для checkRlsEnforcement. Проверяет:
//   - owner (superuser/BYPASSRLS) connection → isEnforced=false (warning)
//   - non-bypass role connection → isEnforced=true (production-like)

import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { checkRlsEnforcement } from "./rls-guard.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_rlsguard_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "storage",
  "migrations",
);
const appRoleName = `app_rls_guard_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-guard";

let ownerSql: Sql | null = null;
let appSql: Sql | null = null;
let ownerDb: PostgresJsDatabase<typeof schema>;
let appDb: PostgresJsDatabase<typeof schema>;

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 }).catch(() => {});

    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    ownerSql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(ownerSql, migrationsDir);
    ownerDb = drizzle(ownerSql, { schema });

    await ownerSql.unsafe(`
      CREATE ROLE "${appRoleName}" LOGIN PASSWORD '${appRolePass}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO "${appRoleName}";
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${appRoleName}";
    `);

    const parsed = new URL(testUrl);
    parsed.username = appRoleName;
    parsed.password = appRolePass;
    appSql = postgres(parsed.toString(), { max: 2, onnotice: () => {} });
    appDb = drizzle(appSql, { schema });
  },
  30_000,
);

afterAll(
  async () => {
    if (appSql) {
      await appSql.end({ timeout: 0 }).catch(() => {});
      appSql = null;
    }
    if (ownerSql) {
      await ownerSql
        .unsafe(`DROP OWNED BY "${appRoleName}"; DROP ROLE IF EXISTS "${appRoleName}"`)
        .catch(() => {});
      await ownerSql.end({ timeout: 0 }).catch(() => {});
      ownerSql = null;
    }
  },
  10_000,
);

describe("checkRlsEnforcement", () => {
  it("owner connection (superuser локально) → isEnforced=false", async () => {
    if (!ownerSql) return;
    const result = await checkRlsEnforcement(ownerDb);
    // На локальном dev current_user — superuser, в CI может быть просто
    // BYPASSRLS user. Любой из этих флагов → isEnforced=false.
    expect(result.isSuperuser || result.hasBypassRls).toBe(true);
    expect(result.isEnforced).toBe(false);
    expect(typeof result.role).toBe("string");
    expect(result.role.length).toBeGreaterThan(0);
  });

  it("non-superuser, NOBYPASSRLS connection → isEnforced=true", async () => {
    if (!appSql) return;
    const result = await checkRlsEnforcement(appDb);
    expect(result.isSuperuser).toBe(false);
    expect(result.hasBypassRls).toBe(false);
    expect(result.isEnforced).toBe(true);
    expect(result.role).toBe(appRoleName);
  });
});
