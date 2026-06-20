-- Заменяем три integer-колонки (round_step_atm/cash/bank) одним JSONB round_steps.
-- Ключ — ISO-код валюты (quoteAsset), значение — объект { atm?, cash?, bank? }.
-- Backfill: существующие ненулевые значения переносятся под текущий quoteAsset тенанта.

ALTER TABLE exchange_settings ADD COLUMN round_steps jsonb;

UPDATE exchange_settings
SET round_steps = jsonb_build_object(
  quote_asset,
  jsonb_strip_nulls(jsonb_build_object(
    'atm',  round_step_atm,
    'cash', round_step_cash,
    'bank', round_step_bank
  ))
)
WHERE round_step_atm IS NOT NULL
   OR round_step_cash IS NOT NULL
   OR round_step_bank IS NOT NULL;

ALTER TABLE exchange_settings
  DROP COLUMN round_step_atm,
  DROP COLUMN round_step_cash,
  DROP COLUMN round_step_bank;
