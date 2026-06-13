-- 0061_exchange_risk_settings.sql
-- Risk-review rules for exchange orders. All amounts in the tenant's quote
-- currency. NULL / 0 means the rule is OFF. When a rule trips, the order is
-- created on a manual-review hold (risk_json.decision = "manual") and requisites
-- are withheld until an operator approves.

ALTER TABLE "exchange_settings"
  ADD COLUMN IF NOT EXISTS "risk_amount_threshold" integer,
  ADD COLUMN IF NOT EXISTS "risk_first_deal_review" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "risk_daily_limit" integer;
