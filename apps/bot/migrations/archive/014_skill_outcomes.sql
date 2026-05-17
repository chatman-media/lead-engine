-- Phase 2 of the salesperson-competition system: outcome attribution.
--
-- A lead transitioning into a terminal state (submitted = won, rejected =
-- draw, ghosted-then-closed = loss) triggers attribution: the skills that
-- the bot used in the last N assistant messages get a win/loss/draw event
-- recorded here, and the active style's ELO updates against a 1500 baseline.
--
-- skill_outcomes is a flat event log — one row per (skill, outcome) pair.
-- Aggregates (win-rate, count) are computed by SQL on demand. Cheap on the
-- corpus sizes we'd ever see (<1M events even at heavy traffic for years).
--
-- style_ratings is one row per style with mutable ELO + win/loss/draw tally.
-- Baseline ELO 1500 (chess convention), K-factor 32 by default — see
-- src/sales/elo.ts for the math. Recomputed lazily; no scheduled job needed.

CREATE TABLE IF NOT EXISTS skill_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  style_slug TEXT,                  -- de-normalised; surviving style deletion is cheap
  skill_slug TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'draw')),
  /** Source of the attribution — useful when debugging odd aggregates. */
  source TEXT NOT NULL CHECK (source IN ('lead_submitted', 'lead_rejected', 'lead_ghosted', 'manual')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill ON skill_outcomes(skill_slug);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_lead ON skill_outcomes(lead_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_recent ON skill_outcomes(created_at DESC);

CREATE TABLE IF NOT EXISTS style_ratings (
  style_slug TEXT PRIMARY KEY,
  elo INTEGER NOT NULL DEFAULT 1500,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  last_outcome_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Idempotency: each (lead_id, skill_slug, source) tuple yields at most one
-- outcome event. Re-running attribution after a state hop won't double-count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_outcomes_idempotency
  ON skill_outcomes(lead_id, skill_slug, source);
