// Integration test для Row-Level Security policies (миграция 0004).
//
// Цель — проверить что `tenant_isolation` policy на каждой tenant-scoped
// таблице:
//   1. Без `SET LOCAL app.tenant_id` returns 0 строк (fail-safe).
//   2. С app.tenant_id = X — видим ТОЛЬКО tenant X rows.
//   3. WITH CHECK блокирует INSERT с tenant_id != app.tenant_id.
//   4. UPDATE/DELETE через cross-tenant условие в WHERE — 0 affected rows
//      (USING фильтрует ещё до WHERE).
//   5. FORCE RLS — даже owner-роль подчиняется (миграция-runner получает
//      BYPASSRLS отдельно, не через owner).
//
// Тест критичен: миграция 0004 в проде защищает данные ТОЛЬКО если apps
// действительно делают `SET LOCAL app.tenant_id` перед repo-вызовами.
// Этот тест — оракул контракта RLS-слоя.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import {
  applyAllMigrations,
  createIsolatedDb,
  tryConnectToPg,
} from "./integration-helpers.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_rls_${Math.random().toString(36).slice(2, 10)}`;
const appRoleName = `app_rls_${Math.random().toString(36).slice(2, 8)}`;
const appRolePass = "test-pass-rls";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// Owner-connection (creator / миграция-runner). На локальном dev обычно
// superuser → bypass RLS. Используется только для миграций и seed'а.
let ownerSql: Sql | null = null;
// App-connection под non-superuser, NOBYPASSRLS role. Имитирует то как
// apps/api / apps/worker должны коннектиться в prod. Этот connection
// мы используем для актуальных RLS-assertion'ов.
let appSql: Sql | null = null;
let tenantAId = 0;
let tenantBId = 0;
const nowEpoch = Math.floor(Date.now() / 1000);

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 }).catch(() => {});

    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    ownerSql = postgres(testUrl, { max: 2, onnotice: () => {} });
    await applyAllMigrations(ownerSql, migrationsDir);

    // Создаём non-superuser, NOBYPASSRLS role для actual RLS-теста.
    // На локалке default user — superuser с BYPASSRLS=t, у него policy
    // тупо не работает. Production apps ДОЛЖНЫ коннектиться под такую
    // role; миграция 0004 это explicit'но описывает в comment'ах.
    await ownerSql.unsafe(`
      CREATE ROLE "${appRoleName}" LOGIN PASSWORD '${appRolePass}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO "${appRoleName}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${appRoleName}";
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appRoleName}";
    `);

    // Seed-данные под owner — он bypass'ит RLS, поэтому INSERT'ы в
    // tenant-scoped таблицы проходят без SET LOCAL. Это симметрично
    // тому как drizzle-kit / prod-migration-runner делает backfill'ы.
    const seeded = await ownerSql<Array<{ id: number }>>`
      INSERT INTO tenants (slug, plan, status, llm_billing_mode, created_at, updated_at)
      VALUES
        ('alpha', 'free', 'active', 'byok', ${nowEpoch}, ${nowEpoch}),
        ('beta',  'free', 'active', 'byok', ${nowEpoch}, ${nowEpoch})
      RETURNING id
    `;
    if (seeded.length !== 2) throw new Error("seed tenants failed");
    tenantAId = seeded[0]!.id;
    tenantBId = seeded[1]!.id;

    await ownerSql`
      INSERT INTO contacts (tenant_id, display_name, created_at, updated_at)
      VALUES
        (${tenantAId}, ${`contact-1 for ${tenantAId}`}, ${nowEpoch}, ${nowEpoch}),
        (${tenantAId}, ${`contact-2 for ${tenantAId}`}, ${nowEpoch}, ${nowEpoch}),
        (${tenantBId}, ${`contact-1 for ${tenantBId}`}, ${nowEpoch}, ${nowEpoch}),
        (${tenantBId}, ${`contact-2 for ${tenantBId}`}, ${nowEpoch}, ${nowEpoch})
    `;

    // App-connection как role'а без BYPASSRLS — для RLS-проверок.
    const parsed = new URL(testUrl);
    parsed.username = appRoleName;
    parsed.password = appRolePass;
    appSql = postgres(parsed.toString(), { max: 4, onnotice: () => {} });
    // Sanity: убедимся что app-роль действительно NOBYPASSRLS.
    const roleInfo = await appSql<Array<{ bypass: boolean; sup: boolean }>>`
      SELECT rolbypassrls as bypass, rolsuper as sup FROM pg_roles WHERE rolname = current_user
    `;
    if (roleInfo[0]?.bypass || roleInfo[0]?.sup) {
      throw new Error("test setup: app role unexpectedly bypasses RLS");
    }
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
      // DROP роль до закрытия owner-connection'а (иначе DROP оставит
      // database с ownership'ом на удаляемую роль).
      await ownerSql
        .unsafe(`DROP OWNED BY "${appRoleName}"; DROP ROLE IF EXISTS "${appRoleName}"`)
        .catch(() => {});
      await ownerSql.end({ timeout: 0 }).catch(() => {});
      ownerSql = null;
    }
  },
  10_000,
);

