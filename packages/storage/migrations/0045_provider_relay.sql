-- 0045_provider_relay.sql
-- Cross-channel provider relay: providers, brokered service orders, provider
-- request attempts, and append-only order events.

CREATE TABLE IF NOT EXISTS "provider_profiles" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "contact_id" integer NOT NULL REFERENCES "contacts"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "category" text,
  "status" text NOT NULL DEFAULT 'active',
  "service_area" text,
  "default_commission_pct" double precision NOT NULL DEFAULT 0,
  "notes" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "provider_profiles_status_check"
    CHECK ("status" IN ('active','paused','archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_profiles_contact"
  ON "provider_profiles" ("tenant_id", "contact_id");
CREATE INDEX IF NOT EXISTS "idx_provider_profiles_tenant_status"
  ON "provider_profiles" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_provider_profiles_category"
  ON "provider_profiles" ("tenant_id", "category");

CREATE TABLE IF NOT EXISTS "provider_services" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "provider_id" integer NOT NULL REFERENCES "provider_profiles"("id") ON DELETE cascade,
  "service_type" text NOT NULL,
  "name" text NOT NULL,
  "service_area" text,
  "pricing_policy_json" text NOT NULL DEFAULT '{}',
  "commission_pct" double precision,
  "is_active" boolean NOT NULL DEFAULT true,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_services_name"
  ON "provider_services" ("tenant_id", "provider_id", "service_type", "name");
CREATE INDEX IF NOT EXISTS "idx_provider_services_tenant_active"
  ON "provider_services" ("tenant_id", "is_active");
CREATE INDEX IF NOT EXISTS "idx_provider_services_type"
  ON "provider_services" ("tenant_id", "service_type", "is_active");

CREATE TABLE IF NOT EXISTS "service_orders" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "customer_contact_id" integer NOT NULL REFERENCES "contacts"("id") ON DELETE cascade,
  "customer_conversation_id" integer REFERENCES "conversations"("id") ON DELETE set null,
  "lead_id" integer REFERENCES "leads"("id") ON DELETE set null,
  "assigned_provider_id" integer REFERENCES "provider_profiles"("id") ON DELETE set null,
  "request_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'intake',
  "summary" text,
  "quoted_amount" double precision,
  "customer_amount" double precision,
  "commission_pct" double precision,
  "commission_amount" double precision,
  "currency" text NOT NULL DEFAULT 'THB',
  "payment_status" text NOT NULL DEFAULT 'unpaid',
  "payment_provider" text,
  "payment_ref" text,
  "idempotency_key" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "expires_at" integer,
  "confirmed_at" integer,
  "completed_at" integer,
  "cancelled_at" integer,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "service_orders_status_check"
    CHECK ("status" IN ('intake','matching','awaiting_provider','provider_declined','offer_ready','awaiting_customer_payment','paid','confirmed','fulfilled','cancelled','failed')),
  CONSTRAINT "service_orders_payment_status_check"
    CHECK ("payment_status" IN ('unpaid','pending','paid','refunded','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_service_orders_idem"
  ON "service_orders" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_service_orders_tenant_status"
  ON "service_orders" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_service_orders_customer"
  ON "service_orders" ("tenant_id", "customer_contact_id");
CREATE INDEX IF NOT EXISTS "idx_service_orders_lead"
  ON "service_orders" ("tenant_id", "lead_id");
CREATE INDEX IF NOT EXISTS "idx_service_orders_provider"
  ON "service_orders" ("tenant_id", "assigned_provider_id");
CREATE INDEX IF NOT EXISTS "idx_service_orders_payment"
  ON "service_orders" ("tenant_id", "payment_status");

CREATE TABLE IF NOT EXISTS "provider_requests" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "order_id" integer NOT NULL REFERENCES "service_orders"("id") ON DELETE cascade,
  "provider_id" integer REFERENCES "provider_profiles"("id") ON DELETE set null,
  "provider_conversation_id" integer REFERENCES "conversations"("id") ON DELETE set null,
  "channel_id" integer REFERENCES "channels"("id") ON DELETE set null,
  "outbound_queue_id" integer REFERENCES "outbound_queue"("id") ON DELETE set null,
  "status" text NOT NULL DEFAULT 'draft',
  "quoted_amount" double precision,
  "customer_amount" double precision,
  "commission_amount" double precision,
  "currency" text NOT NULL DEFAULT 'THB',
  "available_at" integer,
  "quote_expires_at" integer,
  "response_text" text,
  "idempotency_key" text,
  "metadata_json" text NOT NULL DEFAULT '{}',
  "sent_at" integer,
  "responded_at" integer,
  "expired_at" integer,
  "cancelled_at" integer,
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  "updated_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "provider_requests_status_check"
    CHECK ("status" IN ('draft','sent','seen','quoted','accepted','declined','expired','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_provider_requests_idem"
  ON "provider_requests" ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_provider_requests_order"
  ON "provider_requests" ("tenant_id", "order_id");
CREATE INDEX IF NOT EXISTS "idx_provider_requests_provider_status"
  ON "provider_requests" ("tenant_id", "provider_id", "status");
CREATE INDEX IF NOT EXISTS "idx_provider_requests_tenant_status"
  ON "provider_requests" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "idx_provider_requests_quote_ttl"
  ON "provider_requests" ("status", "quote_expires_at")
  WHERE "status" = 'quoted';

CREATE TABLE IF NOT EXISTS "order_events" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "order_id" integer NOT NULL REFERENCES "service_orders"("id") ON DELETE cascade,
  "provider_request_id" integer REFERENCES "provider_requests"("id") ON DELETE set null,
  "conversation_id" integer REFERENCES "conversations"("id") ON DELETE set null,
  "message_id" integer REFERENCES "messages"("id") ON DELETE set null,
  "actor_type" text NOT NULL DEFAULT 'system',
  "event_type" text NOT NULL,
  "data_json" text NOT NULL DEFAULT '{}',
  "created_at" integer NOT NULL DEFAULT (extract(epoch from now()))::int,
  CONSTRAINT "order_events_actor_type_check"
    CHECK ("actor_type" IN ('system','customer','provider','operator','payment'))
);

CREATE INDEX IF NOT EXISTS "idx_order_events_order_created"
  ON "order_events" ("tenant_id", "order_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_order_events_provider_request"
  ON "order_events" ("tenant_id", "provider_request_id");
CREATE INDEX IF NOT EXISTS "idx_order_events_type"
  ON "order_events" ("tenant_id", "event_type");

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'provider_profiles',
    'provider_services',
    'service_orders',
    'provider_requests',
    'order_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = tbl
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I ' ||
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::int) ' ||
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::int)',
        tbl
      );
    END IF;
  END LOOP;
END $$;
