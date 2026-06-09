-- 0046_agent_tool_calls.sql
-- Persist agentic tool-loop traces as first-class tenant-scoped data.

CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "conversation_id" integer NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "contact_id" integer REFERENCES "contacts"("id") ON DELETE set null,
  "message_id" integer REFERENCES "messages"("id") ON DELETE set null,
  "outbound_queue_id" integer REFERENCES "outbound_queue"("id") ON DELETE set null,
  "source" text NOT NULL,
  "tool_name" text NOT NULL,
  "args_json" text NOT NULL DEFAULT '{}',
  "result_json" text NOT NULL DEFAULT 'null',
  "error" boolean NOT NULL DEFAULT false,
  "cycle" integer NOT NULL DEFAULT 0,
  "tool_call_index" integer NOT NULL DEFAULT 0,
  "latency_ms" integer,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "agent_tool_calls_source_check"
    CHECK ("source" IN ('rag_reply','llm_reply','admin_sim','self_play'))
);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_conversation"
  ON "agent_tool_calls" ("tenant_id", "conversation_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_tool"
  ON "agent_tool_calls" ("tenant_id", "tool_name", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_error"
  ON "agent_tool_calls" ("tenant_id", "error", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_tool_calls_outbound"
  ON "agent_tool_calls" ("outbound_queue_id");

ALTER TABLE "agent_tool_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_calls" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'agent_tool_calls'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "agent_tool_calls"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
