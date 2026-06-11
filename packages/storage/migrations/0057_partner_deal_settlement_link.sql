-- 0057_partner_deal_settlement_link.sql
-- Link partner_deals to the settlement that aggregates them.
-- A deal belongs to at most one settlement; cancelling a settlement
-- releases its deals (settlement_id back to NULL) so they can be
-- picked up by a later period.

ALTER TABLE "partner_deals"
  ADD COLUMN IF NOT EXISTS "settlement_id" integer
    REFERENCES "partner_settlements"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "idx_partner_deals_settlement"
  ON "partner_deals" ("tenant_id", "settlement_id");
