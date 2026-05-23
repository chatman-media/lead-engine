-- Реферальные/партнёрские коды (Q2'26 GTM).
--
-- Тенант создаёт коды через POST /api/admin/referral-codes и раздаёт
-- партнёрам / агентствам. Партнёр передаёт код своим клиентам при
-- регистрации → tenants.referred_by_code заполняется, uses_count++.
--
-- ВАЖНО: таблица БЕЗ RLS — при signup нет tenant-контекста и нужен
-- cross-tenant SELECT по code. Аналогично таблице tenants (тоже без RLS).
-- Защита от утечки данных обеспечивается на уровне API:
--   - GET /api/admin/referral-codes фильтрует по tenant_id текущего тенанта.
--   - Signup-endpoint видит только code + uses_count — без tenant_id в ответе.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "referred_by_code" TEXT;

CREATE TABLE IF NOT EXISTS "referral_codes" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "code" TEXT NOT NULL,
  "uses_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_referral_codes_code"
  ON "referral_codes" ("code");

CREATE INDEX IF NOT EXISTS "idx_referral_codes_tenant"
  ON "referral_codes" ("tenant_id");
