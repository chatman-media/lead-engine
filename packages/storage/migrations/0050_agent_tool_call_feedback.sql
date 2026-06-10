-- 0050_agent_tool_call_feedback.sql
-- Human labels for agentic tool-call traces.

CREATE TABLE IF NOT EXISTS "agent_tool_call_feedback" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "tool_call_id" integer NOT NULL REFERENCES "agent_tool_calls"("id") ON DELETE cascade,
  "admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "label" text NOT NULL,
  "note" text,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "agent_tool_call_feedback_label_check"
    CHECK ("label" IN ('good_reply','wrong_tool','missing_tool','bad_args','other'))
);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_feedback_call"
  ON "agent_tool_call_feedback" ("tenant_id", "tool_call_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_feedback_label"
  ON "agent_tool_call_feedback" ("tenant_id", "label", "created_at" DESC);

ALTER TABLE "agent_tool_call_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_call_feedback" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'agent_tool_call_feedback'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "agent_tool_call_feedback"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
