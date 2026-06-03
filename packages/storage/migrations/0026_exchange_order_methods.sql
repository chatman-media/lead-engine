-- 0026_exchange_order_methods.sql
-- Capture real exchange workflow dimensions: requested side, payment source/method,
-- and richer payout methods/destination details.

ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "amount_mode" text DEFAULT 'source_amount' NOT NULL;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "requested_amount" double precision;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "payment_method" text;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "payment_rail" text;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "source_bank" text;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "payer_name" text;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "third_party_approved" boolean DEFAULT false NOT NULL;
ALTER TABLE "exchange_orders" ADD COLUMN IF NOT EXISTS "payout_destination_json" text;

UPDATE "exchange_orders"
SET "requested_amount" = COALESCE("requested_amount", "amount_from")
WHERE "requested_amount" IS NULL;

ALTER TABLE "exchange_orders" DROP CONSTRAINT IF EXISTS "exchange_orders_amount_mode_check";
ALTER TABLE "exchange_orders" ADD CONSTRAINT "exchange_orders_amount_mode_check"
  CHECK ("amount_mode" IN ('source_amount','target_thb'));

ALTER TABLE "exchange_orders" DROP CONSTRAINT IF EXISTS "exchange_orders_payment_method_check";
ALTER TABLE "exchange_orders" ADD CONSTRAINT "exchange_orders_payment_method_check"
  CHECK ("payment_method" IS NULL OR "payment_method" IN ('crypto_transfer','sbp_qr','card_transfer','bank_transfer','cash'));

ALTER TABLE "exchange_orders" DROP CONSTRAINT IF EXISTS "exchange_orders_payout_method_check";
ALTER TABLE "exchange_orders" ADD CONSTRAINT "exchange_orders_payout_method_check"
  CHECK ("payout_method" IS NULL OR "payout_method" IN ('office_cash','cardless_atm','courier_cash','thai_bank_transfer','atm'));

CREATE INDEX IF NOT EXISTS "idx_exchange_orders_payment_method"
  ON "exchange_orders" ("tenant_id", "payment_method");
CREATE INDEX IF NOT EXISTS "idx_exchange_orders_payout_method"
  ON "exchange_orders" ("tenant_id", "payout_method");
