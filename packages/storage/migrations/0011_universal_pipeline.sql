-- Migration 0011: Universal lead pipeline
-- Adds dynamic stage/field tables; removes hardcoded state CHECK on leads.

-- ── stage_definitions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stage_definitions (
  id                      SERIAL PRIMARY KEY,
  tenant_id               INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  funnel_id               INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  slug                    TEXT    NOT NULL,
  display_name            TEXT    NOT NULL,
  description             TEXT,
  position                INTEGER NOT NULL DEFAULT 0,
  kind                    TEXT    NOT NULL DEFAULT 'active'
                            CHECK (kind IN ('intake','active','terminal_won','terminal_lost')),
  stage_type              TEXT    NOT NULL DEFAULT 'form_fill'
                            CHECK (stage_type IN (
                              'form_fill','document_upload','document_signature',
                              'external_approval','payment','waiting',
                              'interaction','assessment','milestone'
                            )),
  config_json             TEXT    NOT NULL DEFAULT '{}',
  next_stages             TEXT[]  NOT NULL DEFAULT '{}',
  auto_advance_condition  TEXT,
  stale_timeout_days      INTEGER,
  checkin_interval_days   INTEGER,
  support_mode            BOOLEAN NOT NULL DEFAULT FALSE,
  color                   TEXT,
  icon                    TEXT,
  created_at              INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at              INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  UNIQUE (funnel_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_stage_def_funnel_pos ON stage_definitions(funnel_id, position);

-- RLS
ALTER TABLE stage_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stage_definitions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::INTEGER);

-- ── stage_fields ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stage_fields (
  id            SERIAL PRIMARY KEY,
  stage_id      INTEGER NOT NULL REFERENCES stage_definitions(id) ON DELETE CASCADE,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  field_type    TEXT    NOT NULL DEFAULT 'text'
                  CHECK (field_type IN (
                    'text','textarea','number','date',
                    'select','multiselect','boolean',
                    'phone','email','file','photo'
                  )),
  required      BOOLEAN NOT NULL DEFAULT FALSE,
  position      INTEGER NOT NULL DEFAULT 0,
  options_json  TEXT    NOT NULL DEFAULT '[]',
  validation_json TEXT  NOT NULL DEFAULT '{}',
  hint          TEXT,
  ai_extractable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  UNIQUE (stage_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_stage_fields_stage_pos ON stage_fields(stage_id, position);

ALTER TABLE stage_fields ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stage_fields
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::INTEGER);

-- ── leads: drop hardcoded state check, add stage_definition_id ───────────────
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_state_check;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS stage_definition_id INTEGER
    REFERENCES stage_definitions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_stage_def ON leads(stage_definition_id)
  WHERE stage_definition_id IS NOT NULL;

-- ── lead_field_values ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_field_values (
  id                  SERIAL PRIMARY KEY,
  lead_id             INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  field_id            INTEGER NOT NULL REFERENCES stage_fields(id) ON DELETE CASCADE,
  tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  value_json          TEXT    NOT NULL DEFAULT 'null',
  updated_at          INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  UNIQUE (lead_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_field_values_lead ON lead_field_values(lead_id);

ALTER TABLE lead_field_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_field_values
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::INTEGER);
