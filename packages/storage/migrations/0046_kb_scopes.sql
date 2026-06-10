-- 0046_kb_scopes.sql
-- Scope KB documents and unanswered-question suggestions by funnel/stage.
-- Existing documents remain global by default.

ALTER TABLE "kb_documents"
  ADD COLUMN IF NOT EXISTS "scope_type" text NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS "funnel_id" integer,
  ADD COLUMN IF NOT EXISTS "stage_slug" text;

ALTER TABLE "kb_suggestions"
  ADD COLUMN IF NOT EXISTS "scope_type" text NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS "funnel_id" integer,
  ADD COLUMN IF NOT EXISTS "stage_slug" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kb_documents_scope_type_check'
  ) THEN
    ALTER TABLE "kb_documents"
      ADD CONSTRAINT "kb_documents_scope_type_check"
      CHECK ("scope_type" IN ('global','funnel','stage'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kb_documents_scope_shape_check'
  ) THEN
    ALTER TABLE "kb_documents"
      ADD CONSTRAINT "kb_documents_scope_shape_check"
      CHECK (
        ("scope_type" = 'global' AND "funnel_id" IS NULL AND "stage_slug" IS NULL)
        OR ("scope_type" = 'funnel' AND "funnel_id" IS NOT NULL AND "stage_slug" IS NULL)
        OR ("scope_type" = 'stage' AND "funnel_id" IS NOT NULL AND "stage_slug" IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kb_suggestions_scope_type_check'
  ) THEN
    ALTER TABLE "kb_suggestions"
      ADD CONSTRAINT "kb_suggestions_scope_type_check"
      CHECK ("scope_type" IN ('global','funnel','stage'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'kb_suggestions_scope_shape_check'
  ) THEN
    ALTER TABLE "kb_suggestions"
      ADD CONSTRAINT "kb_suggestions_scope_shape_check"
      CHECK (
        ("scope_type" = 'global' AND "funnel_id" IS NULL AND "stage_slug" IS NULL)
        OR ("scope_type" = 'funnel' AND "funnel_id" IS NOT NULL AND "stage_slug" IS NULL)
        OR ("scope_type" = 'stage' AND "funnel_id" IS NOT NULL AND "stage_slug" IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_kb_docs_scope"
  ON "kb_documents" ("tenant_id", "scope_type", "funnel_id", "stage_slug");

CREATE INDEX IF NOT EXISTS "idx_kb_suggestions_scope"
  ON "kb_suggestions" ("tenant_id", "scope_type", "funnel_id", "stage_slug", "created_at" DESC);
