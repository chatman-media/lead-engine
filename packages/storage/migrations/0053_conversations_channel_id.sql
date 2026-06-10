-- 0053_conversations_channel_id.sql
-- First-class conversation -> channel relation for cross-channel relay.

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "channel_id" integer REFERENCES "channels"("id") ON DELETE set null;

DROP INDEX IF EXISTS "uniq_conversations_user_source";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_conversations_user_source_legacy"
  ON "conversations" ("user_id", "source")
  WHERE "channel_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_conversations_user_channel"
  ON "conversations" ("tenant_id", "user_id", "channel_id")
  WHERE "channel_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_conversations_channel"
  ON "conversations" ("tenant_id", "channel_id")
  WHERE "channel_id" IS NOT NULL;
