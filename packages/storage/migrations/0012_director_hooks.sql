-- 0012_director_hooks.sql
-- Tenant-specific persuasion hooks that the bot always has access to.
-- Directors add domain-specific mini-scripts (e.g. "20% PDC now, rest installments")
-- without developer involvement.

CREATE TABLE director_hooks (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  trigger_hint TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at  INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE INDEX idx_director_hooks_tenant ON director_hooks (tenant_id, position);
CREATE INDEX idx_director_hooks_active ON director_hooks (tenant_id) WHERE is_active = TRUE;

-- RLS: tenant isolation
ALTER TABLE director_hooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON director_hooks;
CREATE POLICY tenant_isolation ON director_hooks
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::INTEGER);