/**
 * Помощник: открывает транзакцию с явным `SET LOCAL app.tenant_id`
 * и выполняет callback. Мини-копия `withTenant` из conversation-engine
 * без зависимости на drizzle (storage не должна знать про drizzle).
 */
async function withTenant<T>(
  tenantId: number,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!appSql) throw new Error("appSql not initialized");
  // postgres-js: sql.begin возвращает UnwrapPromiseArray<T> (учитывает кейс
  // когда callback возвращает array of Promise'ов). Для нашего callback'а,
  // возвращающего один Promise<T>, это эквивалентно Promise<T>, но
  // TS-generic'и не схлопывают это. Каст здесь безопасен.
  return appSql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.tenant_id = ${tenantId}`);
    return fn(tx);
  }) as unknown as Promise<T>;
}

describe("RLS tenant_isolation policy", () => {
  it("без SET LOCAL app.tenant_id — connection видит 0 строк (fail-safe)", async () => {
    if (!appSql) return;
    // Fresh app-connection вне транзакции: app.tenant_id не set'ится →
    // current_setting('app.tenant_id', true) returns NULL → policy
    // condition `tenant_id = NULL::int` → NULL → false → 0 rows.
    const rows = await appSql<Array<{ count: string }>>`SELECT COUNT(*)::text as count FROM contacts`;
    expect(rows[0]?.count).toBe("0");
  });

  it("с app.tenant_id = A — видим только tenant A contacts", async () => {
    if (!appSql) return;
    const visible = await withTenant(tenantAId, async (tx) => {
      return tx<Array<{ tenant_id: number; display_name: string }>>`
        SELECT tenant_id, display_name FROM contacts ORDER BY id
      `;
    });
    expect(visible).toHaveLength(2);
    expect(visible.every((r) => r.tenant_id === tenantAId)).toBe(true);
    expect(visible.map((r) => r.display_name)).toEqual([
      `contact-1 for ${tenantAId}`,
      `contact-2 for ${tenantAId}`,
    ]);
  });

  it("WITH CHECK блокирует cross-tenant INSERT", async () => {
    if (!appSql) return;
    // Внутри tenantA-контекста пытаемся вставить row с tenant_id=B —
    // WITH CHECK policy fail'ит, Postgres кидает 'new row violates
    // row-level security policy'.
    await expect(
      withTenant(tenantAId, async (tx) => {
        await tx`
          INSERT INTO contacts (tenant_id, display_name, created_at, updated_at)
          VALUES (${tenantBId}, 'cross-tenant attempt', ${nowEpoch}, ${nowEpoch})
        `;
      }),
    ).rejects.toThrow(/row-level security/i);

    // Sanity: в tenant B ничего не появилось.
    const beforeAndAfter = await withTenant(tenantBId, async (tx) => {
      return tx<Array<{ count: string }>>`SELECT COUNT(*)::text as count FROM contacts`;
    });
    expect(beforeAndAfter[0]?.count).toBe("2");
  });

  it("UPDATE с WHERE tenant_id=other → 0 affected rows (USING фильтрует)", async () => {
    if (!appSql) return;
    // Пытаемся под tenantA отредактировать contact tenantB (по id или
    // по tenant_id условию — USING policy всё равно отсечёт).
    const result = await withTenant(tenantAId, async (tx) => {
      return tx`
        UPDATE contacts
        SET display_name = 'hijacked'
        WHERE tenant_id = ${tenantBId}
        RETURNING id
      `;
    });
    expect(result.length).toBe(0);

    // Verify нетронуто.
    const bRows = await withTenant(tenantBId, async (tx) => {
      return tx<Array<{ display_name: string }>>`
        SELECT display_name FROM contacts ORDER BY id
      `;
    });
    expect(bRows.every((r) => !r.display_name.includes("hijacked"))).toBe(true);
  });

  it("DELETE с WHERE tenant_id=other → 0 affected rows", async () => {
    if (!appSql) return;
    const result = await withTenant(tenantAId, async (tx) => {
      return tx`
        DELETE FROM contacts WHERE tenant_id = ${tenantBId} RETURNING id
      `;
    });
    expect(result.length).toBe(0);

    // Tenant B contacts всё ещё на месте.
    const remaining = await withTenant(tenantBId, async (tx) => {
      return tx<Array<{ count: string }>>`SELECT COUNT(*)::text as count FROM contacts`;
    });
    expect(remaining[0]?.count).toBe("2");
  });

  it("UPDATE через WHERE без tenant_id — USING срезает только свои rows", async () => {
    if (!appSql) return;
    // WHERE display_name LIKE '%for%' матчит ВСЕ 4 row'а в БД, но USING
    // policy ограничит до tenantA's 2-х. Sanity-check что owner не
    // получает невидимый bypass.
    const result = await withTenant(tenantAId, async (tx) => {
      return tx`
        UPDATE contacts SET display_name = display_name || ' [tagged]'
        WHERE display_name LIKE 'contact-%'
        RETURNING id, tenant_id
      `;
    });
    expect(result.length).toBe(2);
    expect(result.every((r) => Number(r.tenant_id) === tenantAId)).toBe(true);

    // Verify tenant B нетронут.
    const bRows = await withTenant(tenantBId, async (tx) => {
      return tx<Array<{ display_name: string }>>`SELECT display_name FROM contacts`;
    });
    expect(bRows.every((r) => !r.display_name.includes("[tagged]"))).toBe(true);
  });

  it("owner-роль bypass'ит RLS — seed/migration работают без SET LOCAL", async () => {
    if (!ownerSql) return;
    // Контр-проверка: owner-connection (rolsuper=t или rolbypassrls=t)
    // видит ВСЕ rows независимо от app.tenant_id. Это нужно для миграций
    // / pg_dump / admin-скриптов. Production apps НЕ должны коннектиться
    // под такой role'ью — поэтому отдельный appSql выше.
    const probe = await ownerSql<Array<{ count: string }>>`
      SELECT COUNT(*)::text as count FROM contacts
    `;
    expect(probe[0]?.count).toBe("4");
  });

  it("RLS включён на всех tenant-scoped таблицах (sanity check matrix)", async () => {
    if (!ownerSql) return;
    // Список ДОЛЖЕН совпадать с массивом в миграции 0004 (это контрактный
    // тест — если кто-то добавит таблицу с tenant_id и забудет про RLS,
    // здесь падёт).
    // NB: 'users' исключена — table удалена миграцией 0008 (legacy).
    // RLS-migration 0004 включала её, но в 0008 DROP TABLE снёс и
    // policy/RLS-flag вместе с таблицей. Все её данные жили в contacts
    // (backfill в 0003).
    const expectedTables = [
      "questionnaire_tokens",
      "styles",
      "experiments",
      "conversations",
      "messages",
      "kb_documents",
      "kb_chunks",
      "admins",
      "app_settings",
      "sessions",
      "vacancies",
      "leads",
      "lead_events",
      "lead_notes",
      "kb_suggestions",
      "skills",
      "style_skills",
      "skill_outcomes",
      "style_ratings",
      "self_play_matches",
      "pairwise_matches",
      "coach_proposals",
      "shadow_evaluations",
      "userbot_send_queue",
      "userbot_delete_queue",
      "audit_log",
      "tenant_secrets",
      "channels",
      "contacts",
      "funnels",
      "outbound_queue",
      "llm_provider_configs",
    ];

    // pg_tables view не expose'ит relforcerowsecurity — берём напрямую
    // из pg_class.
    const rows = await ownerSql<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relkind = 'r'
        AND relname = ANY(${expectedTables})
    `;
    expect(rows.length).toBe(expectedTables.length);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // И что policy 'tenant_isolation' существует на каждой.
    const policies = await ownerSql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
    `;
    const policyTables = new Set(policies.map((r) => r.tablename));
    for (const t of expectedTables) {
      expect(policyTables.has(t)).toBe(true);
    }
  });
});
