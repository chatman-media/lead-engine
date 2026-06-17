---
name: new-migration
description: Scaffold a new database migration for packages/storage following the project's hand-written idempotent-SQL convention. Use when adding a column, table, index, or backfill to the schema.
disable-model-invocation: true
---

# /new-migration — add a storage migration

Migrations are **hand-written idempotent SQL**, applied in filename order by
`apps/api/scripts/reset-and-migrate.ts` (NOT `drizzle-kit generate` — the drizzle
journal is legacy, frozen at 0007).

## Steps
1. **Pick the next number.** Files live in `packages/storage/migrations/` as
   `NNNN_snake_case_description.sql` (4-digit, zero-padded). Next = highest + 1:
   ```bash
   ls packages/storage/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -1
   ```
2. **Write idempotent SQL** with a short comment header (what + why + idempotency
   note), in the style of existing migrations:
   ```sql
   -- <Что меняем и зачем>. Идемпотентно (ADD COLUMN IF NOT EXISTS).
   ALTER TABLE my_table
     ADD COLUMN IF NOT EXISTS my_col text NOT NULL DEFAULT '...';
   ```
   Always use `IF NOT EXISTS` / `IF EXISTS` — the runner re-applies on a clean DB
   and the integration test applies the whole stack.
3. **Mirror it in `packages/storage/src/schema.ts`** (drizzle-orm schema) so
   queries see the new column/table. SQL and schema.ts must agree.
4. **Backfill in the same migration** if existing rows need a computed value
   (don't rely only on DEFAULT when logic is involved).
5. **Verify:**
   ```bash
   bun db:reset                          # applies all migrations from scratch
   bun run --cwd packages/storage test   # migrations.integration.test.ts invariants
   bun run typecheck
   ```

## Rules
- **Never edit a migration already applied** on any shared DB. To fix one, write a
  NEW higher-numbered migration (the runner keys off filename + `_migrations`).
- Tenant-owned tables: add tenant scoping / RLS policy in the same migration,
  consistent with sibling tables.
- Migrations are forward-only and idempotent.
