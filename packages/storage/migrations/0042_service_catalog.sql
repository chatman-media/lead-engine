-- 0042_service_catalog.sql
-- Tenant-scoped service catalog: customer-facing services route into funnels,
-- partner services, HTTP webhooks, or manual operator handling.

CREATE TABLE IF NOT EXISTS "service_catalog_items" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "category" text,
  "description" text,
  "route_type" text NOT NULL DEFAULT 'manual',
  "funnel_id" integer REFERENCES "funnels"("id") ON DELETE set null,
  "partner_service_id" integer REFERENCES "partner_services"("id") ON DELETE set null,
  "webhook_url" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "service_catalog_route_type_check"
    CHECK ("route_type" IN ('manual','funnel','partner_service','webhook'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_service_catalog_slug"
  ON "service_catalog_items" ("tenant_id", "slug");
CREATE INDEX IF NOT EXISTS "idx_service_catalog_tenant_active"
  ON "service_catalog_items" ("tenant_id", "is_active", "sort_order");
CREATE INDEX IF NOT EXISTS "idx_service_catalog_funnel"
  ON "service_catalog_items" ("tenant_id", "funnel_id");
CREATE INDEX IF NOT EXISTS "idx_service_catalog_partner_service"
  ON "service_catalog_items" ("tenant_id", "partner_service_id");

ALTER TABLE "service_catalog_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_catalog_items" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'service_catalog_items'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "service_catalog_items"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
