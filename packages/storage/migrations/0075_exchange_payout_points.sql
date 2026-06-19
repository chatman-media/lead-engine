-- 0075_exchange_payout_points.sql
-- Каталог точек выдачи обменника (ATM / офис / зона курьера) — фундамент «ATM payout».
-- Структурная замена свободной строки exchange_orders.payout_location:
--   - denomination       — шаг номинала банкомата; выдача округляется ВНИЗ кратно ему.
--                          NULL → берётся дефолт настройки тенанта (exchange_settings, шаг B3).
--   - per_withdrawal_max — лимит одного cardless-снятия; сумма выше → дробится на несколько кодов (B3).
--   - fee_fixed/fee_pct  — комиссия выдачи (доставка/курьер).
--   - code_ttl_sec       — TTL кода/ваучера снятия.
--   - source/external_id — провенанс (manual|feed) и ключ апсерта для авто-обновления (фид, B2).
-- RLS ENABLE+FORCE+tenant_isolation, как у прочих exchange-таблиц (см. 0022).
-- Forward-only, идемпотентно (IF NOT EXISTS / DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS "exchange_payout_points" (
  "id"                  serial PRIMARY KEY NOT NULL,
  "tenant_id"           integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  -- atm | office | courier_zone
  "kind"                text NOT NULL,
  -- стабильный slug точки в рамках тенанта (ключ ручного апсерта)
  "code"                text NOT NULL,
  "label"               text NOT NULL,
  -- банк/провайдер банкомата (для kind='atm')
  "bank_name"           text,
  "provider"            text,
  -- валюта, которую выдаёт точка (обычно котируемая валюта тенанта)
  "quote_asset"         text NOT NULL DEFAULT 'PHP',
  -- шаг номинала банкомата: выдача округляется ВНИЗ кратно ему; NULL → дефолт настройки тенанта
  "denomination"        integer,
  -- лимит одного cardless-снятия; сумма выше → дробить на несколько кодов
  "per_withdrawal_max"  double precision,
  -- суточный лимит точки
  "daily_max"           double precision,
  -- комиссия выдачи (для курьера/доставки)
  "fee_fixed"           double precision NOT NULL DEFAULT 0,
  "fee_pct"             double precision NOT NULL DEFAULT 0,
  -- TTL кода/ваучера снятия (сек)
  "code_ttl_sec"        integer,
  -- гео/адрес точки
  "area"                text,
  "city"                text,
  "address"             text,
  "lat"                 double precision,
  "lng"                 double precision,
  "is_active"           boolean NOT NULL DEFAULT true,
  -- провенанс: manual (админка) | feed (авто-обновление)
  "source"              text NOT NULL DEFAULT 'manual',
  -- id точки в источнике/фиде — ключ апсерта при авто-обновлении
  "external_id"         text,
  "updated_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "synced_at"           integer,
  "created_at"          integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at"          integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "exchange_payout_points_kind_check" CHECK ("kind" IN ('atm','office','courier_zone')),
  CONSTRAINT "exchange_payout_points_source_check" CHECK ("source" IN ('manual','feed')),
  CONSTRAINT "exchange_payout_points_quote_asset_check" CHECK ("quote_asset" ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exchange_payout_points_code"
  ON "exchange_payout_points" ("tenant_id", "code");
-- Ключ апсерта фида: уникален только для записей с external_id (NULL'ы различны).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exchange_payout_points_external"
  ON "exchange_payout_points" ("tenant_id", "external_id") WHERE "external_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_exchange_payout_points_tenant_kind_active"
  ON "exchange_payout_points" ("tenant_id", "kind", "is_active");
CREATE INDEX IF NOT EXISTS "idx_exchange_payout_points_tenant_currency"
  ON "exchange_payout_points" ("tenant_id", "quote_asset", "is_active");

-- Связь заявки с точкой выдачи. Свободная payout_location остаётся для обратной совместимости.
ALTER TABLE "exchange_orders"
  ADD COLUMN IF NOT EXISTS "payout_point_id" integer REFERENCES "exchange_payout_points"("id") ON DELETE set null;

-- ── RLS (ENABLE + FORCE + tenant_isolation), как в 0022 ──────────────────────
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY['exchange_payout_points'];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', TRUE)::INTEGER) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', TRUE)::INTEGER)',
      tbl
    );
  END LOOP;
END $$;
