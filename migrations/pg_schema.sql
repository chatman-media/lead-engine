CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tg_user_id BIGINT NOT NULL UNIQUE,
  tg_username TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'questionnaire_pending', 'qualified', 'won', 'lost')),
  profile_json TEXT,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS questionnaire_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qtokens_user ON questionnaire_tokens(user_id);

CREATE TABLE IF NOT EXISTS styles (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  parent_id INTEGER REFERENCES styles(id),
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  -- Soft-delete marker. NULL = live; NOT NULL = operator-retired chain
  -- (distinguishes "removed by operator" from "is_active=FALSE because a
  -- newer version supersedes it"). Set together with is_active=FALSE.
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_styles_slug_version ON styles(slug, version);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_styles_active_slug ON styles(slug) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_styles_active ON styles(is_active);
-- Existing deployments predate the deleted_at column.
ALTER TABLE styles ADD COLUMN IF NOT EXISTS deleted_at INTEGER;

CREATE TABLE IF NOT EXISTS experiments (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'done')),
  allocation_json TEXT NOT NULL,
  success_metric TEXT NOT NULL DEFAULT 'qualified'
    CHECK (success_metric IN ('qualified', 'won', 'replied_3+')),
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'queued', 'human')),
  escalated_at INTEGER,
  assigned_admin_id INTEGER,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  style_id INTEGER REFERENCES styles(id),
  experiment_id INTEGER REFERENCES experiments(id),
  current_stage TEXT,
  summary_json TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_mode_last ON conversations(mode, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_conv_style ON conversations(style_id);
CREATE INDEX IF NOT EXISTS idx_conv_experiment ON conversations(experiment_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'human', 'system')),
  text TEXT NOT NULL,
  tg_message_id INTEGER,
  meta_json TEXT,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  stage TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_user_tg
  ON messages(conversation_id, tg_message_id)
  WHERE role = 'user' AND tg_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kb_documents (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  topic TEXT,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_source_hash ON kb_documents(source, content_hash);
CREATE INDEX IF NOT EXISTS idx_kb_docs_topic ON kb_documents(topic) WHERE topic IS NOT NULL;

CREATE TABLE IF NOT EXISTS kb_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  embedding vector(1536),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('russian', coalesce(text, ''))) STORED,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_fts ON kb_chunks USING GIN (fts);

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);

