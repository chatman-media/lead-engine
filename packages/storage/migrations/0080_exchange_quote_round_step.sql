-- Шаг округления вниз котировки (floor) по способу выдачи.
-- NULL → берётся из словаря валют: PHP/THB→100, VND/IDR→50000 (ATM), 1 (bank).
ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS round_step_atm INTEGER;
ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS round_step_cash INTEGER;
ALTER TABLE exchange_settings ADD COLUMN IF NOT EXISTS round_step_bank INTEGER;
