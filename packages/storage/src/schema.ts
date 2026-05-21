// Полная schema платформы. Сгенерирована из миграции production-БД sales-guru
// (см. migrations/pg_schema.sql в репозитории chatman-media/sales-guru).
//
// Этап 1 re-design (план в lead-engine):
//   1. Перенести ВСЕ 24 таблицы прод-БД в Drizzle, чтобы пакет storage стал
//      единственным источником истины по DDL.
//   2. БЕЗ tenant_id — он добавляется на этапе 6 как nullable-колонка
//      с default=1 для legacy данных.
//
// Конвенции:
//   - JS-имена полей camelCase, SQL-колонки snake_case (как в прод).
//   - Timestamps хранятся как INTEGER (epoch seconds) — так в прод, не меняем.
//   - Vector(1536) и tsvector-generated колонки оформлены через customType
//     (нативный drizzle-vector появился, но customType работает универсально
//     и даёт явный контроль над DDL в первой migration).

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---- Custom types (vector / tsvector) ----------------------------------

const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return JSON.parse(value as string) as number[];
  },
});

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

// Утилита для эпохи-default'а на колонке INTEGER created_at/updated_at.
const epochNow = () => sql`EXTRACT(EPOCH FROM NOW())::INTEGER`;

// ---- Core funnel: users / conversations / messages ---------------------

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  tgUserId: bigint("tg_user_id", { mode: "number" }).notNull().unique(),
  tgUsername: text("tg_username"),
  status: text("status").notNull().default("new"),
  profileJson: text("profile_json"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("users_status_check", sql`${t.status} IN ('new', 'questionnaire_pending', 'qualified', 'won', 'lost')`),
]);

export const questionnaireTokens = pgTable("questionnaire_tokens", {
  token: text("token").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_qtokens_user").on(t.userId),
]);

export const styles = pgTable("styles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  configJson: text("config_json").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  version: integer("version").notNull().default(1),
  parentId: integer("parent_id"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  // Soft-delete marker: NULL = live; NOT NULL = operator-retired chain.
  deletedAt: integer("deleted_at"),
}, (t) => [
  uniqueIndex("uniq_styles_slug_version").on(t.slug, t.version),
  uniqueIndex("uniq_styles_active_slug").on(t.slug).where(sql`is_active = TRUE`),
  index("idx_styles_active").on(t.isActive),
]);

export const experiments = pgTable("experiments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull(),
  allocationJson: text("allocation_json").notNull(),
  successMetric: text("success_metric").notNull().default("qualified"),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("experiments_status_check", sql`${t.status} IN ('draft', 'running', 'paused', 'done')`),
  check("experiments_success_metric_check", sql`${t.successMetric} IN ('qualified', 'won', 'replied_3+')`),
  index("idx_experiments_status").on(t.status),
]);

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Канал входа: bot (BotAPI, для тестов), userbot (MTProto, реальные лиды),
  // self_play (синтетические диалоги). Тот же кандидат, пишущий в bot и
  // userbot, получает два независимых conversation.
  source: text("source").notNull().default("bot"),
  mode: text("mode").notNull().default("ai"),
  escalatedAt: integer("escalated_at"),
  assignedAdminId: integer("assigned_admin_id"),
  lastMessageAt: integer("last_message_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  styleId: integer("style_id").references(() => styles.id),
  experimentId: integer("experiment_id").references(() => experiments.id),
  currentStage: text("current_stage"),
  summaryJson: text("summary_json"),
  metaJson: text("meta_json"),
}, (t) => [
  check("conversations_source_check", sql`${t.source} IN ('bot', 'userbot', 'self_play')`),
  check("conversations_mode_check", sql`${t.mode} IN ('ai', 'queued', 'human')`),
  uniqueIndex("uniq_conversations_user_source").on(t.userId, t.source),
  index("idx_conv_mode_last").on(t.mode, sql`${t.lastMessageAt} DESC NULLS LAST`),
  index("idx_conv_style").on(t.styleId),
  index("idx_conv_experiment").on(t.experimentId),
]);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  text: text("text").notNull(),
  tgMessageId: integer("tg_message_id"),
  metaJson: text("meta_json"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  stage: text("stage"),
  // Soft-delete для удалённых оператором сообщений (рендерятся struck-through).
  deletedAt: integer("deleted_at"),
}, (t) => [
  check("messages_role_check", sql`${t.role} IN ('user', 'assistant', 'human', 'system')`),
  index("idx_msg_conv_created").on(t.conversationId, t.createdAt),
  uniqueIndex("uniq_msg_user_tg")
    .on(t.conversationId, t.tgMessageId)
    .where(sql`role = 'user' AND tg_message_id IS NOT NULL`),
]);

