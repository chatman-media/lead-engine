-- Pairwise self-play match results — direct head-to-head comparison
-- between two styles on the same candidate persona. Each row links to
-- the two solo self_play_matches rows so the admin UI can deep-link
-- the operator into either transcript.
--
-- ELO snapshot is the post-pair value AFTER eloUpdatePair was applied
-- (separate from the per-match solo ELO already in style_ratings —
-- pairwise captures head-to-head dominance, solo captures absolute).
CREATE TABLE IF NOT EXISTS pairwise_matches (
  id INTEGER PRIMARY KEY,
  style_a_slug TEXT NOT NULL,
  style_b_slug TEXT NOT NULL,
  persona_slug TEXT NOT NULL,
  winner TEXT NOT NULL CHECK(winner IN ('a','b','draw')),
  judge_reason TEXT,
  match_a_id INTEGER REFERENCES self_play_matches(id) ON DELETE SET NULL,
  match_b_id INTEGER REFERENCES self_play_matches(id) ON DELETE SET NULL,
  elo_a_after INTEGER NOT NULL,
  elo_b_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_pairwise_matches_styles
  ON pairwise_matches(style_a_slug, style_b_slug);
CREATE INDEX IF NOT EXISTS idx_pairwise_matches_created
  ON pairwise_matches(created_at DESC);
