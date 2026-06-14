-- 0064_bot_settings.sql
-- Расширенные настройки поведения бота по сообщениям (эпик #623). Один JSON-блок
-- per-tenant вместо россыпи колонок — набор быстро растёт. Парсится типизированно
-- (parseBotSettings, conversation-engine/bot-settings.ts) с дефолтами и клампингом.
-- Покрывает: рабочие часы, стоп-слова/авто-передачу, параметры генерации, текст
-- фолбэка/приветствия, авто-закрытие, STT/медиа, дробление ответа.
-- Существующие reply_history_limit (#608) и reply_delay_seconds (#620) остаются
-- отдельными колонками (не трогаем).

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "bot_settings_json" text;
