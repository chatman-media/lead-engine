CREATE TABLE "notification_group_tokens" (
  "id" serial PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "admin_id" integer NOT NULL REFERENCES "admins"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL DEFAULT 'stage_changed',
  "expires_at" integer NOT NULL,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::integer
);

CREATE INDEX "idx_group_tokens_token" ON "notification_group_tokens"("token");
