-- Hybrid retrieval: BM25 keyword index alongside the existing kb_vec table.
-- Vector search alone misses exact-match queries — when the candidate writes
-- "виза 30 дней", BM25 nails it instantly while the embedding may rank a
-- generic "сроки контракта" chunk higher. We keep both indexes and fuse
-- their rankings via reciprocal rank fusion at query time (see KbRepo).
--
-- Tokenizer: `unicode61 remove_diacritics 2` is the right choice for mixed
-- Russian + English content. It lowercases, splits on Unicode word
-- boundaries (so Cyrillic word ends actually work — JS `\b` doesn't, but
-- FTS5 does), and folds diacritics so "Стамбул" matches "стамбул".
--
-- We use external-content mode so the FTS table doesn't duplicate `text`
-- bytes — it just indexes them. Triggers below keep it in sync with the
-- canonical `kb_chunks` table on insert/update/delete.

CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  text,
  content='kb_chunks',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Backfill existing rows. No-op when the table is empty (fresh install) or
-- when the FTS table already has content (re-running this migration would
-- be impossible due to IF NOT EXISTS on the virtual table itself, but the
-- INSERT below is idempotent against the chunk id either way).
INSERT INTO kb_chunks_fts(rowid, text)
  SELECT id, text FROM kb_chunks
  WHERE id NOT IN (SELECT rowid FROM kb_chunks_fts);

-- Sync triggers. External-content FTS tables don't auto-update — we have to
-- mirror writes manually. Without these, ingest would silently leave the
-- BM25 index stale and hybrid search would return only vector hits for new
-- chunks.

CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_fts_au AFTER UPDATE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
