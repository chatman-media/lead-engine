-- 0063_reply_debounce.sql
-- Настраиваемая пауза перед ответом бота (debounce + коалесинг).
--
-- conversations.reply_due_at — epoch-метка «когда сгенерировать отложенный
-- ответ». NULL = нет запланированного ответа. Каждое входящее/правка в окне
-- перезаписывает её (now + delay) → таймер сбрасывается. Поллер в apps/api
-- атомарно claim'ит due-строки (reply_due_at <= now) и генерит один ответ.
--
-- tenants.reply_delay_seconds — длительность паузы (сек.), правится в админке.
-- NULL/0 = выключено (бот отвечает сразу, как раньше). Диапазон 0..120.

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "reply_due_at" integer;

CREATE INDEX IF NOT EXISTS "idx_conv_reply_due"
  ON "conversations" ("reply_due_at")
  WHERE "reply_due_at" IS NOT NULL;

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "reply_delay_seconds" integer;

DO $$ BEGIN
  ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_reply_delay_seconds_check"
    CHECK ("reply_delay_seconds" IS NULL OR ("reply_delay_seconds" >= 0 AND "reply_delay_seconds" <= 120));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
