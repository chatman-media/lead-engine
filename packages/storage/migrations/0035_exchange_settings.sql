-- 0035_exchange_settings.sql
-- Per-tenant exchange settings: rate-feed refresh frequency + feed-stale threshold.
-- No row = platform defaults (RATE_FEED_MS / OPS_FEED_STALE_MIN).
-- last-refresh is tracked in-process by the scheduler (refresh-all on boot), not here.

CREATE TABLE IF NOT EXISTS "exchange_settings" (
  "tenant_id" integer PRIMARY KEY NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  -- How often the scheduler refreshes this tenant's auto-rates (seconds). 180 = 3 min.
  "rate_refresh_sec" integer NOT NULL DEFAULT 180,
  -- Feed-stale alert threshold for ops-watch (seconds). NULL = auto: max(env, 3 x refresh).
  "feed_stale_sec" integer,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "exchange_settings_refresh_check" CHECK ("rate_refresh_sec" >= 60 AND "rate_refresh_sec" <= 86400),
  CONSTRAINT "exchange_settings_stale_check" CHECK ("feed_stale_sec" IS NULL OR "feed_stale_sec" >= 60)
);

ALTER TABLE "exchange_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "exchange_settings";
CREATE POLICY tenant_isolation ON "exchange_settings"
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);
