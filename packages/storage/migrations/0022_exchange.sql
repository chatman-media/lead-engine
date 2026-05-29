-- 0022_exchange.sql
-- Обменный пункт: курсы+формула (exchange_rates) и заявки на обмен (exchange_orders).
-- Оборот (turnover) считается агрегатом по exchange_orders.amount_to_thb (нормализовано в THB),
-- отдельной таблицы не требуется.
--
-- ЖЁСТКИЕ ПРАВИЛА проектирования:
--   - rate (курс) и amount_to_thb фиксируются СНАПШОТОМ на момент создания заявки.
--   - rate_expires_at — TTL котировки/реквизитов (15-20 мин), после — перекотировка.
--   - idempotency_key уникален → защита от дублей при мультицикловом tool-loop.
--   - RLS ENABLE+FORCE как у прочих tenant-scoped таблиц (см. 0004).

-- ── Курсы и формулы ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "exchange_rates" (
  "id"                serial PRIMARY KEY NOT NULL,
  "tenant_id"         integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  -- актив-источник: USDT/BTC/ETH/RUB/EUR/USD
  "asset"             text NOT NULL,
  -- целевой актив (по умолчанию THB)
  "quote_asset"       text NOT NULL DEFAULT 'THB',
  -- сеть для крипты (trc20/erc20/bep20); '' = не применимо (фиат)
  "network"           text NOT NULL DEFAULT '',
  -- базовый рыночный курс. Семантика зависит от quote_mode.
  "base_rate"         double precision NOT NULL,
  -- как считать THB и применять маржу:
  --   'multiply' (крипта): rate = THB за 1 единицу asset; thb = amount * rate;
  --                        маржа уменьшает курс: eff = base * (1 - margin/100)
  --   'divide'   (RUB):    rate = RUB за 1 THB; thb = amount / rate;
  --                        маржа увеличивает курс: eff = base * (1 + margin/100)
  "quote_mode"        text NOT NULL DEFAULT 'multiply',
  -- маржа обменника в % (спред в пользу обменника)
  "margin_pct"        double precision NOT NULL DEFAULT 0,
  -- фиксированная комиссия в THB, вычитается из итога
  "fee_fixed_thb"     double precision NOT NULL DEFAULT 0,
  -- лимиты суммы-источника (для risk-чека); NULL = без лимита
  "min_amount_from"   double precision,
  "max_amount_from"   double precision,
  "is_active"         boolean NOT NULL DEFAULT true,
  -- если true — base_rate перезаписывается рыночным фидом (worker RateFeedSweeper);
  -- margin_pct/fee остаются ручными (спред обменника)
  "auto_update"       boolean NOT NULL DEFAULT false,
  "updated_by_admin_id" integer REFERENCES "admins"("id") ON DELETE set null,
  "created_at"        integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at"        integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exchange_rates_dir"
  ON "exchange_rates" ("tenant_id", "asset", "quote_asset", "network");
CREATE INDEX IF NOT EXISTS "idx_exchange_rates_tenant_active"
  ON "exchange_rates" ("tenant_id", "is_active");

-- ── Заявки на обмен ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "exchange_orders" (
  "id"               serial PRIMARY KEY NOT NULL,
  "tenant_id"        integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  -- кто менял
  "contact_id"       integer REFERENCES "contacts"("id") ON DELETE set null,
  "conversation_id"  integer REFERENCES "conversations"("id") ON DELETE set null,
  "lead_id"          integer REFERENCES "leads"("id") ON DELETE set null,
  -- Telegram ID клиента (явно, для CRM)
  "telegram_id"      text,
  -- внутренний номер верификации (CRM верификации); проставляет оператор после видео-проверки
  "verification_id"  text,
  -- направление, напр. 'USDT->THB'
  "direction"        text NOT NULL,
  "asset_from"       text NOT NULL,
  "network"          text NOT NULL DEFAULT '',
  "amount_from"      double precision NOT NULL,
  -- СНАПШОТ курса и итога на момент заявки
  "rate"             double precision NOT NULL,
  "amount_to_thb"    double precision NOT NULL,
  -- способ выдачи: office | atm
  "payout_method"    text,
  "payout_location"  text,
  "payout_code"      text,
  -- FSM статус заявки
  "status"           text NOT NULL DEFAULT 'quote',
  -- что выдали клиенту: { kind:'crypto'|'fiat', address?, network?, paymentUrl?, provider? }
  "requisites_json"  text,
  -- данные пруфа: { txHash?, fromAddress?, amount?, receipt? } (req 16 — источник перевода)
  "proof_json"       text,
  -- результат risk-чека: { ok, reasons[], aml? }
  "risk_json"        text,
  -- TTL котировки/реквизитов (epoch seconds)
  "rate_expires_at"  integer,
  -- идемпотентность создания заявки (ключ = conversation+quote)
  "idempotency_key"  text,
  -- напоминание о незавершённой оплате (последний пинг)
  "last_reminder_at" integer,
  "completed_at"     integer,
  "created_at"       integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  "updated_at"       integer NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  CONSTRAINT "exchange_orders_status_check" CHECK (
    "status" IN ('quote','awaiting_payment','paid','payout','completed','cancelled','expired')
  )
);

-- Полный UNIQUE (не частичный): нужен как ON CONFLICT arbiter. NULL в Postgres
-- считаются различными, поэтому несколько заявок без ключа допустимы.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_exchange_orders_idem"
  ON "exchange_orders" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_exchange_orders_tenant_status"
  ON "exchange_orders" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_exchange_orders_tenant_contact"
  ON "exchange_orders" ("tenant_id", "contact_id");
CREATE INDEX IF NOT EXISTS "idx_exchange_orders_tenant_created"
  ON "exchange_orders" ("tenant_id", "created_at");
-- для payment-TTL sweeper: открытые заявки с истёкшим TTL
CREATE INDEX IF NOT EXISTS "idx_exchange_orders_awaiting_ttl"
  ON "exchange_orders" ("status", "rate_expires_at") WHERE "status" = 'awaiting_payment';

-- ── RLS (ENABLE + FORCE + tenant_isolation), как в 0004 ──────────────────────
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY['exchange_rates', 'exchange_orders'];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', TRUE)::INTEGER) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', TRUE)::INTEGER)',
      tbl
    );
  END LOOP;
END $$;
