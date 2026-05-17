-- Self-play match transcripts. Phase 3 stores per-skill outcomes in
-- `skill_outcomes` (source='self_play') and per-style ELO in
-- `style_ratings`, but loses the actual transcript. Without transcripts
-- the operator can't review WHY a match ended a particular way — they
-- see "alina-infinity-v1 lost to skeptic-anya 8 times" but not what
-- the bot kept saying that broke the conversion.
--
-- This table fills that gap. One row per match. `transcript_json` is
-- a JSON array of `{role, text}` so the frontend can render a chat-like
-- view. `judge_reason` is the model's one-liner explaining the verdict.

CREATE TABLE IF NOT EXISTS self_play_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_slug TEXT NOT NULL,
  persona_slug TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'draw')),
  judge_reason TEXT,
  transcript_json TEXT NOT NULL,
  turns INTEGER NOT NULL,
  /** Skill slugs attached to the style at match time (de-normalised so
   *  later catalogue edits don't change the historical record). */
  skills_json TEXT NOT NULL DEFAULT '[]',
  /** Synthetic lead row id from the orchestrator's persistence step.
   *  Linkable to skill_outcomes via leads.id. */
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_self_play_recent ON self_play_matches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_play_style ON self_play_matches(style_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_play_persona ON self_play_matches(persona_slug, created_at DESC);