// ---- Knowledge base ----------------------------------------------------

export const kbDocuments = pgTable("kb_documents", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  topic: text("topic"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_kb_source_hash").on(t.source, t.contentHash),
  index("idx_kb_docs_topic").on(t.topic).where(sql`topic IS NOT NULL`),
]);

export const kbChunks = pgTable("kb_chunks", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  documentId: integer("document_id").notNull().references(() => kbDocuments.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  text: text("text").notNull(),
  tokenCount: integer("token_count").notNull().default(0),
  embedding: vector("embedding", { dimensions: 1536 }),
  // FTS-колонка GENERATED ALWAYS — Drizzle drizzle-kit пока не умеет генерить
  // её декларативно. Опишем как обычный tsvector в schema (для типов),
  // а DDL `GENERATED ALWAYS AS (to_tsvector('russian', coalesce(text,'')))
  // STORED` добавляется в migration вручную.
  fts: tsvector("fts"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_chunks_doc").on(t.documentId),
  // ivfflat и GIN-индексы добавляются в migration вручную — drizzle-kit пока
  // не поддерживает opclass-параметры для индексов (vector_cosine_ops).
]);

// ---- Admins / sessions / app settings ----------------------------------

export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // 'superadmin' (полный доступ — деструктивные операции, system settings)
  // или 'manager' (повседневное — лиды, чаты, KB).
  role: text("role").notNull().default("superadmin"),
  createdAt: integer("created_at").notNull().default(epochNow()),
});

// Global key-value store для admin-UI настроек, шарящихся между админами
// (например, тема light/dark). Не per-admin — одно значение на весь UI.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").notNull().references(() => admins.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_sessions_admin").on(t.adminId),
]);

// ---- Vacancies ---------------------------------------------------------

export const vacancies = pgTable("vacancies", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  url: text("url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_vacancies_active_recency")
    .on(t.isActive, sql`${t.updatedAt} DESC`)
    .where(sql`is_active = TRUE`),
]);

// ---- Leads & lead lifecycle --------------------------------------------

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("intake_pending"),
  intakeJson: text("intake_json"),
  visaDocsJson: text("visa_docs_json"),
  applicationId: text("application_id").unique(),
  opsChatId: bigint("ops_chat_id", { mode: "number" }),
  opsMessageId: integer("ops_message_id"),
  rejectedReason: text("rejected_reason"),
  decidedByAdminId: integer("decided_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  decidedAt: integer("decided_at"),
  // Эпоха последнего проактивного check-in DM, отправленного пока лид ждал
  // в docs_pending / visa_waiting стадии.
  lastCheckinAt: integer("last_checkin_at"),
  // Step-by-step visa-anketa interview: ключ VisaFields, на ответ по которому
  // бот сейчас ждёт. NULL = интервью не идёт.
  visaInterviewField: text("visa_interview_field"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "leads_state_check",
    sql`${t.state} IN ('intake_pending','intake_complete','approved','partner_review','rejected','docs_pending','docs_complete','visa_form','visa_filing','visa_waiting','ready_to_work','closed')`,
  ),
  index("idx_leads_state_recency").on(t.state, sql`${t.updatedAt} DESC`),
]);

export const leadEvents = pgTable("lead_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  byAdminId: integer("by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_lead_events_lead_recency").on(t.leadId, t.createdAt),
]);

export const leadNotes = pgTable("lead_notes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  byAdminId: integer("by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  source: text("source"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_lead_notes_lead_recency").on(t.leadId, sql`${t.createdAt} DESC`),
]);

