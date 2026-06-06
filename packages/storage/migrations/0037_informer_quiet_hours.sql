-- Тихие часы (DND) для информера владельца: локальные часы 0..23 в informer_tz.
-- Окно может переходить через полночь (22→8). NULL / from==to = выключено.
ALTER TABLE operator_settings ADD COLUMN IF NOT EXISTS informer_quiet_from integer;
ALTER TABLE operator_settings ADD COLUMN IF NOT EXISTS informer_quiet_to integer;
