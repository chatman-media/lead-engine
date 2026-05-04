-- Topic-routed retrieval: optional per-document topic tag enables narrow
-- vector / BM25 search when the question's topic can be classified
-- deterministically. KB scaling pain: when one global index has visa info
-- + payment info + city info, embeddings get crowded — "виза 30 дней"
-- might rank a generic "сроки контракта" chunk above the actual visa
-- chunk because the embedding space is dominated by shared vocabulary.
--
-- Tagging at ingest time + filter at query time isolates the noisy cases
-- without changing the storage layer (still one kb_chunks/kb_vec table).
-- NULL topic = "no tag" = always returned regardless of routing filter
-- (so legacy untagged corpora keep working as before).

ALTER TABLE kb_documents ADD COLUMN topic TEXT;

-- Helps WHERE topic = ? filters; partial index keeps it cheap because
-- most rows have a topic once you start tagging.
CREATE INDEX IF NOT EXISTS idx_kb_docs_topic
  ON kb_documents(topic)
  WHERE topic IS NOT NULL;