// ---- KB suggestions ----------------------------------------------------

export const kbSuggestions = pgTable("kb_suggestions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  questionText: text("question_text").notNull(),
  answerDraft: text("answer_draft"),
  status: text("status").notNull().default("pending"),
  sourceConversationId: integer("source_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  sourceMessageId: integer("source_message_id").references(() => messages.id, { onDelete: "set null" }),
  decidedByAdminId: integer("decided_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  decidedAt: integer("decided_at"),
  kbDocumentId: integer("kb_document_id").references(() => kbDocuments.id, { onDelete: "set null" }),
  rejectedReason: text("rejected_reason"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("kb_suggestions_status_check", sql`${t.status} IN ('pending','ingested','rejected')`),
  index("idx_kb_suggestions_status").on(t.status, sql`${t.createdAt} DESC`),
  index("idx_kb_suggestions_conv").on(t.sourceConversationId),
]);

// ---- Skills / style_skills / skill_outcomes ----------------------------

export const skills = pgTable("skills", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  family: text("family").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull(),
  promptFragment: text("prompt_fragment").notNull(),
  applicableStagesJson: text("applicable_stages_json").notNull().default("[]"),
  intent: text("intent").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_skills_family").on(t.family),
  index("idx_skills_enabled").on(t.isEnabled).where(sql`is_enabled = TRUE`),
]);

export const styleSkills = pgTable("style_skills", {
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  styleId: integer("style_id").notNull().references(() => styles.id, { onDelete: "cascade" }),
  skillId: integer("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ columns: [t.styleId, t.skillId] }),
  index("idx_style_skills_skill").on(t.skillId),
]);

export const skillOutcomes = pgTable("skill_outcomes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
  styleSlug: text("style_slug"),
  skillSlug: text("skill_slug").notNull(),
  outcome: text("outcome").notNull(),
  source: text("source").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("skill_outcomes_outcome_check", sql`${t.outcome} IN ('won','lost','draw')`),
  check(
    "skill_outcomes_source_check",
    sql`${t.source} IN ('lead_submitted','lead_rejected','lead_ghosted','manual','self_play')`,
  ),
  index("idx_skill_outcomes_skill").on(t.skillSlug),
  index("idx_skill_outcomes_lead").on(t.leadId),
  index("idx_skill_outcomes_recent").on(sql`${t.createdAt} DESC`),
  uniqueIndex("uq_skill_outcomes_idempotency").on(t.leadId, t.skillSlug, t.source),
]);

// ---- ELO / self-play / pairwise ----------------------------------------

export const styleRatings = pgTable("style_ratings", {
  styleSlug: text("style_slug").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  elo: integer("elo").notNull().default(1500),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  lastOutcomeAt: integer("last_outcome_at"),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
});

export const selfPlayMatches = pgTable("self_play_matches", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  styleSlug: text("style_slug").notNull(),
  personaSlug: text("persona_slug").notNull(),
  outcome: text("outcome").notNull(),
  judgeReason: text("judge_reason"),
  transcriptJson: text("transcript_json").notNull(),
  turns: integer("turns").notNull(),
  skillsJson: text("skills_json").notNull().default("[]"),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  fabricationsCaught: integer("fabrications_caught").notNull().default(0),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("self_play_matches_outcome_check", sql`${t.outcome} IN ('won','lost','draw')`),
  index("idx_self_play_recent").on(sql`${t.createdAt} DESC`),
  index("idx_self_play_style").on(t.styleSlug, sql`${t.createdAt} DESC`),
  index("idx_self_play_persona").on(t.personaSlug, sql`${t.createdAt} DESC`),
]);

export const pairwiseMatches = pgTable("pairwise_matches", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  styleASlug: text("style_a_slug").notNull(),
  styleBSlug: text("style_b_slug").notNull(),
  personaSlug: text("persona_slug").notNull(),
  winner: text("winner").notNull(),
  judgeReason: text("judge_reason"),
  matchAId: integer("match_a_id").references(() => selfPlayMatches.id, { onDelete: "set null" }),
  matchBId: integer("match_b_id").references(() => selfPlayMatches.id, { onDelete: "set null" }),
  eloAAfter: integer("elo_a_after").notNull(),
  eloBAfter: integer("elo_b_after").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("pairwise_matches_winner_check", sql`${t.winner} IN ('a','b','draw')`),
  index("idx_pairwise_matches_styles").on(t.styleASlug, t.styleBSlug),
  index("idx_pairwise_matches_created").on(sql`${t.createdAt} DESC`),
]);

