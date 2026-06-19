-- #735 (эпик #728 PH-локализация) — фундамент мультиязыка.
-- Сохраняем определённый язык диалога, чтобы downstream-шаги (#730 роутинг
-- ответа, #731 переводящий слой оператору) могли его прочитать.
--
--   detected_lang  — null = «не определён», runtime фолбэкнет на тенант-дефолт.
--                    Валидация набора (ru/en/ko/zh) — в коде, не CHECK
--                    (расширение набора без миграции; забытый ru-only тенант
--                    из 2025-го не должен ронять INSERT'ы).
--   lang_locked    — true = язык залип, менять только confident-сигналом
--                    другого скрипта. Защищает от дребезга на коротких репликах.
--
-- Бэкфилл не нужен: NULL прозрачно фолбэкается. Идемпотентно
-- (ADD COLUMN IF NOT EXISTS) — раннер `--keep-data` может пометить файл
-- applied без выполнения, ребежимся без падений.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS detected_lang text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS lang_locked boolean NOT NULL DEFAULT false;
