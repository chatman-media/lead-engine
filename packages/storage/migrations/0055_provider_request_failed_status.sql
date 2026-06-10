-- 0055_provider_request_failed_status.sql
-- Terminal failed state for provider outreach dispatch/template failures.

ALTER TABLE "provider_requests"
  DROP CONSTRAINT IF EXISTS "provider_requests_status_check";

ALTER TABLE "provider_requests"
  ADD CONSTRAINT "provider_requests_status_check"
  CHECK ("status" IN ('draft','sent','seen','quoted','accepted','declined','expired','cancelled','failed'));
