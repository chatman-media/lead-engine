-- Shadow A/B evaluations — after applying a coach proposal as a new style
-- version, optionally pit the new version (B) head-to-head against the
-- parent version (A) over N pairwise matches. Wilson 95% lower bound on
-- B's win rate decides whether the new version stays active.
--
-- Lifecycle:
--   running    → background task is executing pair runs
--   complete   → all pairs done; decision computed
--   failed     → orchestrator threw mid-batch; partial results retained
--
-- decision (only valid when status='complete'):
--   keep       → Wilson LB >= 0.5 → new version stays active
--   rollback   → Wilson LB < 0.5 → operator should rollback to parent
--   inconclusive → too few pairs ran; LB ambiguous
--
-- The eval is linked to the coach_proposal that triggered it so the UI
-- can show "Apply → Shadow eval → Decision" as one timeline.
CREATE TABLE IF NOT EXISTS shadow_evaluations (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES coach_proposals(id) ON DELETE CASCADE,
  parent_style_slug TEXT NOT NULL,
  parent_style_id INTEGER NOT NULL,
  new_style_slug TEXT NOT NULL,
  new_style_id INTEGER NOT NULL,
  pairs_planned INTEGER NOT NULL,
  pairs_done INTEGER NOT NULL DEFAULT 0,
  a_wins INTEGER NOT NULL DEFAULT 0,
  b_wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  win_rate_lb REAL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','complete','failed')),
  decision TEXT
    CHECK(decision IS NULL OR decision IN ('keep','rollback','inconclusive')),
  error_message TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_shadow_evaluations_proposal
  ON shadow_evaluations(proposal_id, started_at DESC);
