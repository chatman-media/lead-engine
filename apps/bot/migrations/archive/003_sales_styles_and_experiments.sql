-- Phase 2a of the sales-style engine.
--
-- Phase 1 stored styles in source code (src/sales/styles/*.ts) and forced a
-- single style for ALL conversations via BOT_SALES_STYLE env. That works for
-- a demo, not for actually testing variants in production.
--
-- This migration moves styles into the DB so they can be:
--   - edited in admin UI without redeploy
--   - selected per-conversation via A/B experiments
--   - versioned (parent_id chain) so we don't lose the prompt that was active
--     when a conversation happened
--
-- Source-code styles (src/sales/styles/*.ts) become the SEED set: at boot we
-- ensure each builtin slug exists in the table (idempotent on slug). The
-- table is the source of truth; the source files are just convenient
-- starter content.

-- Editable in admin UI. config_json holds the full Style as JSON, validated
-- against StyleSchema (Zod) every time it's read.
CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  -- Version chain. When the admin edits a live style, we INSERT a new row with
  -- version+1 and parent_id = old.id, mark the old one inactive. Conversations
  -- already running keep referring to the old row by style_id, so the prompt
  -- they were assigned remains pinned for the lifetime of that chat.
  version INTEGER NOT NULL DEFAULT 1,
  parent_id INTEGER REFERENCES styles(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_styles_active ON styles(is_active);

-- A running experiment allocates new conversations across styles.
-- allocation_json: {"flirty-belfort-v1": 50, "empathetic-nepq-v1": 50} — keys
-- are style slugs, values are integer weights summed to whatever (normalized
-- by pickVariant). At most one experiment may be in status='running'.
CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'done')),
  allocation_json TEXT NOT NULL,
  -- Which event marks success. The funnel-analytics query reads this and
  -- joins against users.status / conversations.* accordingly.
  success_metric TEXT NOT NULL DEFAULT 'qualified'
    CHECK (success_metric IN ('qualified', 'won', 'replied_3+')),
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);

-- Per-conversation A/B assignment. Set once on the first inbound message
-- when an experiment is running; sticky for the lifetime of the chat so the
-- prospect doesn't see a different persona on retries / restarts.
ALTER TABLE conversations ADD COLUMN style_id INTEGER REFERENCES styles(id);
ALTER TABLE conversations ADD COLUMN experiment_id INTEGER REFERENCES experiments(id);
-- Cached funnel stage (opener / qualify / pitch / objection / close) so
-- multi-turn drift is preserved across process restarts. Updated by the
-- stage router on every inbound message.
ALTER TABLE conversations ADD COLUMN current_stage TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_style ON conversations(style_id);
CREATE INDEX IF NOT EXISTS idx_conv_experiment ON conversations(experiment_id);

-- Per-message stage tag. Useful for funnel analytics ("how many turns did
-- conversations spend in 'objection' before closing?") and for replaying
-- the prompt that produced a given assistant reply.
ALTER TABLE messages ADD COLUMN stage TEXT;