// ---- Userbot session ---------------------------------------------------

export const userbotSession = pgTable("userbot_session", {
  id: integer("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  sessionString: text("session_string").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("userbot_session_id_check", sql`${t.id} = 1`),
]);

// ---- Coach proposals ---------------------------------------------------

export const coachProposals = pgTable("coach_proposals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  styleSlug: text("style_slug").notNull(),
  sampleSize: integer("sample_size").notNull(),
  personaFilter: text("persona_filter"),
  summary: text("summary").notNull(),
  editsJson: text("edits_json").notNull(),
  rationaleJson: text("rationale_json").notNull(),
  rawOutput: text("raw_output"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  decidedAt: integer("decided_at"),
  decidedByAdminId: integer("decided_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
}, (t) => [
  check("coach_proposals_status_check", sql`${t.status} IN ('pending','applied','dismissed')`),
  index("idx_coach_proposals_style").on(t.styleSlug, sql`${t.createdAt} DESC`),
  index("idx_coach_proposals_status").on(t.status, sql`${t.createdAt} DESC`),
]);

// ---- Shadow evaluations ------------------------------------------------

export const shadowEvaluations = pgTable("shadow_evaluations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  proposalId: integer("proposal_id").notNull().references(() => coachProposals.id, { onDelete: "cascade" }),
  parentStyleSlug: text("parent_style_slug").notNull(),
  parentStyleId: integer("parent_style_id").notNull(),
  newStyleSlug: text("new_style_slug").notNull(),
  newStyleId: integer("new_style_id").notNull(),
  pairsPlanned: integer("pairs_planned").notNull(),
  pairsDone: integer("pairs_done").notNull().default(0),
  aWins: integer("a_wins").notNull().default(0),
  bWins: integer("b_wins").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  winRateLb: doublePrecision("win_rate_lb"),
  status: text("status").notNull().default("running"),
  decision: text("decision"),
  errorMessage: text("error_message"),
  startedAt: integer("started_at").notNull().default(epochNow()),
  completedAt: integer("completed_at"),
}, (t) => [
  check("shadow_evaluations_status_check", sql`${t.status} IN ('running','complete','failed')`),
  check(
    "shadow_evaluations_decision_check",
    sql`${t.decision} IS NULL OR ${t.decision} IN ('keep','rollback','inconclusive')`,
  ),
  index("idx_shadow_evaluations_proposal").on(t.proposalId, sql`${t.startedAt} DESC`),
]);

// ---- Userbot outbound queues ------------------------------------------

export const userbotSendQueue = pgTable("userbot_send_queue", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  tgUserId: bigint("tg_user_id", { mode: "number" }).notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
  sentAt: integer("sent_at"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  // Связывает enqueued admin-reply со строкой в `messages`, чтобы userbot
  // мог проставить tg_message_id обратно после отправки.
  messageId: integer("message_id"),
}, (t) => [
  index("idx_userbot_queue_pending").on(t.id).where(sql`sent_at IS NULL`),
]);

// Очередь исходящих, которые оператор попросил удалить из Telegram. Дренируется
// userbot-подпроцессом (только он может вызвать MTProto deleteMessages).
export const userbotDeleteQueue = pgTable("userbot_delete_queue", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  tgUserId: bigint("tg_user_id", { mode: "number" }).notNull(),
  tgMessageId: integer("tg_message_id").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
  doneAt: integer("done_at"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
}, (t) => [
  index("idx_userbot_delete_queue_pending").on(t.id).where(sql`done_at IS NULL`),
]);

// ---- Audit log ---------------------------------------------------------

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  adminId: integer("admin_id").references(() => admins.id, { onDelete: "set null" }),
  targetKind: text("target_kind"),
  targetId: text("target_id"),
  detailsJson: text("details_json"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_audit_log_created_at").on(sql`${t.createdAt} DESC`),
  index("idx_audit_log_admin_id").on(t.adminId, sql`${t.createdAt} DESC`),
  index("idx_audit_log_action").on(t.action, sql`${t.createdAt} DESC`),
]);

