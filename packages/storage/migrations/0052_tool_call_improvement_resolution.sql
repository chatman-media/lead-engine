-- 0052_tool_call_improvement_resolution.sql
-- Link tracked tool-call improvement decisions to concrete follow-up artifacts.

ALTER TABLE "agent_tool_call_improvement_proposals"
  ADD COLUMN IF NOT EXISTS "resolution_kind" text,
  ADD COLUMN IF NOT EXISTS "resolution_ref" text,
  ADD COLUMN IF NOT EXISTS "resolution_url" text,
  ADD COLUMN IF NOT EXISTS "resolution_note" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_tool_call_improvement_resolution_kind_check'
  ) THEN
    ALTER TABLE "agent_tool_call_improvement_proposals"
      ADD CONSTRAINT "agent_tool_call_improvement_resolution_kind_check"
      CHECK (
        "resolution_kind" IS NULL
        OR "resolution_kind" IN (
          'prompt_patch',
          'tool_schema_patch',
          'regression_case',
          'coach_proposal',
          'shadow_eval',
          'pull_request',
          'other'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_agent_tool_call_improvement_resolution"
  ON "agent_tool_call_improvement_proposals" ("tenant_id", "resolution_kind", "updated_at" DESC);
