-- Расширяет outbound_queue.status CHECK на 'processing' для атомарного
-- claim'а через FOR UPDATE SKIP LOCKED. Без этого multi-worker setup
-- видит одни и те же pending rows и пытается их параллельно отправить
-- → дубли в Telegram'е.
--
-- Lifecycle с processing:
--   pending → processing (worker claim'ает атомарным UPDATE)
--   processing → sent (успех)
--   processing → failed (ошибка)
--   processing → pending (manual reset через admin-UI / cleanup-script
--                          для зависших rows; auto-recovery cron в
--                          Issue #3 / M-2)
--
-- Backward-compatible: текущие pending rows продолжают работать с
-- single-worker dispatcher'ом без изменений; новый код использует
-- processing intermediate state.

ALTER TABLE "outbound_queue"
  DROP CONSTRAINT IF EXISTS "outbound_status_check";--> statement-breakpoint
ALTER TABLE "outbound_queue"
  ADD CONSTRAINT "outbound_status_check"
  CHECK ("status" IN ('pending','processing','sent','failed','cancelled'));
