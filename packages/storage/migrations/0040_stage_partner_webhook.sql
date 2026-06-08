-- 0040_stage_partner_webhook.sql
-- Partner availability ping: per-stage outbound webhook to a supplier/partner.
--
-- partner_webhook_url  — HTTP(S) URL or tg://CHAT_ID for Telegram notification.
-- partner_webhook_mode — fire_and_forget: POST and forget;
--                        await_callback:  lead waits for /api/partner/cb/:token.
--
-- leads.awaiting_token — set when a lead enters an await_callback stage.
--                        Cleared when callback is received (confirm or cancel).
--                        NULL = lead is not waiting for an external confirmation.

ALTER TABLE "stage_definitions"
  ADD COLUMN IF NOT EXISTS "partner_webhook_url"  text,
  ADD COLUMN IF NOT EXISTS "partner_webhook_mode" text NOT NULL DEFAULT 'fire_and_forget';

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "awaiting_token" text;

-- Быстрый поиск лида по токену (callback arrives without tenantId context).
CREATE INDEX IF NOT EXISTS "idx_leads_awaiting_token"
  ON "leads" ("awaiting_token")
  WHERE "awaiting_token" IS NOT NULL;
