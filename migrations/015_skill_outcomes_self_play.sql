-- Phase 3: relax `skill_outcomes.source` to allow 'self_play'.
--
-- SQLite doesn't allow editing a CHECK constraint in place — we have to
-- rebuild the table. Standard rename → create-new → copy → drop-old dance.
-- Indexes are recreated from scratch. The UNIQUE on (lead_id, skill_slug,
-- source) is preserved so re-running attribution stays idempotent.

BEGIN;

ALTER TABLE skill_outcomes RENAME TO _skill_outcomes_old;

CREATE TABLE skill_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  style_slug TEXT,
  skill_slug TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'draw')),
  source TEXT NOT NULL CHECK (source IN (
    'lead_submitted', 'lead_rejected', 'lead_ghosted', 'manual', 'self_play'
  )),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO skill_outcomes
  (id, lead_id, conversation_id, message_id, style_slug, skill_slug, outcome, source, created_at)
SELECT id, lead_id, conversation_id, message_id, style_slug, skill_slug, outcome, source, created_at
FROM _skill_outcomes_old;

DROP TABLE _skill_outcomes_old;

CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill ON skill_outcomes(skill_slug);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_lead ON skill_outcomes(lead_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_recent ON skill_outcomes(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_outcomes_idempotency
  ON skill_outcomes(lead_id, skill_slug, source);

COMMIT;
