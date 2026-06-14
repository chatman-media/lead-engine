-- #arch-fix: выделенные колонки вместо meta_json для счётчика фолбэков
-- и метки последнего авто-сообщения «вне часов».
-- Устраняет два несогласованных read-modify-write через JSON (race condition при
-- параллельных обновлениях) и позволяет делать атомарный UPDATE без SELECT.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS fallback_streak smallint NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS offhours_last_auto_sent integer;
