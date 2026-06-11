-- 0060_admin_notification_targets.sql
-- Durable deep-link targets for informer feed items.

ALTER TABLE "admin_notifications"
  ADD COLUMN IF NOT EXISTS "conversation_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "lead_id" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_admin_notif_conversation"
  ON "admin_notifications" ("tenant_id", "conversation_id");

CREATE INDEX IF NOT EXISTS "idx_admin_notif_lead"
  ON "admin_notifications" ("tenant_id", "lead_id");
