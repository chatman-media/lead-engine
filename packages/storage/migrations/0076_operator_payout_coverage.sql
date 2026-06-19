-- 0076_operator_payout_coverage.sql
-- Покрытие операторов по точкам выдачи: какой оператор может выдать через какую
-- точку (банкомат/офис/зону). Нужно для маршрутизации хэндоффа выдачи именно на
-- оператора, способного выдать через выбранный клиентом банкомат (B4b).
-- M:N между admins и exchange_payout_points в рамках тенанта.
-- RLS ENABLE+FORCE+tenant_isolation, как у прочих exchange-таблиц (см. 0022/0075).
-- Forward-only, идемпотентно.

CREATE TABLE IF NOT EXISTS "operator_payout_coverage" (
  "id"               serial PRIMARY KEY NOT NULL,
  "tenant_id"        integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "admin_id"         integer NOT NULL REFERENCES "admins"("id") ON DELETE cascade,
  "payout_point_id"  integer NOT NULL REFERENCES "exchange_payout_points"("id") ON DELETE cascade,
  "created_at"       integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_operator_payout_coverage"
  ON "operator_payout_coverage" ("tenant_id", "admin_id", "payout_point_id");
-- Поиск операторов по выбранной точке (горячий путь маршрутизации).
CREATE INDEX IF NOT EXISTS "idx_operator_payout_coverage_point"
  ON "operator_payout_coverage" ("tenant_id", "payout_point_id");
-- Обратный обход: какие точки закрывает оператор.
CREATE INDEX IF NOT EXISTS "idx_operator_payout_coverage_admin"
  ON "operator_payout_coverage" ("tenant_id", "admin_id");

-- ── RLS (ENABLE + FORCE + tenant_isolation), как в 0022/0075 ─────────────────
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY['operator_payout_coverage'];
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
