-- #698 — управляемые сценарии симуляции ("персоны").
-- Встроенные сценарии сидятся per-tenant из кода (admin-sim ensureBuiltinPersonas,
-- идемпотентно по persona_key); кастомные создаются из админки. Таблица только
-- создаётся здесь — seed данных в коде (валютная интерполяция брифов).
CREATE TABLE IF NOT EXISTS "sim_personas" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "persona_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "brief" TEXT NOT NULL,
  "is_builtin" BOOLEAN NOT NULL DEFAULT FALSE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sim_personas_tenant_key"
  ON "sim_personas" ("tenant_id", "persona_key");

CREATE INDEX IF NOT EXISTS "idx_sim_personas_tenant"
  ON "sim_personas" ("tenant_id");
