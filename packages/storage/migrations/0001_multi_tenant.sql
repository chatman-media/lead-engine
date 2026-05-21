CREATE TABLE "channel_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"external_user_id" text NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"credentials_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata_json" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "channels_kind_check" CHECK ("channels"."kind" IN ('telegram_bot','telegram_userbot','whatsapp','web')),
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" IN ('active','paused','error'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"display_name" text,
	"attributes_json" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnels" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"slug" text NOT NULL,
	"vertical_template_id" text,
	"stages_json" text DEFAULT '[]' NOT NULL,
	"default_style_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_provider_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"secret_ref" text,
	"base_url" text,
	"embed_dim" integer,
	"timeout_ms" integer,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "llm_configs_purpose_check" CHECK ("llm_provider_configs"."purpose" IN ('chat','embed','vision','judge')),
	CONSTRAINT "llm_configs_provider_check" CHECK ("llm_provider_configs"."provider" IN ('openai','openrouter','ollama','anthropic'))
);
--> statement-breakpoint
CREATE TABLE "outbound_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"conversation_id" integer,
	"payload_json" text NOT NULL,
	"idempotency_key" text,
	"scheduled_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_message_id" text,
	"sent_at" integer,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "outbound_status_check" CHECK ("outbound_queue"."status" IN ('pending','sent','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tenant_secrets" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"llm_billing_mode" text DEFAULT 'byok' NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" IN ('active','suspended','deleted')),
	CONSTRAINT "tenants_llm_billing_check" CHECK ("tenants"."llm_billing_mode" IN ('byok','managed'))
);
--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_default_style_id_styles_id_fk" FOREIGN KEY ("default_style_id") REFERENCES "public"."styles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_provider_configs" ADD CONSTRAINT "llm_provider_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_queue" ADD CONSTRAINT "outbound_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_queue" ADD CONSTRAINT "outbound_queue_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_channel_identities_channel_external" ON "channel_identities" USING btree ("channel_id","external_user_id");--> statement-breakpoint
CREATE INDEX "idx_channel_identities_contact" ON "channel_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_channels_tenant_kind_external" ON "channels" USING btree ("tenant_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "idx_channels_tenant_status" ON "channels" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_contacts_tenant" ON "contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_funnels_tenant_slug" ON "funnels" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "idx_funnels_tenant_active" ON "funnels" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_llm_configs_tenant_purpose" ON "llm_provider_configs" USING btree ("tenant_id","purpose");--> statement-breakpoint
CREATE INDEX "idx_outbound_pending" ON "outbound_queue" USING btree ("status","scheduled_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_outbound_tenant_channel" ON "outbound_queue" USING btree ("tenant_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_outbound_idempotency" ON "outbound_queue" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tenant_secrets_key" ON "tenant_secrets" USING btree ("tenant_id","key");--> statement-breakpoint
-- Seed legacy tenant. В следующей миграции tenant_id колонка добавится во все
-- существующие таблицы с DEFAULT 1, и это даёт корректный FK target. Без этой
-- строки apps/bot (single-tenant deploy) сразу после прогона миграций
-- упадёт на INSERT в users из-за FK violation tenant_id=1.
INSERT INTO "tenants" ("id", "slug", "plan", "status", "llm_billing_mode")
  VALUES (1, 'legacy', 'free', 'active', 'byok')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
-- После INSERT id=1 нужно перевести sequence чтобы следующий tenant получил
-- id=2 (Postgres serial-sequence не сдвигается от ручных INSERT).
SELECT setval(pg_get_serial_sequence('tenants', 'id'), GREATEST(1, (SELECT MAX(id) FROM tenants)));