CREATE TABLE IF NOT EXISTS vacancies (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vacancies_active_recency ON vacancies(is_active, updated_at DESC) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'intake_pending'
    CHECK (state IN ('intake_pending','intake_complete','approved','rejected','docs_pending','docs_complete','submitted','closed')),
  intake_json TEXT,
  visa_docs_json TEXT,
  application_id TEXT UNIQUE,
  ops_chat_id BIGINT,
  ops_message_id INTEGER,
  rejected_reason TEXT,
  decided_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leads_state_recency ON leads(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS lead_events (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead_recency ON lead_events(lead_id, created_at);

CREATE TABLE IF NOT EXISTS lead_notes (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_recency ON lead_notes(lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kb_suggestions (
  id SERIAL PRIMARY KEY,
  question_text TEXT NOT NULL,
  answer_draft TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ingested','rejected')),
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  decided_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  decided_at INTEGER,
  kb_document_id INTEGER REFERENCES kb_documents(id) ON DELETE SET NULL,
  rejected_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_suggestions_status ON kb_suggestions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_suggestions_conv ON kb_suggestions(source_conversation_id);

CREATE TABLE IF NOT EXISTS skills (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt_fragment TEXT NOT NULL,
  applicable_stages_json TEXT NOT NULL DEFAULT '[]',
  intent TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skills_family ON skills(family);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(is_enabled) WHERE is_enabled = TRUE;

CREATE TABLE IF NOT EXISTS style_skills (
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (style_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_style_skills_skill ON style_skills(skill_id);

CREATE TABLE IF NOT EXISTS skill_outcomes (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  style_slug TEXT,
  skill_slug TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won','lost','draw')),
  source TEXT NOT NULL CHECK (source IN ('lead_submitted','lead_rejected','lead_ghosted','manual','self_play')),
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill ON skill_outcomes(skill_slug);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_lead ON skill_outcomes(lead_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcomes_recent ON skill_outcomes(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_outcomes_idempotency ON skill_outcomes(lead_id, skill_slug, source);

CREATE TABLE IF NOT EXISTS style_ratings (
  style_slug TEXT PRIMARY KEY,
  elo INTEGER NOT NULL DEFAULT 1500,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  last_outcome_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS self_play_matches (
  id SERIAL PRIMARY KEY,
  style_slug TEXT NOT NULL,
  persona_slug TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('won','lost','draw')),
  judge_reason TEXT,
  transcript_json TEXT NOT NULL,
  turns INTEGER NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  fabrications_caught INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_self_play_recent ON self_play_matches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_play_style ON self_play_matches(style_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_play_persona ON self_play_matches(persona_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS pairwise_matches (
  id SERIAL PRIMARY KEY,
  style_a_slug TEXT NOT NULL,
  style_b_slug TEXT NOT NULL,
  persona_slug TEXT NOT NULL,
  winner TEXT NOT NULL CHECK(winner IN ('a','b','draw')),
  judge_reason TEXT,
  match_a_id INTEGER REFERENCES self_play_matches(id) ON DELETE SET NULL,
  match_b_id INTEGER REFERENCES self_play_matches(id) ON DELETE SET NULL,
  elo_a_after INTEGER NOT NULL,
  elo_b_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pairwise_matches_styles ON pairwise_matches(style_a_slug, style_b_slug);
CREATE INDEX IF NOT EXISTS idx_pairwise_matches_created ON pairwise_matches(created_at DESC);

CREATE TABLE IF NOT EXISTS userbot_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_string TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
INSERT INTO userbot_session (id, session_string) VALUES (1, '') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS coach_proposals (
  id SERIAL PRIMARY KEY,
  style_slug TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  persona_filter TEXT,
  summary TEXT NOT NULL,
  edits_json TEXT NOT NULL,
  rationale_json TEXT NOT NULL,
  raw_output TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')),
  created_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  decided_at INTEGER,
  decided_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_coach_proposals_style ON coach_proposals(style_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coach_proposals_status ON coach_proposals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS shadow_evaluations (
  id SERIAL PRIMARY KEY,
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
  win_rate_lb DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','failed')),
  decision TEXT CHECK(decision IS NULL OR decision IN ('keep','rollback','inconclusive')),
  error_message TEXT,
  started_at INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shadow_evaluations_proposal ON shadow_evaluations(proposal_id, started_at DESC);

CREATE TABLE IF NOT EXISTS userbot_send_queue (
  id          SERIAL  PRIMARY KEY,
  tg_user_id  BIGINT  NOT NULL,
  text        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  sent_at     INTEGER,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0
);
-- Existing deployments predate the attempts column; add it idempotently.
ALTER TABLE userbot_send_queue ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_userbot_queue_pending
  ON userbot_send_queue(id) WHERE sent_at IS NULL;

-- Operator-action audit trail. Wrote per destructive admin endpoint
-- (KB wipe, outcomes purge, webhook delete, lead delete, GDPR erase).
-- `details_json` is free-form so a future endpoint can record the row
-- counts it actually deleted, the rejection reason, etc., without a
-- schema migration. ON DELETE SET NULL on admin_id so we keep the
-- history when an operator account is later removed.
CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL  PRIMARY KEY,
  action       TEXT    NOT NULL,
  admin_id     INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  target_kind  TEXT,
  target_id    TEXT,
  details_json TEXT,
  created_at   INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin_id ON audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC);

-- MTProto proxy list managed via /admin/ops. When non-empty, the userbot
-- subprocess reads from here instead of USERBOT_MTPROXY_LIST so the operator
-- can swap entries without redeploying. Each row preserves the original raw
-- input string (`raw`) for round-trip display in the admin UI alongside the
-- parsed fields. last_status + last_tried_at + last_error are updated by
-- the userbot subprocess after each connect attempt so the admin table can
-- show which entries are alive.
CREATE TABLE IF NOT EXISTS userbot_proxies (
  id              SERIAL  PRIMARY KEY,
  position        INTEGER NOT NULL,
  raw             TEXT    NOT NULL,
  parsed_host     TEXT    NOT NULL,
  parsed_port     INTEGER NOT NULL,
  parsed_secret   TEXT    NOT NULL,
  last_status     TEXT    NOT NULL DEFAULT 'never_tried'
    CHECK (last_status IN ('never_tried', 'ok', 'timeout', 'failed')),
  last_tried_at   INTEGER,
  last_error      TEXT,
  last_connect_ms INTEGER,
  created_at      INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);
CREATE INDEX IF NOT EXISTS idx_userbot_proxies_position ON userbot_proxies(position);
