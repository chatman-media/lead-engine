ALTER TABLE lead_notes ADD COLUMN source TEXT;
CREATE INDEX IF NOT EXISTS lead_notes_source ON lead_notes(lead_id, source);
