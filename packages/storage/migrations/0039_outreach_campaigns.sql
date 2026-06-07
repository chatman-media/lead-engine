-- Кампании капельной рассылки: список лидов + приветствие + скорость выдачи.
CREATE TABLE IF NOT EXISTS "outreach_campaigns" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "greeting_text" TEXT NOT NULL,
  "drip_per_tick" INTEGER NOT NULL DEFAULT 1,
  "drip_interval_sec" INTEGER NOT NULL DEFAULT 60,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "last_dripped_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "outreach_campaigns_status_check"
    CHECK ("status" IN ('draft','active','paused','completed')),
  CONSTRAINT "outreach_campaigns_drip_check"
    CHECK ("drip_per_tick" > 0 AND "drip_interval_sec" >= 0)
);
CREATE INDEX IF NOT EXISTS "idx_outreach_campaigns_tenant_status"
  ON "outreach_campaigns" ("tenant_id", "status");

CREATE TABLE IF NOT EXISTS "outreach_campaign_leads" (
  "id" SERIAL PRIMARY KEY,
  "campaign_id" INTEGER NOT NULL REFERENCES "outreach_campaigns"("id") ON DELETE CASCADE,
  "lead_id" INTEGER NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "enqueued_at" INTEGER,
  "error_reason" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "outreach_campaign_leads_status_check"
    CHECK ("status" IN ('pending','enqueued','sent','skipped','failed')),
  CONSTRAINT "uniq_outreach_campaign_leads" UNIQUE ("campaign_id", "lead_id")
);
CREATE INDEX IF NOT EXISTS "idx_outreach_campaign_leads_status"
  ON "outreach_campaign_leads" ("campaign_id", "status");

ALTER TABLE "outreach_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outreach_campaigns"
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);

ALTER TABLE "outreach_campaign_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_campaign_leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outreach_campaign_leads"
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);