// ========================================================================
// MULTI-TENANT ФУНДАМЕНТ (Этап 6 плана re-design)
// ========================================================================
//
// Tenant — корень изоляции. Всё ниже него имеет tenant_id. Над Tenant нет
// агрегатов: биллинг/план — атрибуты на самом Tenant.
//
// Существующие 28 таблиц получают tenant_id отдельной миграцией (default=1
// для legacy данных). В этой ревизии — только новые таблицы.

// ---- Tenants & secrets ------------------------------------------------

export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  // BYOK = клиент приносит свои LLM-ключи; managed = платформа держит аккаунт.
  llmBillingMode: text("llm_billing_mode").notNull().default("byok"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("tenants_status_check", sql`${t.status} IN ('active','suspended','deleted')`),
  check("tenants_llm_billing_check", sql`${t.llmBillingMode} IN ('byok','managed')`),
]);

// Зашифрованные секреты per-tenant: telegram-tokens, OpenAI keys, etc.
// `encryptedValue` — opaque blob (формат: aes-256-gcm + master key из env).
// Хранится отдельно от tenants чтобы select * tenants не светил секретов в логи.
export const tenantSecrets = pgTable("tenant_secrets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_tenant_secrets_key").on(t.tenantId, t.key),
]);

// ---- Channels (Telegram bot/userbot, WhatsApp, web — N на tenant) -----

export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // Должно соответствовать ChannelKind из @chatman-media/channel-core.
  kind: text("kind").notNull(),
  // External id канала в платформе провайдера — bot username, phone number, etc.
  externalId: text("external_id").notNull(),
  // Ссылка на tenant_secrets.key, где лежат creds (bot token / sessionString).
  credentialsRef: text("credentials_ref"),
  status: text("status").notNull().default("active"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "channels_kind_check",
    sql`${t.kind} IN ('telegram_bot','telegram_userbot','whatsapp','web')`,
  ),
  check("channels_status_check", sql`${t.status} IN ('active','paused','error')`),
  uniqueIndex("uniq_channels_tenant_kind_external").on(t.tenantId, t.kind, t.externalId),
  index("idx_channels_tenant_status").on(t.tenantId, t.status),
]);

// ---- Channel-agnostic Contact (бывший users, но per-tenant + multi-channel) ----

// На текущей миграции contacts создаются как НОВАЯ таблица. Старая `users`
// остаётся как legacy. Backfill users → contacts + ChannelIdentity для legacy
// записей произойдёт в Этапе 8 (onboarding 2-го tenant'а), либо в отдельной
// data-migration. Это разделение позволяет channels/funnels писать новый код
// против contacts без блокировки на риск миграции прод-БД.
export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  attributesJson: text("attributes_json"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_contacts_tenant").on(t.tenantId),
]);

// Маппинг Contact ↔ конкретный мессенджер. Один Contact может иметь несколько
// channel_identities (Telegram bot + WhatsApp + tg userbot) — даёт unified inbox.
export const channelIdentities = pgTable("channel_identities", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  externalUserId: text("external_user_id").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_channel_identities_channel_external").on(t.channelId, t.externalUserId),
  index("idx_channel_identities_contact").on(t.contactId),
]);

// ---- Funnels ----------------------------------------------------------

export const funnels = pgTable("funnels", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  // Опциональный template из packages/verticals (например, 'recruitment_uae_v1').
  // При nullable funnel ведётся "руками" — stages_json задаёт состояния.
  verticalTemplateId: text("vertical_template_id"),
  // jsonb с array состояний: [{ slug, kind, label }]
  stagesJson: text("stages_json").notNull().default("[]"),
  defaultStyleId: integer("default_style_id").references(() => styles.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_funnels_tenant_slug").on(t.tenantId, t.slug),
  index("idx_funnels_tenant_active").on(t.tenantId, t.isActive),
]);

