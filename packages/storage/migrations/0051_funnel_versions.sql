-- 0051_funnel_versions.sql
-- Immutable snapshots for funnel version history and rollback.

CREATE TABLE IF NOT EXISTS "funnel_versions" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "funnel_id" INTEGER NOT NULL REFERENCES "funnels"("id") ON DELETE CASCADE,
  "admin_id" INTEGER REFERENCES "admins"("id") ON DELETE SET NULL,
  "source" TEXT NOT NULL,
  "note" TEXT,
  "stage_count" INTEGER NOT NULL DEFAULT 0,
  "snapshot_json" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "funnel_versions_source_check"
    CHECK ("source" IN ('ai_apply','template_apply','manual_edit','rollback'))
);

CREATE INDEX IF NOT EXISTS "idx_funnel_versions_funnel_created"
  ON "funnel_versions" ("tenant_id", "funnel_id", "created_at" DESC);

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
      USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);
  END IF;
END $$;
