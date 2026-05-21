ALTER TABLE "admins" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_suggestions" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_events" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pairwise_matches" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "questionnaire_tokens" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "self_play_matches" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shadow_evaluations" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "style_ratings" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "style_skills" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "styles" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "userbot_delete_queue" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "userbot_send_queue" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "userbot_session" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancies" ADD COLUMN "tenant_id" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_suggestions" ADD CONSTRAINT "kb_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairwise_matches" ADD CONSTRAINT "pairwise_matches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_tokens" ADD CONSTRAINT "questionnaire_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_play_matches" ADD CONSTRAINT "self_play_matches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_evaluations" ADD CONSTRAINT "shadow_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD CONSTRAINT "skill_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_ratings" ADD CONSTRAINT "style_ratings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_skills" ADD CONSTRAINT "style_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "styles" ADD CONSTRAINT "styles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userbot_delete_queue" ADD CONSTRAINT "userbot_delete_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userbot_send_queue" ADD CONSTRAINT "userbot_send_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userbot_session" ADD CONSTRAINT "userbot_session_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;