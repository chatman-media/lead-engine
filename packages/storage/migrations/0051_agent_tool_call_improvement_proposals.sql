-- 0051_agent_tool_call_improvement_proposals.sql
-- Persist workflow state for tool-call feedback improvement proposals.

CREATE TABLE IF NOT EXISTS "agent_tool_call_improvement_proposals" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "fingerprint" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "severity" text NOT NULL,
  "title" text NOT NULL,
  "tool_name" text NOT NULL,
  "source" text NOT NULL,
  "label" text NOT NULL,
  "summary" text NOT NULL,
  "rationale_json" text NOT NULL DEFAULT '[]',
  "action_items_json" text NOT NULL DEFAULT '[]',
  "examples_json" text NOT NULL DEFAULT '[]',
  "feedback_count" integer NOT NULL DEFAULT 0,
  "error_count" integer NOT NULL DEFAULT 0,
  "last_feedback_at" integer,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "decided_at" integer,
  "decided_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  CONSTRAINT "agent_tool_call_improvement_kind_check"
    CHECK ("kind" IN ('schema_fix','routing_prompt_fix','tool_candidate')),
  CONSTRAINT "agent_tool_call_improvement_status_check"
    CHECK ("status" IN ('pending','applied','dismissed')),
  CONSTRAINT "agent_tool_call_improvement_severity_check"
    CHECK ("severity" IN ('high','medium','low')),
  CONSTRAINT "agent_tool_call_improvement_source_check"
    CHECK ("source" IN ('rag_reply','llm_reply','admin_sim','self_play')),
  CONSTRAINT "agent_tool_call_improvement_label_check"
    CHECK ("label" IN ('wrong_tool','missing_tool','bad_args'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_agent_tool_call_improvement_fingerprint"
  ON "agent_tool_call_improvement_proposals" ("tenant_id", "fingerprint");

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_improvement_status"
  ON "agent_tool_call_improvement_proposals" ("tenant_id", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_improvement_tool"
  ON "agent_tool_call_improvement_proposals" ("tenant_id", "tool_name", "updated_at" DESC);

ALTER TABLE "agent_tool_call_improvement_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_call_improvement_proposals" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'agent_tool_call_improvement_proposals'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "agent_tool_call_improvement_proposals"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
