-- 0049_kb_document_files.sql
-- Store original KB upload files on the application server and keep metadata
-- on kb_documents. Existing documents remain valid with NULL file fields.

ALTER TABLE "kb_documents"
  ADD COLUMN IF NOT EXISTS "file_storage_key" text,
  ADD COLUMN IF NOT EXISTS "file_name" text,
  ADD COLUMN IF NOT EXISTS "file_mime_type" text,
  ADD COLUMN IF NOT EXISTS "file_size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "file_uploaded_at" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kb_documents_file_size_check'
  ) THEN
    ALTER TABLE "kb_documents"
      ADD CONSTRAINT "kb_documents_file_size_check"
      CHECK ("file_size_bytes" IS NULL OR "file_size_bytes" >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_docs_file_storage_key"
  ON "kb_documents" ("file_storage_key")
  WHERE "file_storage_key" IS NOT NULL;
