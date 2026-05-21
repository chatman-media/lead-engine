-- Stripe billing-таблицы. Tenant ↔ Customer 1:1; Customer 1:N Subscription
-- (история; active — одна). Webhook'и Stripe'а пишут в эту схему;
-- apps/api admin-endpoints читают tenant'овский plan.
--
-- RLS включён в одном statement'е в конце — соответствует pattern'у 0004.

CREATE TABLE "stripe_customers" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "stripe_customer_id" text NOT NULL,
  "email" text,
  "created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
  "updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
  CONSTRAINT "stripe_customers_tenant_unique" UNIQUE("tenant_id"),
  CONSTRAINT "stripe_customers_external_unique" UNIQUE("stripe_customer_id")
);--> statement-breakpoint
CREATE INDEX "idx_stripe_customers_tenant" ON "stripe_customers" ("tenant_id");--> statement-breakpoint

CREATE TABLE "stripe_subscriptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_price_id" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" integer,
  "current_period_end" integer,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "metadata_json" text,
  "created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
  "updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
  CONSTRAINT "stripe_subscriptions_external_unique" UNIQUE("stripe_subscription_id"),
  CONSTRAINT "stripe_subscriptions_status_check"
    CHECK ("status" IN ('incomplete','incomplete_expired','trialing','active',
                        'past_due','canceled','unpaid','paused'))
);--> statement-breakpoint
CREATE INDEX "idx_stripe_subscriptions_tenant" ON "stripe_subscriptions" ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_subscriptions_status" ON "stripe_subscriptions" ("status");--> statement-breakpoint

-- Idempotency для webhook'ов: Stripe shлёт каждое event как минимум раз,
-- иногда дублирует на retry — храним event.id чтобы skip уже-обработанное.
CREATE TABLE "stripe_webhook_events" (
  "stripe_event_id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "tenant_id" integer REFERENCES "tenants"("id") ON DELETE SET NULL,
  "processed_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
  "raw_payload" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "idx_stripe_webhook_events_type" ON "stripe_webhook_events" ("type", "processed_at" DESC);--> statement-breakpoint

-- RLS — same pattern что 0004. Stripe-таблицы видны только своему tenant'у.
ALTER TABLE "stripe_customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_customers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stripe_customers"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::int)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::int);--> statement-breakpoint

ALTER TABLE "stripe_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "stripe_subscriptions"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::int)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::int);
-- stripe_webhook_events НЕ покрыта RLS — это global audit-log; webhook
-- handler работает под superuser-role для записи событий разных tenant'ов.
