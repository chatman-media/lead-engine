-- 0048_funnel_versions.sql
-- Immutable per-tenant snapshots for funnel version history and rollback.

CREATE TABLE IF NOT EXISTS "funnel_versions" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "funnel_id" integer NOT NULL REFERENCES "funnels"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "note" text,
  "stage_count" integer NOT NULL DEFAULT 0,
  "snapshot_json" text NOT NULL,
  "created_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "funnel_versions_source_check"
    CHECK ("source" IN ('ai_apply','seed','template_apply','rollback','manual','system'))
);

CREATE INDEX IF NOT EXISTS "idx_funnel_versions_funnel_created"
  ON "funnel_versions" ("funnel_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_funnel_versions_tenant_created"
  ON "funnel_versions" ("tenant_id", "created_at" DESC);

ALTER TABLE "funnel_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "funnel_versions" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'funnel_versions'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "funnel_versions"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
