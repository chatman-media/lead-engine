-- Operator-facing notes on a lead. Distinct from `rejected_reason`
-- (which is one slot tied to the reject decision) and from
-- `lead_events` (which is auto-logged state transitions). Notes are
-- free-form operator commentary added at any lead state — "сомневается
-- по визовому сбору", "перезвонить в понедельник", "контрактом
-- интересовался, но требует свидетельство о незамужестве".
--
-- Multiple per lead, ordered by creation time. ON DELETE CASCADE on
-- the lead row — archived leads' notes go with them. Admin author
-- recorded so the timeline shows who wrote what; SET NULL on admin
-- deletion so removing an operator account doesn't drop their notes.

CREATE TABLE IF NOT EXISTS lead_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_recency
  ON lead_notes(lead_id, created_at DESC);
