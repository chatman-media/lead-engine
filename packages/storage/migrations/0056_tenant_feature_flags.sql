-- 0056_tenant_feature_flags.sql
-- Per-tenant rollout flags for gated product surfaces.

CREATE TABLE IF NOT EXISTS "tenant_feature_flags" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "feature_key" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::int,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::int
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tenant_feature_flags_key"
  ON "tenant_feature_flags" ("tenant_id", "feature_key");

CREATE INDEX IF NOT EXISTS "idx_tenant_feature_flags_enabled"
  ON "tenant_feature_flags" ("tenant_id", "enabled");

ALTER TABLE "tenant_feature_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_feature_flags" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "tenant_feature_flags";
CREATE POLICY tenant_isolation ON "tenant_feature_flags"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::int)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::int);