// ---- Outbound queue (единая, channel-agnostic) ------------------------

// Заменяет userbot_send_queue в multi-tenant + multi-channel мире. Worker
// читает pending записи в порядке scheduled_at, дёргает ChannelAdapter.send(),
// записывает результат (external_message_id) и помечает sent.
export const outboundQueue = pgTable("outbound_queue", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id"),
  // Сериализованный OutboundEnvelope (см. channel-core).
  payloadJson: text("payload_json").notNull(),
  // Идемпотентный ключ — позволяет защититься от дублей при retry воркером.
  idempotencyKey: text("idempotency_key"),
  scheduledAt: integer("scheduled_at").notNull().default(epochNow()),
  status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(0),
  lastError: text("last_error"),
  // Заполняется после успешной отправки.
  externalMessageId: text("external_message_id"),
  sentAt: integer("sent_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("outbound_status_check", sql`${t.status} IN ('pending','processing','sent','failed','cancelled')`),
  // Главный индекс для воркер-полинга: pending ordered by scheduled_at.
  index("idx_outbound_pending").on(t.status, t.scheduledAt).where(sql`status = 'pending'`),
  index("idx_outbound_tenant_channel").on(t.tenantId, t.channelId),
  uniqueIndex("uniq_outbound_idempotency")
    .on(t.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
]);

// ---- LLM provider configs (per (tenant, purpose)) ---------------------

// Читается LlmRouter'ом для resolveChat/resolveEmbed (см. packages/llm-router).
// На N tenants × M purposes здесь до N*M строк. secret_ref — ключ в
// tenant_secrets (там лежит зашифрованный apiKey).
export const llmProviderConfigs = pgTable("llm_provider_configs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  secretRef: text("secret_ref"),
  baseUrl: text("base_url"),
  // Только для purpose='embed'.
  embedDim: integer("embed_dim"),
  timeoutMs: integer("timeout_ms"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "llm_configs_purpose_check",
    sql`${t.purpose} IN ('chat','embed','vision','judge')`,
  ),
  check(
    "llm_configs_provider_check",
    sql`${t.provider} IN ('openai','openrouter','ollama','anthropic')`,
  ),
  uniqueIndex("uniq_llm_configs_tenant_purpose").on(t.tenantId, t.purpose),
]);

// ---- Stripe billing (миграция 0006) -----------------------------------

// Tenant ↔ Stripe Customer (1:1). Один tenant в Stripe = одна Customer
// карточка с своим email + payment methods.
export const stripeCustomers = pgTable("stripe_customers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  email: text("email"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("stripe_customers_tenant_unique").on(t.tenantId),
  uniqueIndex("stripe_customers_external_unique").on(t.stripeCustomerId),
  index("idx_stripe_customers_tenant").on(t.tenantId),
]);

// История подписок tenant'а. Webhook'ом customer.subscription.updated мы
// UPSERT'им строку (stripe_subscription_id — UNIQUE). Текущая active —
// одна на tenant'а; canceled/incomplete_expired остаются в истории.
export const stripeSubscriptions = pgTable("stripe_subscriptions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  status: text("status").notNull(),
  currentPeriodStart: integer("current_period_start"),
  currentPeriodEnd: integer("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "stripe_subscriptions_status_check",
    sql`${t.status} IN ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')`,
  ),
  uniqueIndex("stripe_subscriptions_external_unique").on(t.stripeSubscriptionId),
  index("idx_stripe_subscriptions_tenant").on(t.tenantId),
  index("idx_stripe_subscriptions_status").on(t.status),
]);

// Idempotency для webhook'ов — Stripe at-least-once delivers, иногда
// дублирует на retry. Перед обработкой смотрим есть ли event.id —
// если есть, skip с 200.
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  type: text("type").notNull(),
  tenantId: integer("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  processedAt: integer("processed_at").notNull().default(epochNow()),
  rawPayload: text("raw_payload").notNull(),
}, (t) => [
  index("idx_stripe_webhook_events_type").on(t.type, sql`${t.processedAt} DESC`),
]);
