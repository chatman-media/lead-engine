-- Шаг округления вниз котировки (floor) для данного тенанта.
-- NULL → берётся из словаря валют (denomStep): PHP/THB → 100, VND → 10000, IDR → 1000.
ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS quote_round_step INTEGER;
