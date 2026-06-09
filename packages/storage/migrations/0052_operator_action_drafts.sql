-- 0052_operator_action_drafts.sql
-- Durable preview/action state for reactive operator bot callbacks.

CREATE TABLE IF NOT EXISTS "operator_action_drafts" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "conversation_id" integer NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "draft_key" text NOT NULL,
  "chat_id" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'client_reply',
  "status" text NOT NULL DEFAULT 'pending',
  "text" text NOT NULL,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "message_id" integer REFERENCES "messages"("id") ON DELETE set null,
  "outbound_queue_id" integer REFERENCES "outbound_queue"("id") ON DELETE set null,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "expires_at" integer NOT NULL,
  "handled_at" integer,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "operator_action_drafts_kind_check"
    CHECK ("kind" IN ('client_reply')),
  CONSTRAINT "operator_action_drafts_status_check"
    CHECK ("status" IN ('pending','sent','cancelled','expired','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_operator_action_drafts_key"
  ON "operator_action_drafts" ("tenant_id", "draft_key");

CREATE INDEX IF NOT EXISTS "idx_operator_action_drafts_conversation"
  ON "operator_action_drafts" ("tenant_id", "conversation_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_operator_action_drafts_pending"
  ON "operator_action_drafts" ("tenant_id", "status", "expires_at")
  WHERE "status" = 'pending';

ALTER TABLE "operator_action_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operator_action_drafts" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'operator_action_drafts'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "operator_action_drafts"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
