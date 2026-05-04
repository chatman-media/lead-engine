-- Lead pipeline state machine. Each user can have at most one open lead
-- (UNIQUE on user_id) — closed leads are kept (state='closed' or 'rejected')
-- so operators have history. To reopen, hard-delete the closed row first.
--
-- States flow:
--   intake_pending     — bot collecting initial 7-item intake from the girl
--   intake_complete    — all intake fields received, lead card posted to
--                        LEADS_CHAT_ID, awaiting operator decision
--   approved           — operator approved; bot sent visa anketa to girl
--   rejected           — operator rejected; bot sent polite rejection
--   docs_pending       — visa form / passport photos being collected
--   docs_complete      — all visa docs collected, posted to VISA_CHAT_ID
--                        with auto-generated application_id; ready for
--                        operator to submit on the consulate side
--   submitted          — operator confirmed submission to the consulate
--   closed             — terminal state (lost / withdrew / done)
--
-- intake_json holds the structured intake fields (height, weight, photo
-- counts, city, departure date, …); visa_docs_json holds the long English
-- visa form. Both are JSON for flexibility — the schema is stored in the
-- application code (src/leads/templates.ts) where it can evolve without
-- migrations.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'intake_pending'
    CHECK (state IN (
      'intake_pending', 'intake_complete', 'approved', 'rejected',
      'docs_pending', 'docs_complete', 'submitted', 'closed'
    )),
  intake_json TEXT,
  visa_docs_json TEXT,
  -- Auto-generated when transitioning into docs_complete. Format:
  -- "VS-YYYY-NNNN" where NNNN is sequential. UNIQUE so we never collide.
  application_id TEXT UNIQUE,
  -- Telegram message id of the lead card we posted to LEADS_CHAT_ID.
  -- Used to edit the card in place when state changes (approve/reject).
  ops_chat_id INTEGER,
  ops_message_id INTEGER,
  rejected_reason TEXT,
  decided_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_leads_state_recency ON leads(state, updated_at DESC);
