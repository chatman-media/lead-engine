-- Vacancies — operationally-mutable list of currently-open job offers,
-- managed from the admin UI. Distinct from the KB on purpose: the KB
-- carries SLOWLY-CHANGING facts (visa rules, payment models, country
-- comparisons) that need re-embedding on update. Vacancies are
-- FAST-CHANGING (open Mon-Fri, closed Saturday morning) — operators
-- need a single text edit in admin → next bot message reflects it.
--
-- These rows are prepended to the RAG `CONTEXT` block under an
-- "АКТУАЛЬНЫЕ ВАКАНСИИ" heading on every turn (no embedding needed).
-- KB hits still come below, providing background info the bot can lean
-- on when the candidate's question isn't directly about availability.

CREATE TABLE IF NOT EXISTS vacancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Active vacancies are read on every inbound message — index them.
-- ORDER BY updated_at DESC so the freshest one shows first (operators
-- usually edit the top one).
CREATE INDEX IF NOT EXISTS idx_vacancies_active_recency
  ON vacancies(is_active, updated_at DESC)
  WHERE is_active = 1;
