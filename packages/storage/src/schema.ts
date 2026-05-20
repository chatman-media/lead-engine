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
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_qtokens_user").on(t.userId),
]);

export const styles = pgTable("styles", {
  id: serial("id").primaryKey(),
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
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  adminId: integer("admin_id").notNull().references(() => admins.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_sessions_admin").on(t.adminId),
]);

// ---- Vacancies ---------------------------------------------------------

export const vacancies = pgTable("vacancies", {
  id: serial("id").primaryKey(),
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
  styleId: integer("style_id").notNull().references(() => styles.id, { onDelete: "cascade" }),
  skillId: integer("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
}, (t) => [
  primaryKey({ columns: [t.styleId, t.skillId] }),
  index("idx_style_skills_skill").on(t.skillId),
]);

export const skillOutcomes = pgTable("skill_outcomes", {
  id: serial("id").primaryKey(),
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
  elo: integer("elo").notNull().default(1500),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  lastOutcomeAt: integer("last_outcome_at"),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
});

export const selfPlayMatches = pgTable("self_play_matches", {
  id: serial("id").primaryKey(),
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
  sessionString: text("session_string").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("userbot_session_id_check", sql`${t.id} = 1`),
]);

// ---- Coach proposals ---------------------------------------------------

export const coachProposals = pgTable("coach_proposals", {
  id: serial("id").primaryKey(),
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
