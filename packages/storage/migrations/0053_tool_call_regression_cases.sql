-- 0053_tool_call_regression_cases.sql
-- Persist regression cases promoted from applied tool-call improvement proposals.

CREATE TABLE IF NOT EXISTS "agent_tool_call_regression_cases" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "proposal_id" integer REFERENCES "agent_tool_call_improvement_proposals"("id") ON DELETE set null,
  "tool_call_id" integer REFERENCES "agent_tool_calls"("id") ON DELETE set null,
  "source" text NOT NULL DEFAULT 'tool_call_feedback',
  "tool_name" text NOT NULL,
  "label" text NOT NULL,
  "title" text NOT NULL,
  "input_json" text NOT NULL DEFAULT '{}',
  "expected_json" text NOT NULL DEFAULT '{}',
  "context_json" text NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'active',
  "created_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "agent_tool_call_regression_source_check"
    CHECK ("source" IN ('tool_call_feedback')),
  CONSTRAINT "agent_tool_call_regression_label_check"
    CHECK ("label" IN ('wrong_tool','missing_tool','bad_args')),
  CONSTRAINT "agent_tool_call_regression_status_check"
    CHECK ("status" IN ('active','archived'))
);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_regression_status"
  ON "agent_tool_call_regression_cases" ("tenant_id", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_regression_tool"
  ON "agent_tool_call_regression_cases" ("tenant_id", "tool_name", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_regression_proposal"
  ON "agent_tool_call_regression_cases" ("tenant_id", "proposal_id");

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_regression_tool_call"
  ON "agent_tool_call_regression_cases" ("tool_call_id");

ALTER TABLE "agent_tool_call_regression_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_call_regression_cases" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'agent_tool_call_regression_cases'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "agent_tool_call_regression_cases"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
