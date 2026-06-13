-- 0062_tenant_reply_history_limit.sql
-- Per-tenant size of the conversation history window the bot sends to the LLM
-- as context (messages). NULL = strategy default (20). Editable from admin «Общие».

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "reply_history_limit" integer;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_reply_history_limit_check"
  CHECK ("reply_history_limit" IS NULL OR ("reply_history_limit" >= 2 AND "reply_history_limit" <= 100));
