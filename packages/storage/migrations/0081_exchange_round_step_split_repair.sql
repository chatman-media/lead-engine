-- Чинит коллизию 0080: файл 0080 переписали с одиночного quote_round_step на
-- три колонки round_step_atm/cash/bank ПОСЛЕ того, как старую версию уже
-- применили (prod/dev). Раннер видит 0080 в _migrations и пропускает её —
-- поэтому новые колонки не создаются, а задеплоенный код их читает и падает
-- (PostgresError: column "round_step_atm" does not exist). Эта forward-миграция
-- доводит схему до целевого вида независимо от того, в каком состоянии БД.
--
-- Идемпотентно и безопасно для всех трёх случаев:
--   • prod/dev со старым 0080  → есть quote_round_step, нет round_step_* → добавляем, переносим, дропаем старую
--   • prod уже подлеченный руками → есть и те и другие → ADD no-op, дроп чистит orphan
--   • свежая БД с новым 0080    → есть round_step_*, нет quote_round_step → ADD no-op, DO-блок пропускается

ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS round_step_atm INTEGER;
ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS round_step_cash INTEGER;
ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS round_step_bank INTEGER;

-- Перенос значения старого одиночного шага (если оператор его задавал) на ATM и
-- наличные, затем удаление осиротевшей колонки — только если она ещё существует.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'exchange_settings' AND column_name = 'quote_round_step'
  ) THEN
    UPDATE exchange_settings
       SET round_step_atm  = COALESCE(round_step_atm,  quote_round_step),
           round_step_cash = COALESCE(round_step_cash, quote_round_step)
     WHERE quote_round_step IS NOT NULL;
    ALTER TABLE exchange_settings DROP COLUMN quote_round_step;
  END IF;
END $$;
