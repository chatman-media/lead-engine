-- Lead pipeline audit trail. Every state transition + the lead's own
-- creation moment + application_id allocation get a row here so the
-- admin UI can show a timeline and operators can answer "когда я
-- одобрил этого лида?" / "почему отклонили?" / "какой application id
-- мы выдали?" without combing through the conversation log.
--
-- One row per event, ordered by `created_at`. Lead's CURRENT state still
-- lives on `leads.state` — this table is append-only history. Cascade
-- delete on lead removal: an archived lead's history goes with it.

CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- NULL on the synthetic "created" event (no prior state).
  from_state TEXT,
  -- Always populated. Same enum as leads.state.
  to_state TEXT NOT NULL,
  -- Admin who triggered the transition. NULL for auto-transitions
  -- (auto-promote on intake completion, auto-extract advancing
  -- internal flags, callback_query approves where we don't know
  -- which admin id maps to the TG-from id, etc.).
  by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  -- Free-form details. Used for: rejection_reason on rejected,
  -- application_id on docs_complete, etc. NULL when nothing
  -- noteworthy.
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead_recency
  ON lead_events(lead_id, created_at);
