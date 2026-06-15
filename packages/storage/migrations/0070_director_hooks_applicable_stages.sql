-- Стадийная фильтрация director-хуков (как у skills.applicable_stages_json).
-- JSON-массив slug'ов воронки ("opener"/"qualify"/...). Пустой массив '[]' =
-- «применять на всех стадиях» — это и дефолт, поэтому существующие хуки ведут
-- себя как раньше (без регресса). Идемпотентно (ADD COLUMN IF NOT EXISTS).

ALTER TABLE director_hooks
  ADD COLUMN IF NOT EXISTS applicable_stages_json text NOT NULL DEFAULT '[]';
