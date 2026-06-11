-- 0059_exchange_handoff_customer_notice.sql
-- Controls whether auto-handoff in exchange sends a customer-facing fallback.

ALTER TABLE "exchange_settings"
  ADD COLUMN IF NOT EXISTS "handoff_customer_notice" boolean NOT NULL DEFAULT true;
