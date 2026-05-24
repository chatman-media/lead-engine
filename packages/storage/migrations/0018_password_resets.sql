CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" serial PRIMARY KEY NOT NULL,
  "admin_id" integer NOT NULL REFERENCES "admins"("id") ON DELETE cascade,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" integer NOT NULL,
  "used_at" integer,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_password_resets_token_hash" ON "password_resets" ("token_hash");
CREATE INDEX IF NOT EXISTS "idx_password_resets_admin" ON "password_resets" ("admin_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_password_resets_admin_active"
  ON "password_resets" ("admin_id")
  WHERE "used_at" IS NULL;
