-- 0054_whatsapp_provider_outbound_policy.sql
-- WhatsApp-compliant provider outreach: onboarding opt-in and failed send state.

ALTER TABLE "provider_profiles"
  ADD COLUMN IF NOT EXISTS "opt_in_source" text,
  ADD COLUMN IF NOT EXISTS "opt_in_at" integer,
  ADD COLUMN IF NOT EXISTS "opt_in_categories_json" text NOT NULL DEFAULT '[]';

ALTER TABLE "provider_requests"
  ADD COLUMN IF NOT EXISTS "failed_at" integer;

ALTER TABLE "provider_requests"
  DROP CONSTRAINT IF EXISTS "provider_requests_status_check";

ALTER TABLE "provider_requests"
  ADD CONSTRAINT "provider_requests_status_check"
    CHECK ("status" IN ('draft','sent','seen','quoted','accepted','declined','expired','cancelled','failed'));
