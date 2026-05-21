-- Postgres Row-Level Security для multi-tenant изоляции. Defense-in-depth
-- поверх soft repo-level фильтрации: даже если bug в conversation-engine'е
-- обходит WHERE tenant_id = ?, RLS не пропустит чужие строки.
--
-- Модель:
--   1. ENABLE + FORCE RLS на всех tenant-scoped таблицах (force = даже
--      owner подчиняется policy; superuser bypass'ит через BYPASSRLS-role).
--   2. POLICY tenant_isolation: USING + WITH CHECK сравнивают tenant_id
--      колонку с current_setting('app.tenant_id', true)::int. Второй
--      аргумент `true` = missing_ok: если var не set, returns NULL →
--      сравнение всегда false → 0 видимых строк (fail-safe).
--   3. apps/api / apps/worker оборачивают каждый repo-call в transaction
--      с `SET LOCAL app.tenant_id = <id>` через withTenant helper.
--
-- НЕ покрыто этой миграцией:
--   - `tenants` (root): policy была бы `id = setting` — добавим в 0005
--     если admin-UI начнёт SELECT'ить tenants под per-tenant сессией.
--     Сейчас bootstrap apps/api/worker делает SELECT * tenants без
--     SET LOCAL, что упадёт если ENABLE RLS на tenants → откладываем.
--   - `channel_identities` (scoped через contact.tenant_id, нет direct
--     колонки): требует EXISTS JOIN — отдельная policy позже.
--   - `userbot_session`: single-row table, защищается id=1 CHECK. RLS
--     не нужен (одна row per tenant_id, если конфликт — попадание на
--     уровень pkey).
--
-- Bootstrap script (один раз перед deploy):
--   GRANT BYPASSRLS to migration-user (для drizzle-kit / pg_dump)
--   Otherwise admin-user без BYPASSRLS = miscarriage'нет миграции:
--     pg_dump упадёт без SET LOCAL app.tenant_id.

-- Список tenant-scoped таблиц с direct tenant_id колонкой.
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'users', 'questionnaire_tokens', 'styles', 'experiments',
    'conversations', 'messages', 'kb_documents', 'kb_chunks', 'admins',
    'app_settings', 'sessions', 'vacancies', 'leads', 'lead_events',
    'lead_notes', 'kb_suggestions', 'skills', 'style_skills',
    'skill_outcomes', 'style_ratings', 'self_play_matches',
    'pairwise_matches', 'coach_proposals', 'shadow_evaluations',
    'userbot_send_queue', 'userbot_delete_queue', 'audit_log',
    'tenant_secrets', 'channels', 'contacts', 'funnels',
    'outbound_queue', 'llm_provider_configs'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I ' ||
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::int) ' ||
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::int)',
      tbl
    );
  END LOOP;
END $$;--> statement-breakpoint

-- Миграция-runner (drizzle-kit migrate / psql) bypass'ает RLS — она работает
-- как owner. После прогона 0004 любой connection без SET LOCAL app.tenant_id
-- получает 0 строк из tenant-таблиц.
--
-- Если нужно сделать admin-доступ через специальный role (минуя RLS):
--   CREATE ROLE platform_admin BYPASSRLS;
--   GRANT platform_admin TO <admin-user>;
-- Apps/api/worker должны connect'иться под non-bypass role.
