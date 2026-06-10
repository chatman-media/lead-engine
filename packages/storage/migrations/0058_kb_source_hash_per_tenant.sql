-- 0058_kb_source_hash_per_tenant.sql
-- uniq_kb_source_hash was (source, content_hash) without tenant_id, so two
-- tenants could not hold the same document (e.g. seeding two demo tenants
-- from the same kb-samples files collided). Scope the uniqueness per tenant.

DROP INDEX IF EXISTS "uniq_kb_source_hash";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_source_hash"
  ON "kb_documents" ("tenant_id", "source", "content_hash");
