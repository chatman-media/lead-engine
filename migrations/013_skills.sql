-- Skill catalogue + per-style enabled set.
--
-- A "skill" is a composable persuasion / sales technique with a research-
-- backed lineage (Cialdini, Voss, NLP, classic sales, custom). Each skill
-- carries a prompt fragment that gets injected into the system prompt
-- when the operator enables it on a Style.
--
-- Catalogue rows are seeded from src/sales/skills/catalogue.ts on boot
-- via `seedSkills` (similar to seedBuiltinStyles). Operators can disable
-- a skill globally (`is_enabled=0`) or attach skills to specific styles
-- via the `style_skills` join table.
--
-- This migration is forward-only by design: the seeder upserts on `slug`,
-- so editing the catalogue file and re-deploying refreshes copy without
-- a destructive migration.

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,            -- "cialdini" | "voss" | "nlp" | "sales" | "custom"
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt_fragment TEXT NOT NULL,   -- inserted into system prompt
  applicable_stages_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of FunnelStage slugs
  intent TEXT NOT NULL,            -- e.g. "build_rapport"
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_skills_family ON skills(family);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(is_enabled) WHERE is_enabled = 1;

-- Many-to-many: which skills a style exposes to the LLM.
CREATE TABLE IF NOT EXISTS style_skills (
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (style_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_style_skills_skill ON style_skills(skill_id);
