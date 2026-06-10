-- 0054_conversation_channel_id.sql
-- First-class channel relation for conversations while keeping legacy source.

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "channel_id" INTEGER REFERENCES "channels"("id") ON DELETE SET NULL;

DROP INDEX IF EXISTS "uniq_conversations_user_source";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_conversations_user_source"
  ON "conversations" ("user_id", "source")
  WHERE "channel_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_conversations_user_channel"
  ON "conversations" ("user_id", "channel_id")
  WHERE "channel_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_conversations_channel"
  ON "conversations" ("channel_id")
  WHERE "channel_id" IS NOT NULL;
