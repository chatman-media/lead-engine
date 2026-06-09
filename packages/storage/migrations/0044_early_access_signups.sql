-- 0044_early_access_signups.sql
-- Public alpha/early-access waitlist. No RLS: requester has no tenant yet.

CREATE TABLE IF NOT EXISTS "early_access_signups" (
  "id" serial PRIMARY KEY,
  "email" text NOT NULL,
  "name" text,
  "company" text,
  "use_case" text,
  "source" text NOT NULL DEFAULT 'landing',
  "locale" text NOT NULL DEFAULT 'ru',
  "status" text NOT NULL DEFAULT 'new',
  "tenant_id" integer REFERENCES "tenants" ("id") ON DELETE SET NULL,
  "invite_id" integer REFERENCES "admin_invites" ("id") ON DELETE SET NULL,
  "approved_at" integer,
  "approved_by_admin_id" integer REFERENCES "admins" ("id") ON DELETE SET NULL,
  "user_agent" text,
  "ip" text,
  "meta_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_early_access_email"
  ON "early_access_signups" ("email");

CREATE INDEX IF NOT EXISTS "idx_early_access_status_created"
  ON "early_access_signups" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "idx_early_access_source"
  ON "early_access_signups" ("source");

CREATE INDEX IF NOT EXISTS "idx_early_access_tenant"
  ON "early_access_signups" ("tenant_id");
