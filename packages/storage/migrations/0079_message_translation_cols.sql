-- #736 (эпик #728 PH-локализация) — фундамент хранения перевода сообщений.
-- Переводящий слой оператору (#731) показывает русский перевод клиентских
-- сообщений и переводит ответ оператора на язык клиента. Чтобы не терять
-- оригинал и не переводить одно и то же повторно — храним перевод прямо на
-- строке сообщения (перевод 1:1 к сообщению, один целевой язык).
--
--   orig_lang        — язык исходного text сообщения (null = не определён).
--   translated_text  — перевод text (null = ещё не переведено; кэш-семантика:
--                      «есть translated_text → не переводить повторно»).
--   translated_lang  — на какой язык переведено.
--
-- Валидация набора (ru/en/ko/zh) — в коде (asSupportedLang), не CHECK:
-- набор расширяется без миграции, как у conversations.detected_lang (0077).
-- Бэкфилл не нужен: NULL прозрачно означает «перевода нет». Все колонки
-- nullable без дефолтов → ADD COLUMN не переписывает heap (метаданные-операция
-- в PG ≥11), безопасно на большой messages. Идемпотентно (IF NOT EXISTS),
-- forward-only. RLS наследуется существующей tenant_isolation-политикой.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS orig_lang text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS translated_text text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS translated_lang text;
