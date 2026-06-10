-- 0049_provider_payment_ledger.sql
-- Brokered service-order payment intents/sessions and commission ledger.

CREATE TABLE IF NOT EXISTS "service_order_payments" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "order_id" integer NOT NULL REFERENCES "service_orders"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "external_intent_id" text,
  "external_session_id" text,
  "status" text NOT NULL DEFAULT 'created',
  "amount" double precision NOT NULL,
  "currency" text NOT NULL DEFAULT 'THB',
  "idempotency_key" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "paid_at" integer,
  "failed_at" integer,
  "cancelled_at" integer,
  "refunded_at" integer,
  CONSTRAINT "service_order_payments_status_check"
    CHECK ("status" IN ('created','pending','paid','failed','cancelled','refunded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_service_order_payments_idem"
  ON "service_order_payments" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_service_order_payments_provider_intent"
  ON "service_order_payments" ("tenant_id", "provider", "external_intent_id")
  WHERE "external_intent_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_service_order_payments_provider_session"
  ON "service_order_payments" ("tenant_id", "provider", "external_session_id")
  WHERE "external_session_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_service_order_payments_order"
  ON "service_order_payments" ("tenant_id", "order_id");
CREATE INDEX IF NOT EXISTS "idx_service_order_payments_status"
  ON "service_order_payments" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "service_order_commissions" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "order_id" integer NOT NULL REFERENCES "service_orders"("id") ON DELETE cascade,
  "provider_id" integer REFERENCES "provider_profiles"("id") ON DELETE set null,
  "payment_id" integer REFERENCES "service_order_payments"("id") ON DELETE set null,
  "status" text NOT NULL DEFAULT 'pending',
  "gross_amount" double precision NOT NULL,
  "commission_pct" double precision NOT NULL DEFAULT 0,
  "commission_amount" double precision NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'THB',
  "source" text NOT NULL DEFAULT 'payment',
  "idempotency_key" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "earned_at" integer,
  "refunded_at" integer,
  "paid_out_at" integer,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "service_order_commissions_status_check"
    CHECK ("status" IN ('pending','earned','void','refunded','paid_out'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_service_order_commissions_idem"
  ON "service_order_commissions" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_service_order_commissions_order"
  ON "service_order_commissions" ("tenant_id", "order_id");
CREATE INDEX IF NOT EXISTS "idx_service_order_commissions_provider"
  ON "service_order_commissions" ("tenant_id", "provider_id");
CREATE INDEX IF NOT EXISTS "idx_service_order_commissions_payment"
  ON "service_order_commissions" ("tenant_id", "payment_id");
CREATE INDEX IF NOT EXISTS "idx_service_order_commissions_status"
  ON "service_order_commissions" ("tenant_id", "status");

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'service_order_payments',
    'service_order_commissions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = tbl
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I ' ||
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::int) ' ||
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::int)',
        tbl
      );
    END IF;
  END LOOP;
END $$;
