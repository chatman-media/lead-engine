-- Жёсткий лимит на число проактивных «как дела по заявке?» пингов (checkin-sweep
-- в apps/worker). Раньше лид на активной стадии с checkin_interval_days молчал →
-- бот пинговал его КАЖДЫЙ интервал бесконечно (стоп только если задан
-- stale_timeout_days, а он стоит не на всех стадиях). Теперь — не больше
-- WORKER_CHECKIN_MAX_PER_STAGE пингов НА СТАДИЮ.
--
--   checkin_count          — сколько раз пинганули на ТЕКУЩЕЙ стадии.
--   last_checkin_stage_id  — на какой стадии был последний пинг; при переходе
--                            лида на новую стадию счётчик логически обнуляется
--                            (сравнение в самом sweep, без правок кода переходов),
--                            чтобы напоминание об оплате не зарубилось лимитом,
--                            исчерпанным ещё на этапе котировки.
-- Идемпотентно (ADD COLUMN IF NOT EXISTS).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS checkin_count integer NOT NULL DEFAULT 0;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_checkin_stage_id integer;
