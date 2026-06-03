-- 0025_exchange_rate_tiers.sql
-- Public exchange rate-card tiers with admin approval.

CREATE TABLE IF NOT EXISTS "exchange_rate_tiers" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "asset" text NOT NULL,
  "quote_asset" text NOT NULL DEFAULT 'THB',
  "network" text NOT NULL DEFAULT '',
  -- target_thb = ranges like "from 10k THB"; source_amount = ranges in asset source.
  "range_basis" text NOT NULL DEFAULT 'target_thb',
  "min_amount" double precision NOT NULL,
  "max_amount" double precision,
  -- Market rate at proposal time and approved public display rate.
  -- RUB uses RUB per 1 THB; USDT uses THB per 1 USDT.
  "market_rate" double precision NOT NULL,
  "display_rate" double precision NOT NULL,
  "deviation_pct" double precision NOT NULL,
  "formula_json" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "approved_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "approved_at" integer,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "exchange_rate_tiers_range_basis_check" CHECK ("range_basis" IN ('target_thb','source_amount'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exchange_rate_tier"
  ON "exchange_rate_tiers" ("tenant_id", "asset", "quote_asset", "network", "range_basis", "min_amount");
CREATE INDEX IF NOT EXISTS "idx_exchange_rate_tiers_active"
  ON "exchange_rate_tiers" ("tenant_id", "asset", "is_active");

ALTER TABLE "exchange_rate_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_rate_tiers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "exchange_rate_tiers";
CREATE POLICY tenant_isolation ON "exchange_rate_tiers"
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);
