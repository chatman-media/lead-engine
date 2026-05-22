-- Per-tenant LLM call usage tracking.
--
-- Каждый chat/embed/vision/judge call'я wrapChatClient или wrapEmbeddingClient
-- append'ит row сюда (через batched writer, не блочит pipeline).
-- UI показывает аггрегаты за месяц + per-purpose breakdown.
--
-- Размер: при 100 tenants × 1K calls/мес = 100K row/мес ≈ 8MB/мес.
-- TTL — пока not enforced (audit value); cleanup для tenants старше 1 года —
-- TODO когда DB станет проблемой.

CREATE TABLE IF NOT EXISTS "llm_usage_events" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "purpose" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "latency_ms" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "error_kind" TEXT,
  "prompt_tokens" INTEGER,
  "completion_tokens" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "llm_usage_purpose_check" CHECK (
    "purpose" IN ('chat', 'embed', 'vision', 'judge', 'memory', 'stage')
  )
);

CREATE INDEX IF NOT EXISTS "idx_llm_usage_tenant_ts"
  ON "llm_usage_events" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_llm_usage_purpose"
  ON "llm_usage_events" ("tenant_id", "purpose", "created_at" DESC);

ALTER TABLE "llm_usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llm_usage_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "llm_usage_events"
  FOR ALL
  USING ("tenant_id" = current_setting('app.tenant_id', true)::int)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::int);
