-- Unanswered questions → KB approval pipeline.
--
-- When the RAG engine returns NO_CONTEXT_MARKER the webhook creates a row here
-- so operators can review the question, draft an answer, and approve it into
-- the live KB. Status flow:
--
--   pending  →  ingested   (operator approved + ingest pipeline ran)
--   pending  →  rejected   (operator dismissed)
--
-- source_conversation_id / source_message_id are nullable so rows survive
-- conversation or message deletion.

CREATE TABLE IF NOT EXISTS kb_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_text TEXT NOT NULL,
  answer_draft TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ingested', 'rejected')),
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  decided_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  decided_at INTEGER,
  kb_document_id INTEGER REFERENCES kb_documents(id) ON DELETE SET NULL,
  rejected_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_kb_suggestions_status ON kb_suggestions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_suggestions_conv   ON kb_suggestions(source_conversation_id);
