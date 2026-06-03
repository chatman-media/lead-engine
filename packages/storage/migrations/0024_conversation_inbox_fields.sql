ALTER TABLE "conversations" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "unread_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_message_text" text;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_status_check" CHECK ("status" IN ('open', 'pending', 'resolved'));
--> statement-breakpoint
CREATE INDEX "idx_conv_status_last" ON "conversations" ("status", "last_message_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_conv_assignee_last" ON "conversations" ("assigned_admin_id", "last_message_at" DESC NULLS LAST);
--> statement-breakpoint
UPDATE "conversations" c
SET "last_message_text" = (
  SELECT left("messages"."text", 200)
  FROM "messages"
  WHERE "messages"."tenant_id" = c."tenant_id"
    AND "messages"."conversation_id" = c."id"
    AND "messages"."role" IN ('user', 'assistant', 'human')
    AND "messages"."deleted_at" IS NULL
  ORDER BY "messages"."created_at" DESC, "messages"."id" DESC
  LIMIT 1
)
WHERE c."last_message_text" IS NULL
  AND EXISTS (
  SELECT "text"
  FROM "messages"
  WHERE "messages"."tenant_id" = c."tenant_id"
    AND "messages"."conversation_id" = c."id"
    AND "messages"."role" IN ('user', 'assistant', 'human')
    AND "messages"."deleted_at" IS NULL
  LIMIT 1
);
