CREATE TABLE IF NOT EXISTS "message_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "body" text NOT NULL,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_message_templates_tenant" ON "message_templates" ("tenant_id");
