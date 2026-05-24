-- Webhook-уведомления при смене стадии лида.
-- Tenant настраивает один или несколько URL; при каждом lead.stage_changed
-- API шлёт POST с JSON-payload и опциональной HMAC-подписью.

CREATE TABLE IF NOT EXISTS "stage_webhooks" (
  "id"         SERIAL PRIMARY KEY,
  "tenant_id"  INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "url"        TEXT NOT NULL,
  "secret"     TEXT,
  "is_active"  BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_stage_webhooks_tenant"
  ON "stage_webhooks" ("tenant_id");

CREATE INDEX IF NOT EXISTS "idx_stage_webhooks_active"
  ON "stage_webhooks" ("tenant_id")
  WHERE is_active = TRUE;
