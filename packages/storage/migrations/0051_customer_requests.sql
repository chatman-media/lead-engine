-- 0051_customer_requests.sql
-- First-class customer request/ticket model for multi-request funnels.

CREATE TABLE IF NOT EXISTS "customer_requests" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "contact_id" integer NOT NULL REFERENCES "contacts"("id") ON DELETE cascade,
  "conversation_id" integer REFERENCES "conversations"("id") ON DELETE set null,
  "lead_id" integer REFERENCES "leads"("id") ON DELETE set null,
  "funnel_id" integer REFERENCES "funnels"("id") ON DELETE set null,
  "stage_definition_id" integer REFERENCES "stage_definitions"("id") ON DELETE set null,
  "request_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "title" text,
  "summary" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "closed_at" integer,
  CONSTRAINT "customer_requests_status_check"
    CHECK ("status" IN ('open','won','lost','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_requests_lead"
  ON "customer_requests" ("tenant_id", "lead_id")
  WHERE "lead_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_customer_requests_contact_status"
  ON "customer_requests" ("tenant_id", "contact_id", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_customer_requests_stage"
  ON "customer_requests" ("tenant_id", "stage_definition_id");

CREATE INDEX IF NOT EXISTS "idx_customer_requests_conversation"
  ON "customer_requests" ("tenant_id", "conversation_id");

INSERT INTO "customer_requests" (
  "tenant_id",
  "contact_id",
  "lead_id",
  "funnel_id",
  "stage_definition_id",
  "request_type",
  "status",
  "title",
  "created_at",
  "updated_at",
  "closed_at"
)
SELECT
  l."tenant_id",
  l."user_id",
  l."id",
  sd."funnel_id",
  l."stage_definition_id",
  l."request_type",
  CASE
    WHEN sd."kind" = 'terminal_won' THEN 'won'
    WHEN sd."kind" = 'terminal_lost' THEN 'lost'
    ELSE 'open'
  END,
  l."request_type",
  l."created_at",
  l."updated_at",
  CASE
    WHEN sd."kind" IN ('terminal_won','terminal_lost') THEN l."updated_at"
    ELSE NULL
  END
FROM "leads" l
LEFT JOIN "stage_definitions" sd ON sd."id" = l."stage_definition_id"
WHERE l."request_type" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "customer_requests" cr
    WHERE cr."tenant_id" = l."tenant_id"
      AND cr."lead_id" = l."id"
  );

ALTER TABLE "customer_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_requests" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'customer_requests'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "customer_requests"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;
