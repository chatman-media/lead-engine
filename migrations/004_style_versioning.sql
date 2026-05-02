-- Phase 2b+ of the sales-style engine: inline style editing in the admin UI.
--
-- Phase 2a / 2b stored styles with `slug TEXT UNIQUE` — fine for seeding +
-- A/B routing, useless for editing. The moment you "edit" a style, every
-- running conversation that has `conversations.style_id = old.id` would
-- silently shift to the new prompt mid-funnel. Bad: prospects who started
-- with a flirty opener could end up qualified by an empathetic bot.
--
-- The fix is a version chain. On save:
--   1. INSERT a new row with version+1, parent_id=old.id, same slug.
--   2. UPDATE old row SET is_active=0.
--   3. New conversations resolve via bySlug() which only returns is_active=1.
--   4. Existing conversations keep their `style_id` pointer to the OLD row,
--      so the prompt they see stays pinned for the lifetime of the chat.
--
-- For that to work the table needs:
--   - No UNIQUE(slug) — multiple historical versions share the slug.
--   - Partial UNIQUE on slug WHERE is_active=1 — exactly one current version.
--   - UNIQUE(slug, version) — each (slug, version) tuple is unique.
--
-- SQLite can't ALTER TABLE DROP CONSTRAINT, so we recreate the table.
-- defer_foreign_keys=1 lets us do this inside the migration transaction
-- without conversations.style_id FK breaking when we DROP/RENAME.

PRAGMA defer_foreign_keys = 1;

CREATE TABLE styles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  parent_id INTEGER REFERENCES styles_new(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO styles_new (id, slug, display_name, config_json, is_active, version, parent_id, created_at)
  SELECT id, slug, display_name, config_json, is_active, version, parent_id, created_at
  FROM styles;

DROP TABLE styles;
ALTER TABLE styles_new RENAME TO styles;

-- Replaces the old UNIQUE(slug). Per-version uniqueness for the chain.
CREATE UNIQUE INDEX uniq_styles_slug_version ON styles(slug, version);
-- Exactly one active version per slug. Prevents two rows from racing to
-- become the live one if an admin double-clicks save.
CREATE UNIQUE INDEX uniq_styles_active_slug ON styles(slug) WHERE is_active = 1;
-- Original index from migration 003.
CREATE INDEX idx_styles_active ON styles(is_active);
