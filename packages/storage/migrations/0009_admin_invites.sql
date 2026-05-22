-- Multi-admin invite tokens (Q3'26 M4).
--
-- SuperadminB генерит invite через POST /api/admin/admins/invite, передаёт
-- token out-of-band коллеге (TG/email/мессенджер), коллега активирует через
-- POST /api/auth/accept-invite → создаётся новый admin row + token usedAt
-- проставляется. Token истекает через expiresAt (по умолчанию +7 дней).
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "admin_invites" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'manager',
  "token" TEXT NOT NULL UNIQUE,
  "invited_by_admin_id" INTEGER REFERENCES "admins"("id") ON DELETE SET NULL,
  "expires_at" INTEGER NOT NULL,
  "used_at" INTEGER,
  "accepted_admin_id" INTEGER REFERENCES "admins"("id") ON DELETE SET NULL,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "admin_invites_role_check" CHECK ("role" IN ('superadmin', 'manager'))
);

CREATE INDEX IF NOT EXISTS "idx_admin_invites_tenant"
  ON "admin_invites" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_admin_invites_email"
  ON "admin_invites" ("tenant_id", "email");

-- RLS — symmetric с остальными tenant-scoped таблицами (см. 0004_enable_rls).
ALTER TABLE "admin_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_invites" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "admin_invites"
  FOR ALL
  USING ("tenant_id" = current_setting('app.tenant_id', true)::int)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::int);
