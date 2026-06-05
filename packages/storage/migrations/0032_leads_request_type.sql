-- 0032_leads_request_type.sql
-- Concierge-режим: один контакт может держать несколько лидов — по одному на
-- активный запрос (request_type). Снимаем UNIQUE(user_id) и добавляем ось
-- request_type. Для одно-воронных вертикалей лид по-прежнему один (гарантия
-- на уровне приложения), поэтому регресса нет: существующие лиды остаются с
-- request_type = NULL.
--
-- См. docs/CONCIERGE_VERTICAL.md (Фаза 1) и эпик #175.

-- 1) Снять UNIQUE(user_id) — было leads_user_id_unique (0000_init_full_schema).
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_user_id_unique";

-- 2) Ось типа запроса. NULL для legacy / одно-воронных вертикалей.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "request_type" TEXT;

-- 3) Индекс под резолвинг лидов контакта (N открытых лидов на гостя).
CREATE INDEX IF NOT EXISTS "idx_leads_tenant_user" ON "leads" ("tenant_id", "user_id");
