-- 0078_exchange_rate_proposals.sql
-- Pending-предложения обновления базового курса. Когда фид возвращает
-- курс с заметным отклонением (soft/hard порог) или включён тумблер
-- require_rate_confirmation, мы НЕ применяем новый baseRate к exchange_rates,
-- а ставим предложение в эту таблицу для подтверждения оператором.
--
-- Жёсткое отклонение (> hard) сохраняет прежнее поведение: rate_anomaly +
-- заморозка, плюс теперь — управляемый pending. Котировка (`computeQuote`)
-- продолжает читать exchangeRates.baseRate с фильтром is_active — то есть
-- бот автоматически котирует по СТАРОМУ курсу, пока админ не подтвердит.
--
-- Partial-unique на (tenant_id, asset, quote_asset, network) WHERE status='pending'
-- обеспечивает «один открытый pending на направление» — повторный фид-сэмпл
-- перетирает существующий (последний-выигрывает).

CREATE TABLE IF NOT EXISTS "exchange_rate_proposals" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "rate_id" integer REFERENCES "exchange_rates"("id") ON DELETE set null,
  "asset" text NOT NULL,
  "quote_asset" text NOT NULL,
  "network" text NOT NULL DEFAULT '',
  "quote_mode" text NOT NULL,
  "prev_base_rate" double precision NOT NULL,
  "next_base_rate" double precision NOT NULL,
  "deviation_pct" double precision NOT NULL,
  "severity" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "source" text NOT NULL DEFAULT 'feed',
  "decided_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "decided_at" integer,
  "created_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at" integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "exchange_rate_proposals_severity_check"
    CHECK ("severity" IN ('soft','hard')),
  CONSTRAINT "exchange_rate_proposals_status_check"
    CHECK ("status" IN ('pending','confirmed','rejected','superseded')),
  CONSTRAINT "exchange_rate_proposals_source_check"
    CHECK ("source" IN ('feed','manual')),
  CONSTRAINT "exchange_rate_proposals_quote_mode_check"
    CHECK ("quote_mode" IN ('multiply','divide')),
  CONSTRAINT "exchange_rate_proposals_quote_asset_check"
    CHECK ("quote_asset" ~ '^[A-Z]{3}$')
);

-- Один открытый pending на направление: повторный сэмпл фида перетирает
-- существующий через ON CONFLICT (см. upsertRateProposal).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exchange_rate_proposals_pending_dir"
  ON "exchange_rate_proposals" ("tenant_id", "asset", "quote_asset", "network")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "idx_exchange_rate_proposals_tenant_status"
  ON "exchange_rate_proposals" ("tenant_id", "status", "created_at" DESC);

ALTER TABLE "exchange_rate_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_rate_proposals" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'exchange_rate_proposals'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON "exchange_rate_proposals"
      USING (tenant_id = current_setting('app.tenant_id', true)::int)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::int);
  END IF;
END $$;

-- Тумблер «подтверждать обновлённые курсы оператором» для exchange_settings.
-- Дефолт false = back-compat: на тенантах без записи (или с false) фид как раньше
-- авто-применяет небольшие изменения. Если true — даже мелкие тики (dev < soft)
-- ставятся в pending.
ALTER TABLE "exchange_settings"
  ADD COLUMN IF NOT EXISTS "require_rate_confirmation" boolean NOT NULL DEFAULT false;
