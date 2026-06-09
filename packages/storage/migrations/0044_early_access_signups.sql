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

-- Self-heal older deployments where this table existed before approval fields
-- were added. The migration runner may re-run already applied files, so this is
-- intentionally idempotent.
ALTER TABLE "early_access_signups"
  ADD COLUMN IF NOT EXISTS "name" text,
  ADD COLUMN IF NOT EXISTS "company" text,
  ADD COLUMN IF NOT EXISTS "use_case" text,
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'landing',
  ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT 'ru',
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS "tenant_id" integer REFERENCES "tenants" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "invite_id" integer REFERENCES "admin_invites" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "approved_at" integer,
  ADD COLUMN IF NOT EXISTS "approved_by_admin_id" integer REFERENCES "admins" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "user_agent" text,
  ADD COLUMN IF NOT EXISTS "ip" text,
  ADD COLUMN IF NOT EXISTS "meta_json" text NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  ADD COLUMN IF NOT EXISTS "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int;

ALTER TABLE "early_access_signups"
  ALTER COLUMN "source" SET DEFAULT 'landing',
  ALTER COLUMN "locale" SET DEFAULT 'ru',
  ALTER COLUMN "status" SET DEFAULT 'new',
  ALTER COLUMN "meta_json" SET DEFAULT '{}',
  ALTER COLUMN "created_at" SET DEFAULT (extract(epoch from now()))::int,
  ALTER COLUMN "updated_at" SET DEFAULT (extract(epoch from now()))::int;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_early_access_email"
  ON "early_access_signups" ("email");

CREATE INDEX IF NOT EXISTS "idx_early_access_status_created"
  ON "early_access_signups" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "idx_early_access_source"
  ON "early_access_signups" ("source");

CREATE INDEX IF NOT EXISTS "idx_early_access_tenant"
  ON "early_access_signups" ("tenant_id");
