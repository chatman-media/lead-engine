# Archived migrations

These numbered migrations (`001_*.sql` … `022_*.sql`) are the historical trail
of schema changes before they were consolidated into the top-level
`pg_schema.sql` (applied idempotently on every boot — see
`src/db/migrate.ts`). They are **not executed** by the runtime.

**Do not add new files here.** When changing the schema, edit
`migrations/pg_schema.sql` directly using `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` patterns so it stays idempotent.

Kept only for audit — to understand the order in which features landed and
why a column exists.
