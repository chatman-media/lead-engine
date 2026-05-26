CREATE TABLE IF NOT EXISTS "notification_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "event_type" text NOT NULL,
  "condition_json" text NOT NULL DEFAULT '{}',
  "channel_type" text NOT NULL DEFAULT 'telegram_group',
  "target_id" text NOT NULL,
  "priority" text NOT NULL DEFAULT 'normal',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_notif_rules_tenant" ON "notification_rules" ("tenant_id", "is_active");
CREATE INDEX IF NOT EXISTS "idx_notif_rules_event"  ON "notification_rules" ("tenant_id", "event_type");

CREATE TABLE IF NOT EXISTS "notification_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "body" text NOT NULL,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notif_tpl_tenant_slug" ON "notification_templates" ("tenant_id", "slug");

CREATE TABLE IF NOT EXISTS "operator_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "admin_id" integer NOT NULL REFERENCES "admins"("id") ON DELETE cascade,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "telegram_chat_id" text,
  "link_token" text UNIQUE,
  "link_token_expires_at" integer,
  "notify_on_assigned_only" boolean NOT NULL DEFAULT true,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_op_settings_admin"    ON "operator_settings" ("admin_id");
CREATE INDEX        IF NOT EXISTS "idx_op_settings_tenant"    ON "operator_settings" ("tenant_id");
CREATE INDEX        IF NOT EXISTS "idx_op_settings_link_token" ON "operator_settings" ("link_token");
