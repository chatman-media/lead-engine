-- 0036_admin_informer.sql
-- (перенумеровано с 0032 — был дубль номера с 0032_leads_request_type.sql, из-за
--  чего tracking-раннер reset-and-migrate засеивал его как «applied» без запуска,
--  и informer_* колонки не создавались → UI информера не сохранял настройки.)
-- Бот-информер владельца тенанта: регулируемая «громкость» уведомлений
-- (порог важности + подписки по темам), доставка реалтайм + дайджест, лента
-- истории. Слой поверх существующего operator-бота (PLATFORM_OPERATOR_BOT_TOKEN).
-- Источник истины семантики — packages/conversation-engine/src/admin-informer.ts.
--
-- RLS: НЕ навешиваем — как и operator_settings/notification_rules (0019).
-- admin_notifications читается из operator-bot webhook (/last) без tenant-
-- контекста (бот резолвит admin по telegram_chat_id кросс-тенантно), FORCE RLS
-- вернул бы 0 строк. Изоляция — явным WHERE tenant_id = ? во всех запросах репо.

-- ── 1. Настройки информера на operator_settings (per-admin; владелец = superadmin)

ALTER TABLE "operator_settings"
  ADD COLUMN IF NOT EXISTS "informer_level"        TEXT    NOT NULL DEFAULT 'important',
  -- JSON-карта тоглов тем, как condition_json: {"leads":true,"orders":false,...}.
  -- NULL = все темы включены (дефолт).
  ADD COLUMN IF NOT EXISTS "informer_topics"       TEXT,
  ADD COLUMN IF NOT EXISTS "informer_digest"       TEXT    NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS "informer_digest_hour"  INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS "informer_tz"           TEXT    NOT NULL DEFAULT 'UTC',
  -- epoch; пока now() < muted_until — реалтайм гасится (события всё равно копятся в дайджест).
  ADD COLUMN IF NOT EXISTS "informer_muted_until"  INTEGER,
  -- epoch последней отправленной сводки (анти-повтор дайджеста).
  ADD COLUMN IF NOT EXISTS "informer_last_digest_at" INTEGER;

ALTER TABLE "operator_settings"
  DROP CONSTRAINT IF EXISTS "operator_settings_informer_level_check";
ALTER TABLE "operator_settings"
  ADD CONSTRAINT "operator_settings_informer_level_check"
  CHECK ("informer_level" IN ('silent', 'critical', 'important', 'all'));

ALTER TABLE "operator_settings"
  DROP CONSTRAINT IF EXISTS "operator_settings_informer_digest_check";
ALTER TABLE "operator_settings"
  ADD CONSTRAINT "operator_settings_informer_digest_check"
  CHECK ("informer_digest" IN ('off', 'daily', 'shift'));

-- ── 2. Лента уведомлений — источник дайджеста + scrollback («/last») + persisted-дедуп

CREATE TABLE IF NOT EXISTS "admin_notifications" (
  "id"              serial PRIMARY KEY NOT NULL,
  "tenant_id"       integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  -- Адресат-владелец. SET NULL при удалении админа — строку истории сохраняем.
  "admin_id"        integer REFERENCES "admins"("id") ON DELETE SET NULL,
  "topic"           text NOT NULL,                 -- leads | escalation | orders | system
  "severity"        text NOT NULL,                 -- critical | important | info
  "kind"            text NOT NULL,                 -- исходный тип (order_stuck, stage_changed, ...)
  "title"           text NOT NULL,
  "body"            text NOT NULL DEFAULT '',
  "dedup_key"       text NOT NULL,
  "target_chat_id"  text,                          -- куда ушло / ушло бы
  -- epoch реалтайм-доставки; NULL = в реалтайм не слали (ждёт дайджеста).
  "delivered_at"    integer,
  -- epoch батча дайджеста, в который вошло; NULL = ещё не сведено.
  "digest_batch_id" integer,
  "read_at"         integer,                       -- отметка прочтения (UI/бот)
  "created_at"      integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

ALTER TABLE "admin_notifications"
  DROP CONSTRAINT IF EXISTS "admin_notifications_topic_check";
ALTER TABLE "admin_notifications"
  ADD CONSTRAINT "admin_notifications_topic_check"
  CHECK ("topic" IN ('leads', 'escalation', 'orders', 'system'));

ALTER TABLE "admin_notifications"
  DROP CONSTRAINT IF EXISTS "admin_notifications_severity_check";
ALTER TABLE "admin_notifications"
  ADD CONSTRAINT "admin_notifications_severity_check"
  CHECK ("severity" IN ('critical', 'important', 'info'));

CREATE INDEX IF NOT EXISTS "idx_admin_notif_tenant_admin_created"
  ON "admin_notifications" ("tenant_id", "admin_id", "created_at" DESC);
-- Persisted-дедуп: последняя строка по (tenant, dedup_key).
CREATE INDEX IF NOT EXISTS "idx_admin_notif_dedup"
  ON "admin_notifications" ("tenant_id", "dedup_key", "created_at" DESC);
-- Очередь дайджеста: принято, в реалтайм не доставлено, ещё не сведено.
CREATE INDEX IF NOT EXISTS "idx_admin_notif_pending_digest"
  ON "admin_notifications" ("tenant_id", "created_at")
  WHERE "delivered_at" IS NULL AND "digest_batch_id" IS NULL;
