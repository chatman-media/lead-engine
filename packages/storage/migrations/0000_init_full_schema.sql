-- Расширение для pgvector. Должно быть до CREATE TABLE kb_chunks.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "admins" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'superadmin' NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"admin_id" integer,
	"target_kind" text,
	"target_id" text,
	"details_json" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"style_slug" text NOT NULL,
	"sample_size" integer NOT NULL,
	"persona_filter" text,
	"summary" text NOT NULL,
	"edits_json" text NOT NULL,
	"rationale_json" text NOT NULL,
	"raw_output" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"decided_at" integer,
	"decided_by_admin_id" integer,
	CONSTRAINT "coach_proposals_status_check" CHECK ("coach_proposals"."status" IN ('pending','applied','dismissed'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source" text DEFAULT 'bot' NOT NULL,
	"mode" text DEFAULT 'ai' NOT NULL,
	"escalated_at" integer,
	"assigned_admin_id" integer,
	"last_message_at" integer,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"style_id" integer,
	"experiment_id" integer,
	"current_stage" text,
	"summary_json" text,
	"meta_json" text,
	CONSTRAINT "conversations_source_check" CHECK ("conversations"."source" IN ('bot', 'userbot', 'self_play')),
	CONSTRAINT "conversations_mode_check" CHECK ("conversations"."mode" IN ('ai', 'queued', 'human'))
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"allocation_json" text NOT NULL,
	"success_metric" text DEFAULT 'qualified' NOT NULL,
	"started_at" integer,
	"ended_at" integer,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "experiments_slug_unique" UNIQUE("slug"),
	CONSTRAINT "experiments_status_check" CHECK ("experiments"."status" IN ('draft', 'running', 'paused', 'done')),
	CONSTRAINT "experiments_success_metric_check" CHECK ("experiments"."success_metric" IN ('qualified', 'won', 'replied_3+'))
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	-- Колонка fts создаётся как GENERATED ALWAYS — см. ALTER ниже,
	-- drizzle-kit не умеет declarative generated tsvector.
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunks"
  ADD COLUMN "fts" tsvector
  GENERATED ALWAYS AS (to_tsvector('russian', coalesce("text", ''))) STORED;
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"content_hash" text NOT NULL,
	"topic" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"question_text" text NOT NULL,
	"answer_draft" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_conversation_id" integer,
	"source_message_id" integer,
	"decided_by_admin_id" integer,
	"decided_at" integer,
	"kb_document_id" integer,
	"rejected_reason" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "kb_suggestions_status_check" CHECK ("kb_suggestions"."status" IN ('pending','ingested','rejected'))
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"by_admin_id" integer,
	"notes" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"by_admin_id" integer,
	"body" text NOT NULL,
	"source" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"state" text DEFAULT 'intake_pending' NOT NULL,
	"intake_json" text,
	"visa_docs_json" text,
	"application_id" text,
	"ops_chat_id" bigint,
	"ops_message_id" integer,
	"rejected_reason" text,
	"decided_by_admin_id" integer,
	"decided_at" integer,
	"last_checkin_at" integer,
	"visa_interview_field" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "leads_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "leads_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "leads_state_check" CHECK ("leads"."state" IN ('intake_pending','intake_complete','approved','partner_review','rejected','docs_pending','docs_complete','visa_form','visa_filing','visa_waiting','ready_to_work','closed'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"tg_message_id" integer,
	"meta_json" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"stage" text,
	"deleted_at" integer,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('user', 'assistant', 'human', 'system'))
);
--> statement-breakpoint
CREATE TABLE "pairwise_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"style_a_slug" text NOT NULL,
	"style_b_slug" text NOT NULL,
	"persona_slug" text NOT NULL,
	"winner" text NOT NULL,
	"judge_reason" text,
	"match_a_id" integer,
	"match_b_id" integer,
	"elo_a_after" integer NOT NULL,
	"elo_b_after" integer NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "pairwise_matches_winner_check" CHECK ("pairwise_matches"."winner" IN ('a','b','draw'))
);
--> statement-breakpoint
CREATE TABLE "questionnaire_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"used_at" integer,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_play_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"style_slug" text NOT NULL,
	"persona_slug" text NOT NULL,
	"outcome" text NOT NULL,
	"judge_reason" text,
	"transcript_json" text NOT NULL,
	"turns" integer NOT NULL,
	"skills_json" text DEFAULT '[]' NOT NULL,
	"lead_id" integer,
	"fabrications_caught" integer DEFAULT 0 NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "self_play_matches_outcome_check" CHECK ("self_play_matches"."outcome" IN ('won','lost','draw'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"proposal_id" integer NOT NULL,
	"parent_style_slug" text NOT NULL,
	"parent_style_id" integer NOT NULL,
	"new_style_slug" text NOT NULL,
	"new_style_id" integer NOT NULL,
	"pairs_planned" integer NOT NULL,
	"pairs_done" integer DEFAULT 0 NOT NULL,
	"a_wins" integer DEFAULT 0 NOT NULL,
	"b_wins" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"win_rate_lb" double precision,
	"status" text DEFAULT 'running' NOT NULL,
	"decision" text,
	"error_message" text,
	"started_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"completed_at" integer,
	CONSTRAINT "shadow_evaluations_status_check" CHECK ("shadow_evaluations"."status" IN ('running','complete','failed')),
	CONSTRAINT "shadow_evaluations_decision_check" CHECK ("shadow_evaluations"."decision" IS NULL OR "shadow_evaluations"."decision" IN ('keep','rollback','inconclusive'))
);
--> statement-breakpoint
CREATE TABLE "skill_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"conversation_id" integer,
	"message_id" integer,
	"style_slug" text,
	"skill_slug" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "skill_outcomes_outcome_check" CHECK ("skill_outcomes"."outcome" IN ('won','lost','draw')),
	CONSTRAINT "skill_outcomes_source_check" CHECK ("skill_outcomes"."source" IN ('lead_submitted','lead_rejected','lead_ghosted','manual','self_play'))
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"family" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"prompt_fragment" text NOT NULL,
	"applicable_stages_json" text DEFAULT '[]' NOT NULL,
	"intent" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "skills_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "style_ratings" (
	"style_slug" text PRIMARY KEY NOT NULL,
	"elo" integer DEFAULT 1500 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"last_outcome_at" integer,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_skills" (
	"style_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	CONSTRAINT "style_skills_style_id_skill_id_pk" PRIMARY KEY("style_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "styles" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"config_json" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_id" integer,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"deleted_at" integer
);
--> statement-breakpoint
CREATE TABLE "userbot_delete_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"tg_message_id" integer NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"done_at" integer,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "userbot_send_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"text" text NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"sent_at" integer,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"message_id" integer
);
--> statement-breakpoint
CREATE TABLE "userbot_session" (
	"id" integer PRIMARY KEY NOT NULL,
	"session_string" text DEFAULT '' NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "userbot_session_id_check" CHECK ("userbot_session"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"tg_user_id" bigint NOT NULL,
	"tg_username" text,
	"status" text DEFAULT 'new' NOT NULL,
	"profile_json" text,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	CONSTRAINT "users_tg_user_id_unique" UNIQUE("tg_user_id"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('new', 'questionnaire_pending', 'qualified', 'won', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "vacancies" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL,
	"updated_at" integer DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_proposals" ADD CONSTRAINT "coach_proposals_decided_by_admin_id_admins_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_style_id_styles_id_fk" FOREIGN KEY ("style_id") REFERENCES "public"."styles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_suggestions" ADD CONSTRAINT "kb_suggestions_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_suggestions" ADD CONSTRAINT "kb_suggestions_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_suggestions" ADD CONSTRAINT "kb_suggestions_decided_by_admin_id_admins_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_suggestions" ADD CONSTRAINT "kb_suggestions_kb_document_id_kb_documents_id_fk" FOREIGN KEY ("kb_document_id") REFERENCES "public"."kb_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_by_admin_id_admins_id_fk" FOREIGN KEY ("by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_by_admin_id_admins_id_fk" FOREIGN KEY ("by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_decided_by_admin_id_admins_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairwise_matches" ADD CONSTRAINT "pairwise_matches_match_a_id_self_play_matches_id_fk" FOREIGN KEY ("match_a_id") REFERENCES "public"."self_play_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairwise_matches" ADD CONSTRAINT "pairwise_matches_match_b_id_self_play_matches_id_fk" FOREIGN KEY ("match_b_id") REFERENCES "public"."self_play_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_tokens" ADD CONSTRAINT "questionnaire_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_play_matches" ADD CONSTRAINT "self_play_matches_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_evaluations" ADD CONSTRAINT "shadow_evaluations_proposal_id_coach_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."coach_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD CONSTRAINT "skill_outcomes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD CONSTRAINT "skill_outcomes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_outcomes" ADD CONSTRAINT "skill_outcomes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_skills" ADD CONSTRAINT "style_skills_style_id_styles_id_fk" FOREIGN KEY ("style_id") REFERENCES "public"."styles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_skills" ADD CONSTRAINT "style_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_created_at" ON "audit_log" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_audit_log_admin_id" ON "audit_log" USING btree ("admin_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_audit_log_action" ON "audit_log" USING btree ("action","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_coach_proposals_style" ON "coach_proposals" USING btree ("style_slug","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_coach_proposals_status" ON "coach_proposals" USING btree ("status","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_conversations_user_source" ON "conversations" USING btree ("user_id","source");--> statement-breakpoint
CREATE INDEX "idx_conv_mode_last" ON "conversations" USING btree ("mode","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conv_style" ON "conversations" USING btree ("style_id");--> statement-breakpoint
CREATE INDEX "idx_conv_experiment" ON "conversations" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "idx_experiments_status" ON "experiments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_chunks_doc" ON "kb_chunks" USING btree ("document_id");--> statement-breakpoint
-- pgvector ivfflat для cosine + GIN для tsvector. drizzle-kit пока не
-- поддерживает opclass-параметры (vector_cosine_ops, lists=100) и USING GIN.
CREATE INDEX "idx_kb_chunks_embedding" ON "kb_chunks" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_fts" ON "kb_chunks" USING GIN (fts);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_source_hash" ON "kb_documents" USING btree ("source","content_hash");--> statement-breakpoint
CREATE INDEX "idx_kb_docs_topic" ON "kb_documents" USING btree ("topic") WHERE topic IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_kb_suggestions_status" ON "kb_suggestions" USING btree ("status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_kb_suggestions_conv" ON "kb_suggestions" USING btree ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "idx_lead_events_lead_recency" ON "lead_events" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_lead_notes_lead_recency" ON "lead_notes" USING btree ("lead_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_leads_state_recency" ON "leads" USING btree ("state","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_msg_conv_created" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_msg_user_tg" ON "messages" USING btree ("conversation_id","tg_message_id") WHERE role = 'user' AND tg_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_pairwise_matches_styles" ON "pairwise_matches" USING btree ("style_a_slug","style_b_slug");--> statement-breakpoint
CREATE INDEX "idx_pairwise_matches_created" ON "pairwise_matches" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_qtokens_user" ON "questionnaire_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_self_play_recent" ON "self_play_matches" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_self_play_style" ON "self_play_matches" USING btree ("style_slug","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_self_play_persona" ON "self_play_matches" USING btree ("persona_slug","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_sessions_admin" ON "sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "idx_shadow_evaluations_proposal" ON "shadow_evaluations" USING btree ("proposal_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_skill_outcomes_skill" ON "skill_outcomes" USING btree ("skill_slug");--> statement-breakpoint
CREATE INDEX "idx_skill_outcomes_lead" ON "skill_outcomes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_skill_outcomes_recent" ON "skill_outcomes" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_outcomes_idempotency" ON "skill_outcomes" USING btree ("lead_id","skill_slug","source");--> statement-breakpoint
CREATE INDEX "idx_skills_family" ON "skills" USING btree ("family");--> statement-breakpoint
CREATE INDEX "idx_skills_enabled" ON "skills" USING btree ("is_enabled") WHERE is_enabled = TRUE;--> statement-breakpoint
CREATE INDEX "idx_style_skills_skill" ON "style_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_styles_slug_version" ON "styles" USING btree ("slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_styles_active_slug" ON "styles" USING btree ("slug") WHERE is_active = TRUE;--> statement-breakpoint
CREATE INDEX "idx_styles_active" ON "styles" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_userbot_delete_queue_pending" ON "userbot_delete_queue" USING btree ("id") WHERE done_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_userbot_queue_pending" ON "userbot_send_queue" USING btree ("id") WHERE sent_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_vacancies_active_recency" ON "vacancies" USING btree ("is_active","updated_at" DESC) WHERE is_active = TRUE;--> statement-breakpoint
-- Seed единственной строки userbot_session (id=1) — таблица существует как
-- key-value singleton под session string MTProto-клиента.
INSERT INTO "userbot_session" ("id", "session_string") VALUES (1, '') ON CONFLICT DO NOTHING;