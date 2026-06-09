-- 0050_shadow_eval_queue.sql
-- Durable DB-backed queue metadata for quality shadow evaluations.

ALTER TABLE "shadow_evaluations"
  ADD COLUMN IF NOT EXISTS "run_config_json" text,
  ADD COLUMN IF NOT EXISTS "claim_token" text,
  ADD COLUMN IF NOT EXISTS "claimed_at" integer,
  ADD COLUMN IF NOT EXISTS "lease_expires_at" integer,
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_shadow_evaluations_running_lease"
  ON "shadow_evaluations" ("tenant_id", "lease_expires_at", "started_at")
  WHERE "status" = 'running';
