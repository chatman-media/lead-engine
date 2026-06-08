-- 0041_partner_billing.sql
-- Partner services + operator-driven commission ledger.

CREATE TABLE IF NOT EXISTS "partners" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "contact_name" text,
  "contact_channel" text,
  "contact_value" text,
  "default_commission_pct" double precision NOT NULL DEFAULT 0,
  "settlement_currency" text NOT NULL DEFAULT 'THB',
  "notes" text,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "partners_status_check" CHECK ("status" IN ('active','archived'))
);

CREATE INDEX IF NOT EXISTS "idx_partners_tenant_status"
  ON "partners" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "partner_services" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "partner_id" integer NOT NULL REFERENCES "partners"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "category" text,
  "funnel_id" integer REFERENCES "funnels"("id") ON DELETE set null,
  "stage_definition_id" integer REFERENCES "stage_definitions"("id") ON DELETE set null,
  "commission_pct" double precision NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "notes" text,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_partner_services_name"
  ON "partner_services" ("tenant_id", "partner_id", "name");
CREATE INDEX IF NOT EXISTS "idx_partner_services_tenant_active"
  ON "partner_services" ("tenant_id", "is_active");
CREATE INDEX IF NOT EXISTS "idx_partner_services_stage"
  ON "partner_services" ("tenant_id", "stage_definition_id");

CREATE TABLE IF NOT EXISTS "partner_deals" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "partner_id" integer REFERENCES "partners"("id") ON DELETE set null,
  "service_id" integer REFERENCES "partner_services"("id") ON DELETE set null,
  "lead_id" integer REFERENCES "leads"("id") ON DELETE set null,
  "stage_definition_id" integer REFERENCES "stage_definitions"("id") ON DELETE set null,
  "status" text NOT NULL DEFAULT 'sent',
  "handoff_url" text,
  "handoff_mode" text NOT NULL DEFAULT 'fire_and_forget',
  "gross_amount" double precision,
  "currency" text NOT NULL DEFAULT 'THB',
  "commission_pct" double precision NOT NULL DEFAULT 0,
  "commission_amount" double precision,
  "proof_json" text,
  "notes" text,
  "sent_at" integer,
  "accepted_at" integer,
  "completed_at" integer,
  "cancelled_at" integer,
  "settled_at" integer,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "partner_deals_status_check" CHECK ("status" IN ('sent','accepted','rejected','completed','cancelled','disputed','settled')),
  CONSTRAINT "partner_deals_mode_check" CHECK ("handoff_mode" IN ('fire_and_forget','await_callback'))
);

CREATE INDEX IF NOT EXISTS "idx_partner_deals_tenant_status"
  ON "partner_deals" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_partner_deals_partner"
  ON "partner_deals" ("tenant_id", "partner_id");
CREATE INDEX IF NOT EXISTS "idx_partner_deals_lead"
  ON "partner_deals" ("tenant_id", "lead_id");

CREATE TABLE IF NOT EXISTS "partner_settlements" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "partner_id" integer NOT NULL REFERENCES "partners"("id") ON DELETE cascade,
  "period_start" integer NOT NULL,
  "period_end" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "total_gross" double precision NOT NULL DEFAULT 0,
  "total_commission" double precision NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'THB',
  "paid_at" integer,
  "notes" text,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "partner_settlements_status_check" CHECK ("status" IN ('draft','issued','paid','cancelled'))
);

CREATE INDEX IF NOT EXISTS "idx_partner_settlements_partner"
  ON "partner_settlements" ("tenant_id", "partner_id", "period_start");

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'partners',
    'partner_services',
    'partner_deals',
    'partner_settlements'
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
END $$;
