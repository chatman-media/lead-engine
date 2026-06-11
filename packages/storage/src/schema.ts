// Полная schema платформы.
// Drizzle — единственный источник истины по DDL начиная с первой migration.
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

// ---- Core funnel: conversations / messages (legacy `users` дропнут в 0008) ----
//
// Историческая `users` таблица удалена миграцией 0008_drop_users.sql.
// Backfill (0003) перенёс данные 1:1 в `contacts` (id preservation),
// миграция 0007 переключила все FK с users.id → contacts.id. Все
// `user_id` колонки ниже (questionnaire_tokens.user_id, conversations.
// user_id, leads.user_id) — это исторические имена, реально ссылающиеся
// на contacts.id. Переименование колонок отложено до отдельной миграции
// (требует update apps/admin-ui Drizzle типов).

export const questionnaireTokens = pgTable("questionnaire_tokens", {
  token: text("token").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references((): import("drizzle-orm/pg-core").AnyPgColumn => contacts.id, { onDelete: "cascade" }),
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
  userId: integer("user_id").notNull().references((): import("drizzle-orm/pg-core").AnyPgColumn => contacts.id, { onDelete: "cascade" }),
  channelId: integer("channel_id").references((): import("drizzle-orm/pg-core").AnyPgColumn => channels.id, { onDelete: "set null" }),
  // Канал входа: bot (BotAPI, для тестов), userbot (MTProto, реальные лиды),
  // self_play (синтетические диалоги). Тот же кандидат, пишущий в bot и
  // userbot, получает два независимых conversation.
  source: text("source").notNull().default("bot"),
  mode: text("mode").notNull().default("ai"),
  status: text("status").notNull().default("open"),
  unreadCount: integer("unread_count").notNull().default(0),
  lastMessageText: text("last_message_text"),
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
  check("conversations_status_check", sql`${t.status} IN ('open', 'pending', 'resolved')`),
  uniqueIndex("uniq_conversations_user_source").on(t.userId, t.source).where(sql`${t.channelId} IS NULL`),
  uniqueIndex("uniq_conversations_user_channel").on(t.userId, t.channelId).where(sql`${t.channelId} IS NOT NULL`),
  index("idx_conversations_channel").on(t.channelId).where(sql`${t.channelId} IS NOT NULL`),
  index("idx_conv_mode_last").on(t.mode, sql`${t.lastMessageAt} DESC NULLS LAST`),
  index("idx_conv_status_last").on(t.status, sql`${t.lastMessageAt} DESC NULLS LAST`),
  index("idx_conv_assignee_last").on(t.assignedAdminId, sql`${t.lastMessageAt} DESC NULLS LAST`),
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
  scopeType: text("scope_type").notNull().default("global"),
  funnelId: integer("funnel_id"),
  stageSlug: text("stage_slug"),
  fileStorageKey: text("file_storage_key"),
  fileName: text("file_name"),
  fileMimeType: text("file_mime_type"),
  fileSizeBytes: integer("file_size_bytes"),
  fileUploadedAt: integer("file_uploaded_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("kb_documents_scope_type_check", sql`${t.scopeType} IN ('global','funnel','stage')`),
  check(
    "kb_documents_scope_shape_check",
    sql`(
      (${t.scopeType} = 'global' AND ${t.funnelId} IS NULL AND ${t.stageSlug} IS NULL)
      OR (${t.scopeType} = 'funnel' AND ${t.funnelId} IS NOT NULL AND ${t.stageSlug} IS NULL)
      OR (${t.scopeType} = 'stage' AND ${t.funnelId} IS NOT NULL AND ${t.stageSlug} IS NOT NULL)
    )`,
  ),
  check("kb_documents_file_size_check", sql`${t.fileSizeBytes} IS NULL OR ${t.fileSizeBytes} >= 0`),
  uniqueIndex("uniq_kb_source_hash").on(t.tenantId, t.source, t.contentHash),
  uniqueIndex("uniq_kb_docs_file_storage_key").on(t.fileStorageKey).where(sql`file_storage_key IS NOT NULL`),
  index("idx_kb_docs_topic").on(t.topic).where(sql`topic IS NOT NULL`),
  index("idx_kb_docs_scope").on(t.tenantId, t.scopeType, t.funnelId, t.stageSlug),
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
  // Опциональное отображаемое имя (профиль / приветствия в UI).
  name: text("name"),
  // 'superadmin' (полный доступ — деструктивные операции, system settings)
  // или 'manager' (повседневное — лиды, чаты, KB).
  role: text("role").notNull().default("superadmin"),
  createdAt: integer("created_at").notNull().default(epochNow()),
});

// Per-tenant LLM call usage tracking. Каждый успешный или failed вызов
// chat/embed модели append'ит row сюда. UI показывает аггрегаты за месяц
// (BYOK customers видят сколько раз их ключ дёрнули) + per-purpose
// breakdown.
//
// Token counts пока не capture'аем — нужен provider-level patch для
// извлечения `usage` из response.body. Текущий MVP — только counts +
// latency. Tokens / cost-USD — отдельный PR.
export const llmUsageEvents = pgTable("llm_usage_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** chat | embed | vision | judge — что вызывали. */
  purpose: text("purpose").notNull(),
  /** openai | openrouter | ollama | anthropic — какой provider. */
  provider: text("provider").notNull(),
  /** Конкретная model (gpt-4o-mini / text-embedding-3-small / ...). */
  model: text("model"),
  /** Latency call'а в миллисекундах. */
  latencyMs: integer("latency_ms").notNull(),
  /** Успех (1) или ошибка (0). При ошибке `errorKind` заполняется. */
  success: boolean("success").notNull(),
  /** ChatApiError.name / ChatTruncatedError / EmbeddingApiError / etc. */
  errorKind: text("error_kind"),
  /** Опционально prompt-токены (provider-supplied). Null если не captured. */
  promptTokens: integer("prompt_tokens"),
  /** Опционально completion-токены. Null для embed (там input only). */
  completionTokens: integer("completion_tokens"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "llm_usage_purpose_check",
    sql`${t.purpose} IN ('chat','embed','vision','judge','memory','stage')`,
  ),
  // Главный индекс для monthly aggregator: (tenant, created_at).
  index("idx_llm_usage_tenant_ts").on(t.tenantId, sql`${t.createdAt} DESC`),
  index("idx_llm_usage_purpose").on(t.tenantId, t.purpose, sql`${t.createdAt} DESC`),
]);

// Multi-admin invite tokens per tenant. SuperadminB генерит invite-ссылку
// (POST /api/admin/admins/invite) → передаёт коллеге out-of-band (TG/email/
// мессенджер) → коллега открывает /accept-invite?token=... → создаёт пароль
// → joinит tenant как admin с заданной role'ю.
//
// Token — opaque random string (32 hex). Истекает через `expiresAt`. После
// использования помечается `usedAt` чтобы тот же token нельзя было активировать
// дважды.
export const adminInvites = pgTable("admin_invites", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Email приглашаемого. Используется для display + dup-detection. */
  email: text("email").notNull(),
  /** Роль для нового админа: 'superadmin' | 'manager'. */
  role: text("role").notNull().default("manager"),
  /** Opaque token (hex). UNIQUE по всем tenants — random'ный 32-byte → коллизии не реалистичны. */
  token: text("token").notNull().unique(),
  /** Admin создавший invite. NULL если invitor удалён. */
  invitedByAdminId: integer("invited_by_admin_id").references(() => admins.id, {
    onDelete: "set null",
  }),
  /** Когда истекает (default = +7 дней от createdAt). */
  expiresAt: integer("expires_at").notNull(),
  /** Когда использован (NULL = pending). После usage row не удаляется — audit trail. */
  usedAt: integer("used_at"),
  /** ID admin'а который был создан при accept. NULL до accept. */
  acceptedAdminId: integer("accepted_admin_id").references(() => admins.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "admin_invites_role_check",
    sql`${t.role} IN ('superadmin','manager')`,
  ),
  index("idx_admin_invites_tenant").on(t.tenantId, sql`${t.createdAt} DESC`),
  index("idx_admin_invites_email").on(t.tenantId, t.email),
]);

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

// ---- Universal pipeline: stage definitions & fields --------------------

// Тип стадии определяет её поведение в UI и движке.
export const STAGE_TYPES = [
  "form_fill",        // сбор данных через поля
  "document_upload",  // загрузка файлов/документов
  "document_signature", // подписание договора
  "rate_confirmation", // подтверждение курса/цены
  "external_approval",  // ждём решения третьей стороны
  "payment",          // оплата
  "waiting",          // ожидание (по времени)
  "awaiting_operator", // ждём ручного действия оператора
  "interaction",      // встреча/звонок/просмотр
  "assessment",       // оценка/квалификация
  "milestone",        // контрольная точка
] as const;

export const STAGE_KINDS = [
  "intake",           // первая стадия — заявка
  "active",           // рабочая стадия
  "terminal_won",     // финал — успех
  "terminal_lost",    // финал — отказ
] as const;

// Макро-фаза «середины» воронки (универсальный костяк). Хранится только на
// active-стадиях; capture/won/lost выводятся из kind. Полная семантика и
// валидатор — в @chatman-media/verticals (phases.ts); здесь дублируем литералы
// для CHECK, т.к. storage не зависит от verticals (как и STAGE_KINDS).
export const STAGE_PHASES = [
  "qualify",  // понять нужду + оценить сделку
  "offer",    // предложить условия + получить «да»
  "clear",    // гейты: KYC, документы, одобрения 3-й стороны
  "fulfill",  // доставить + провести деньги
] as const;

export const FIELD_TYPES = [
  "text", "textarea", "number", "date",
  "select", "multiselect", "boolean",
  "phone", "email", "file", "photo", "video",
] as const;

// Стадии воронки — хранятся в БД, не в коде.
// Заменяет hardcoded FunnelStageDef из vertical-recruitment.
export const stageDefinitions = pgTable("stage_definitions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  funnelId: integer("funnel_id").notNull().references((): import("drizzle-orm/pg-core").AnyPgColumn => funnels.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  position: integer("position").notNull().default(0),
  kind: text("kind").notNull().default("active"),
  stageType: text("stage_type").notNull().default("form_fill"),
  // макро-фаза костяка (qualify/offer/clear/fulfill) — только для active-стадий;
  // для intake/terminal_* фаза выводится из kind, поэтому здесь NULL.
  phase: text("phase"),
  // тип-специфичные параметры: ai_collect, max_files, expected_days и т.п.
  configJson: text("config_json").notNull().default("{}"),
  // slugs стадий, в которые разрешён переход из этой
  nextStages: text("next_stages").array().notNull().default(sql`'{}'`),
  // jsonb условие для авто-перехода: { type: "all_required_fields_filled" } и т.п.
  autoAdvanceCondition: text("auto_advance_condition"),
  staleTimeoutDays: integer("stale_timeout_days"),
  checkinIntervalDays: integer("checkin_interval_days"),
  // если true — бот переходит в режим поддержки (не продаёт)
  supportMode: boolean("support_mode").notNull().default(false),
  color: text("color"),
  icon: text("icon"),
  // Per-stage instructions (Phase 2): goal = what to achieve, guidance = how to
  // behave. Consumed by the reply prompt (slice C-2); NULL = fall back to Style.
  goal: text("goal"),
  guidance: text("guidance"),
  // Partner availability ping (epic: supplier-check).
  // partnerWebhookUrl — HTTP(S) URL for a POST callback, or tg://CHAT_ID to
  //   notify the partner via Telegram (uses tenant's operator bot token).
  // partnerWebhookMode — 'fire_and_forget': POST and move on;
  //   'await_callback': lead waits; system advances only after /api/partner/cb/:token.
  partnerWebhookUrl: text("partner_webhook_url"),
  partnerWebhookMode: text("partner_webhook_mode").notNull().default("fire_and_forget"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("stage_definitions_kind_check", sql`${t.kind} IN ('intake','active','terminal_won','terminal_lost')`),
  check("stage_definitions_type_check", sql`${t.stageType} IN ('form_fill','document_upload','document_signature','rate_confirmation','external_approval','payment','waiting','awaiting_operator','interaction','assessment','milestone')`),
  check("stage_definitions_phase_check", sql`${t.phase} IS NULL OR ${t.phase} IN ('qualify','offer','clear','fulfill')`),
  uniqueIndex("uniq_stage_def_funnel_slug").on(t.funnelId, t.slug),
  index("idx_stage_def_funnel_pos").on(t.funnelId, t.position),
]);

// Поля данных, собираемых на стадии.
// Заменяет intake_json / visa_docs_json — теперь любая стадия имеет произвольные поля.
export const stageFields = pgTable("stage_fields", {
  id: serial("id").primaryKey(),
  stageId: integer("stage_id").notNull().references(() => stageDefinitions.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  fieldType: text("field_type").notNull().default("text"),
  required: boolean("required").notNull().default(false),
  position: integer("position").notNull().default(0),
  // для select/multiselect: [{value, label}]
  optionsJson: text("options_json").notNull().default("[]"),
  // regex, min, max, allowed_mime_types и т.п.
  validationJson: text("validation_json").notNull().default("{}"),
  hint: text("hint"),
  // может ли LLM автоматически извлекать это поле из диалога
  aiExtractable: boolean("ai_extractable").notNull().default(false),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("stage_fields_type_check", sql`${t.fieldType} IN ('text','textarea','number','date','select','multiselect','boolean','phone','email','file','photo','video')`),
  uniqueIndex("uniq_stage_fields_stage_slug").on(t.stageId, t.slug),
  index("idx_stage_fields_stage_pos").on(t.stageId, t.position),
]);

// ---- Leads & lead lifecycle --------------------------------------------

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  // UNIQUE снят (concierge): один контакт может держать несколько лидов —
  // по одному на активный запрос (request_type). Для одно-воронных вертикалей
  // лид по-прежнему один (на уровне приложения), регресса нет.
  userId: integer("user_id").notNull().references((): import("drizzle-orm/pg-core").AnyPgColumn => contacts.id, { onDelete: "cascade" }),
  // Текстовый slug стадии — legacy для recruitment и новый для динамических воронок.
  // CHECK constraint убран в migration 0011 — валидация на уровне приложения (funnel-machine).
  state: text("state").notNull().default("intake_pending"),
  // Ссылка на динамически созданную стадию. NULL = legacy recruitment lead.
  stageDefinitionId: integer("stage_definition_id").references(() => stageDefinitions.id, { onDelete: "set null" }),
  // Тип запроса (concierge-режим): exchange | transfer | food | … — выбирает,
  // в какой короткой воронке живёт лид. NULL для одно-воронных вертикалей.
  requestType: text("request_type"),
  intakeJson: text("intake_json"),
  visaDocsJson: text("visa_docs_json"),
  applicationId: text("application_id").unique(),
  opsChatId: bigint("ops_chat_id", { mode: "number" }),
  opsMessageId: integer("ops_message_id"),
  rejectedReason: text("rejected_reason"),
  decidedByAdminId: integer("decided_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  decidedAt: integer("decided_at"),
  lastCheckinAt: integer("last_checkin_at"),
  visaInterviewField: text("visa_interview_field"),
  // Partner availability check token. Set when a lead enters an await_callback
  // partner-webhook stage. Cleared once /api/partner/cb/:token is received.
  // NULL = lead is not pending an external partner confirmation.
  awaitingToken: text("awaiting_token"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_leads_state_recency").on(t.state, sql`${t.updatedAt} DESC`),
  index("idx_leads_awaiting_token").on(t.awaitingToken).where(sql`${t.awaitingToken} IS NOT NULL`),
  index("idx_leads_stage_def").on(t.stageDefinitionId),
  // Резолвинг лидов контакта (concierge: N открытых лидов на гостя).
  index("idx_leads_tenant_user").on(t.tenantId, t.userId),
]);

// Кампания капельной рассылки: список лидов + приветствие + скорость выдачи.
// Дрип-диспетчер раз в тик отдаёт drip_per_tick лидов в outbound_queue, но не
// чаще чем раз в drip_interval_sec (last_dripped_at). «Брать по одному с
// какой-то скоростью» = drip_per_tick=1, drip_interval_sec=60.
export const outreachCampaigns = pgTable("outreach_campaigns", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Приветственное сообщение (центральный промпт кампании). Плейсхолдер
  // {name} подставляется именем контакта при отправке.
  greetingText: text("greeting_text").notNull(),
  dripPerTick: integer("drip_per_tick").notNull().default(1),
  dripIntervalSec: integer("drip_interval_sec").notNull().default(60),
  status: text("status").notNull().default("draft"),
  lastDrippedAt: integer("last_dripped_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("outreach_campaigns_status_check", sql`${t.status} IN ('draft','active','paused','completed')`),
  check("outreach_campaigns_drip_check", sql`${t.dripPerTick} > 0 AND ${t.dripIntervalSec} >= 0`),
  index("idx_outreach_campaigns_tenant_status").on(t.tenantId, t.status),
]);

// Членство лида в кампании + его статус доставки.
export const outreachCampaignLeads = pgTable("outreach_campaign_leads", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => outreachCampaigns.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  enqueuedAt: integer("enqueued_at"),
  errorReason: text("error_reason"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("outreach_campaign_leads_status_check", sql`${t.status} IN ('pending','enqueued','sent','skipped','failed')`),
  uniqueIndex("uniq_outreach_campaign_leads").on(t.campaignId, t.leadId),
  index("idx_outreach_campaign_leads_status").on(t.campaignId, t.status),
]);

// Значения полей лида — заменяет intake_json/visa_docs_json для динамических воронок.
export const leadFieldValues = pgTable("lead_field_values", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  fieldId: integer("field_id").notNull().references(() => stageFields.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // строка, число, boolean, массив файлов — зависит от field_type
  valueJson: text("value_json").notNull().default("null"),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
  // null если значение установлено AI
  updatedByAdminId: integer("updated_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("uniq_lead_field_values").on(t.leadId, t.fieldId),
  index("idx_lead_field_values_lead").on(t.leadId),
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
  scopeType: text("scope_type").notNull().default("global"),
  funnelId: integer("funnel_id"),
  stageSlug: text("stage_slug"),
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
  check("kb_suggestions_scope_type_check", sql`${t.scopeType} IN ('global','funnel','stage')`),
  check(
    "kb_suggestions_scope_shape_check",
    sql`(
      (${t.scopeType} = 'global' AND ${t.funnelId} IS NULL AND ${t.stageSlug} IS NULL)
      OR (${t.scopeType} = 'funnel' AND ${t.funnelId} IS NOT NULL AND ${t.stageSlug} IS NULL)
      OR (${t.scopeType} = 'stage' AND ${t.funnelId} IS NOT NULL AND ${t.stageSlug} IS NOT NULL)
    )`,
  ),
  index("idx_kb_suggestions_status").on(t.status, sql`${t.createdAt} DESC`),
  index("idx_kb_suggestions_conv").on(t.sourceConversationId),
  index("idx_kb_suggestions_scope").on(t.tenantId, t.scopeType, t.funnelId, t.stageSlug, sql`${t.createdAt} DESC`),
]);

// ---- Skills / style_skills / skill_outcomes ----------------------------

export const skills = pgTable("skills", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1).references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
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
  uniqueIndex("skills_tenant_slug_unique").on(t.tenantId, t.slug),
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

// ---- Director hooks (tenant-specific persuasion scripts) -------------------

export const directorHooks = pgTable("director_hooks", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  body: text("body").notNull(),
  triggerHint: text("trigger_hint"),
  isActive: boolean("is_active").notNull().default(true),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_director_hooks_tenant").on(t.tenantId, t.position),
  index("idx_director_hooks_active").on(t.tenantId).where(sql`is_active = TRUE`),
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
  runConfigJson: text("run_config_json"),
  claimToken: text("claim_token"),
  claimedAt: integer("claimed_at"),
  leaseExpiresAt: integer("lease_expires_at"),
  attempts: integer("attempts").notNull().default(0),
  startedAt: integer("started_at").notNull().default(epochNow()),
  completedAt: integer("completed_at"),
}, (t) => [
  check("shadow_evaluations_status_check", sql`${t.status} IN ('running','complete','failed')`),
  check(
    "shadow_evaluations_decision_check",
    sql`${t.decision} IS NULL OR ${t.decision} IN ('keep','rollback','inconclusive')`,
  ),
  index("idx_shadow_evaluations_proposal").on(t.proposalId, sql`${t.startedAt} DESC`),
  index("idx_shadow_evaluations_running_lease")
    .on(t.tenantId, t.leaseExpiresAt, t.startedAt)
    .where(sql`${t.status} = 'running'`),
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
  // Реферальный код, использованный при регистрации (NULL если не было).
  referredByCode: text("referred_by_code"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("tenants_status_check", sql`${t.status} IN ('active','suspended','deleted')`),
  check("tenants_llm_billing_check", sql`${t.llmBillingMode} IN ('byok','managed')`),
]);

// Per-tenant feature flags for gradual rollout of high-risk flows.
export const tenantFeatureFlags = pgTable("tenant_feature_flags", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  featureKey: text("feature_key").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_tenant_feature_flags_key").on(t.tenantId, t.featureKey),
  index("idx_tenant_feature_flags_enabled").on(t.tenantId, t.enabled),
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
    sql`${t.kind} IN ('telegram_bot','telegram_userbot','whatsapp','facebook','vk','max','web')`,
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

export const funnelVersions = pgTable("funnel_versions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  funnelId: integer("funnel_id").notNull().references(() => funnels.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => admins.id, { onDelete: "set null" }),
  source: text("source").notNull(),
  note: text("note"),
  stageCount: integer("stage_count").notNull().default(0),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("funnel_versions_source_check", sql`${t.source} IN ('ai_apply','template_apply','manual_edit','rollback')`),
  index("idx_funnel_versions_funnel_created").on(t.tenantId, t.funnelId, sql`${t.createdAt} DESC`),
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

// ---- Agentic tool-call traces -----------------------------------------

// First-class audit trail for tool-loop decisions. This is the raw substrate
// for later self-learning: join tool calls to conversations/leads/orders and
// decide whether a tool helped, failed, or should have been called differently.
export const agentToolCalls = pgTable("agent_tool_calls", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
  outboundQueueId: integer("outbound_queue_id").references(() => outboundQueue.id, { onDelete: "set null" }),
  source: text("source").notNull(),
  toolName: text("tool_name").notNull(),
  argsJson: text("args_json").notNull().default("{}"),
  resultJson: text("result_json").notNull().default("null"),
  error: boolean("error").notNull().default(false),
  cycle: integer("cycle").notNull().default(0),
  toolCallIndex: integer("tool_call_index").notNull().default(0),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "agent_tool_calls_source_check",
    sql`${t.source} IN ('rag_reply','llm_reply','admin_sim','self_play')`,
  ),
  index("idx_agent_tool_calls_conversation").on(t.tenantId, t.conversationId, sql`${t.createdAt} DESC`),
  index("idx_agent_tool_calls_tool").on(t.tenantId, t.toolName, sql`${t.createdAt} DESC`),
  index("idx_agent_tool_calls_error").on(t.tenantId, t.error, sql`${t.createdAt} DESC`),
  index("idx_agent_tool_calls_outbound").on(t.outboundQueueId),
]);

// Human feedback on tool-call quality. This is intentionally separate from the
// immutable trace row, so reviewers can add multiple labels over time.
export const agentToolCallFeedback = pgTable("agent_tool_call_feedback", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  toolCallId: integer("tool_call_id").notNull().references(() => agentToolCalls.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => admins.id, { onDelete: "set null" }),
  label: text("label").notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "agent_tool_call_feedback_label_check",
    sql`${t.label} IN ('good_reply','wrong_tool','missing_tool','bad_args','other')`,
  ),
  index("idx_agent_tool_call_feedback_call").on(t.tenantId, t.toolCallId, sql`${t.createdAt} DESC`),
  index("idx_agent_tool_call_feedback_label").on(t.tenantId, t.label, sql`${t.createdAt} DESC`),
]);

// Persisted improvement proposals derived from clustered tool-call feedback.
// Generated proposals are intentionally lightweight workflow records:
// reviewers can apply/dismiss them and keep the audit trail separate from the
// raw feedback rows that produced the suggestion.
export const agentToolCallImprovementProposals = pgTable("agent_tool_call_improvement_proposals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  fingerprint: text("fingerprint").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  toolName: text("tool_name").notNull(),
  source: text("source").notNull(),
  label: text("label").notNull(),
  summary: text("summary").notNull(),
  rationaleJson: text("rationale_json").notNull().default("[]"),
  actionItemsJson: text("action_items_json").notNull().default("[]"),
  examplesJson: text("examples_json").notNull().default("[]"),
  feedbackCount: integer("feedback_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  lastFeedbackAt: integer("last_feedback_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
  decidedAt: integer("decided_at"),
  decidedByAdminId: integer("decided_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  resolutionKind: text("resolution_kind"),
  resolutionRef: text("resolution_ref"),
  resolutionUrl: text("resolution_url"),
  resolutionNote: text("resolution_note"),
}, (t) => [
  check(
    "agent_tool_call_improvement_kind_check",
    sql`${t.kind} IN ('schema_fix','routing_prompt_fix','tool_candidate')`,
  ),
  check(
    "agent_tool_call_improvement_status_check",
    sql`${t.status} IN ('pending','applied','dismissed')`,
  ),
  check(
    "agent_tool_call_improvement_severity_check",
    sql`${t.severity} IN ('high','medium','low')`,
  ),
  check(
    "agent_tool_call_improvement_source_check",
    sql`${t.source} IN ('rag_reply','llm_reply','admin_sim','self_play')`,
  ),
  check(
    "agent_tool_call_improvement_label_check",
    sql`${t.label} IN ('wrong_tool','missing_tool','bad_args')`,
  ),
  check(
    "agent_tool_call_improvement_resolution_kind_check",
    sql`${t.resolutionKind} IS NULL OR ${t.resolutionKind} IN ('prompt_patch','tool_schema_patch','regression_case','coach_proposal','shadow_eval','pull_request','other')`,
  ),
  uniqueIndex("uniq_agent_tool_call_improvement_fingerprint").on(t.tenantId, t.fingerprint),
  index("idx_agent_tool_call_improvement_status").on(t.tenantId, t.status, sql`${t.updatedAt} DESC`),
  index("idx_agent_tool_call_improvement_tool").on(t.tenantId, t.toolName, sql`${t.updatedAt} DESC`),
  index("idx_agent_tool_call_improvement_resolution").on(t.tenantId, t.resolutionKind, sql`${t.updatedAt} DESC`),
]);

// Regression cases promoted from applied tool-call improvement proposals.
// These records make the quality loop concrete before a generic eval-suite
// runner exists: the original trace input, reviewer expectation, and proposal
// context are persisted as tenant-scoped artifacts.
export const agentToolCallRegressionCases = pgTable("agent_tool_call_regression_cases", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  proposalId: integer("proposal_id").references(() => agentToolCallImprovementProposals.id, {
    onDelete: "set null",
  }),
  toolCallId: integer("tool_call_id").references(() => agentToolCalls.id, { onDelete: "set null" }),
  source: text("source").notNull().default("tool_call_feedback"),
  toolName: text("tool_name").notNull(),
  label: text("label").notNull(),
  title: text("title").notNull(),
  inputJson: text("input_json").notNull().default("{}"),
  expectedJson: text("expected_json").notNull().default("{}"),
  contextJson: text("context_json").notNull().default("{}"),
  status: text("status").notNull().default("active"),
  createdByAdminId: integer("created_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check(
    "agent_tool_call_regression_source_check",
    sql`${t.source} IN ('tool_call_feedback')`,
  ),
  check(
    "agent_tool_call_regression_label_check",
    sql`${t.label} IN ('wrong_tool','missing_tool','bad_args')`,
  ),
  check(
    "agent_tool_call_regression_status_check",
    sql`${t.status} IN ('active','archived')`,
  ),
  index("idx_agent_tool_call_regression_status").on(t.tenantId, t.status, sql`${t.updatedAt} DESC`),
  index("idx_agent_tool_call_regression_tool").on(t.tenantId, t.toolName, sql`${t.updatedAt} DESC`),
  index("idx_agent_tool_call_regression_proposal").on(t.tenantId, t.proposalId),
  index("idx_agent_tool_call_regression_tool_call").on(t.toolCallId),
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
    sql`${t.purpose} IN ('chat','embed','vision','judge','reranker','transcribe')`,
  ),
  check(
    "llm_configs_provider_check",
    sql`${t.provider} IN ('openai','openrouter','ollama','anthropic','jina','cohere')`,
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

// ---- Реферальные/партнёрские коды ----------------------------------------
//
// Тенант генерирует коды и раздаёт партнёрам. Партнёры передают код новым
// клиентам при регистрации → tenants.referred_by_code заполняется, uses_count++.
// Таблица БЕЗ RLS — при регистрации нет контекста tenant_id и нужен
// cross-tenant lookup по code (аналогично таблице tenants).
export const referralCodes = pgTable("referral_codes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  usesCount: integer("uses_count").notNull().default(0),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_referral_codes_code").on(t.code),
  index("idx_referral_codes_tenant").on(t.tenantId),
]);

// ---- Early access waitlist ----------------------------------------------
//
// Публичные заявки на alpha/early-access. Таблица БЕЗ RLS: на момент заявки
// tenant ещё не существует. API пишет только нормализованный email + контекст,
// чтение в продуктовую админку можно добавить отдельным superadmin route.
export const earlyAccessSignups = pgTable("early_access_signups", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  company: text("company"),
  useCase: text("use_case"),
  source: text("source").notNull().default("landing"),
  locale: text("locale").notNull().default("ru"),
  status: text("status").notNull().default("new"),
  tenantId: integer("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  inviteId: integer("invite_id").references(() => adminInvites.id, { onDelete: "set null" }),
  approvedAt: integer("approved_at"),
  approvedByAdminId: integer("approved_by_admin_id").references(() => admins.id, {
    onDelete: "set null",
  }),
  userAgent: text("user_agent"),
  ip: text("ip"),
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_early_access_email").on(t.email),
  index("idx_early_access_status_created").on(t.status, t.createdAt),
  index("idx_early_access_source").on(t.source),
  index("idx_early_access_tenant").on(t.tenantId),
]);

// Webhook-уведомления при смене стадии лида. Tenant настраивает URL;
// при каждом lead.stage_changed мы шлём POST с JSON-payload и опциональной
// HMAC-подписью (X-Signature: sha256=<hex>).
export const stageWebhooks = pgTable("stage_webhooks", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_stage_webhooks_tenant").on(t.tenantId),
  index("idx_stage_webhooks_active").on(t.tenantId).where(sql`is_active = TRUE`),
]);

// Шаблоны сообщений для рассылок. Шарятся между всеми менеджерами тенанта.
export const messageTemplates = pgTable("message_templates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_message_templates_tenant").on(t.tenantId),
]);

export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").notNull().references(() => admins.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_password_resets_token_hash").on(t.tokenHash),
  index("idx_password_resets_admin").on(t.adminId),
  uniqueIndex("uniq_password_resets_admin_active").on(t.adminId).where(sql`used_at IS NULL`),
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

// ---- Notifications (Operator Companion Bot) ----------------------------

// Правила уведомлений: КОГДА и КОГО уведомлять.
// Позволяет гибко настраивать алерты (например, "только VIP-сделки в группу #Sales").
export const notificationRules = pgTable("notification_rules", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // lead_intake_complete | stage_changed | human_takeover | document_uploaded | high_value_deal | lead_stale
  eventType: text("event_type").notNull(),
  // JSON-фильтры: { toStage: 'awaiting_payment', minAmount: 1000, asset: 'usdt' }
  conditionJson: text("condition_json").notNull().default("{}"),
  // telegram_group | telegram_personal | slack (future)
  channelType: text("channel_type").notNull().default("telegram_group"),
  // ID чата, группы или канала
  targetId: text("target_id").notNull(),
  // low | normal | high (определяет звук уведомления или приоритет в UI)
  priority: text("priority").notNull().default("normal"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_notif_rules_tenant").on(t.tenantId, t.isActive),
  index("idx_notif_rules_event").on(t.tenantId, t.eventType),
]);

// Шаблоны уведомлений для операторов.
// Позволяют менять текст алертов (например, перевести на другой язык или добавить специфику).
export const notificationTemplates = pgTable("notification_templates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // slug соответствует eventType в notification_rules (stage_changed, human_takeover, etc.)
  slug: text("slug").notNull(),
  // Текст с плейсхолдерами {{displayName}}, {{fromStage}}, {{toStage}}, etc.
  body: text("body").notNull(),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_notif_tpl_tenant_slug").on(t.tenantId, t.slug),
]);

// Одноразовые токены для привязки Telegram-группы к правилу уведомлений.
// Генерируются в Admin UI, передаются боту через /setup <token> в группе.
export const notificationGroupTokens = pgTable("notification_group_tokens", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").notNull().references(() => admins.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull().default("stage_changed"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_group_tokens_token").on(t.token),
]);

// Персональные настройки оператора для уведомлений.
export const operatorSettings = pgTable("operator_settings", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").notNull().references(() => admins.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // Личный Telegram ID (привязывается через /start у бота)
  telegramChatId: text("telegram_chat_id"),
  // Токен для привязки (генерируется в UI, передаётся в /start)
  linkToken: text("link_token").unique(),
  linkTokenExpiresAt: integer("link_token_expires_at"),
  // Уведомлять только о лидах, назначенных на этого админа
  notifyOnAssignedOnly: boolean("notify_on_assigned_only").notNull().default(true),
  // ── Бот-информер владельца (миграция 0032) ──────────────────────────────
  // Порог важности: silent | critical | important | all (см. admin-informer.ts).
  informerLevel: text("informer_level").notNull().default("important"),
  // JSON-карта тоглов тем {"leads":true,...}; NULL = все темы включены.
  informerTopics: text("informer_topics"),
  // Расписание дайджеста: off | daily | shift (2×/день).
  informerDigest: text("informer_digest").notNull().default("daily"),
  // Локальный час отправки дайджеста (0..23) в informerTz.
  informerDigestHour: integer("informer_digest_hour").notNull().default(9),
  informerTz: text("informer_tz").notNull().default("UTC"),
  // epoch; пока now() < muted_until — реалтайм гасится (дайджест копится).
  informerMutedUntil: integer("informer_muted_until"),
  // epoch последней отправленной сводки (анти-повтор дайджеста).
  informerLastDigestAt: integer("informer_last_digest_at"),
  // Тихие часы (DND): локальные часы 0..23 в informerTz. Если from==to или NULL —
  // выключено. Окно может переходить через полночь (напр. 22→8).
  informerQuietFrom: integer("informer_quiet_from"),
  informerQuietTo: integer("informer_quiet_to"),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_op_settings_admin").on(t.adminId),
  index("idx_op_settings_tenant").on(t.tenantId),
  index("idx_op_settings_link_token").on(t.linkToken),
  check(
    "operator_settings_informer_level_check",
    sql`${t.informerLevel} IN ('silent','critical','important','all')`,
  ),
  check(
    "operator_settings_informer_digest_check",
    sql`${t.informerDigest} IN ('off','daily','shift')`,
  ),
]);

// Лента уведомлений владельца (миграция 0032). Источник дайджеста + scrollback
// для бот-команды «/last» + persisted-дедуп. БЕЗ RLS (как operator_settings):
// читается из operator-bot webhook без tenant-контекста — изоляция явным
// tenant_id-фильтром в репозитории.
export const adminNotifications = pgTable("admin_notifications", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  // SET NULL при удалении админа — строку истории сохраняем.
  adminId: integer("admin_id").references(() => admins.id, { onDelete: "set null" }),
  topic: text("topic").notNull(), // leads | escalation | orders | system
  severity: text("severity").notNull(), // critical | important | info
  kind: text("kind").notNull(), // исходный тип события (order_stuck, stage_changed, ...)
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  dedupKey: text("dedup_key").notNull(),
  targetChatId: text("target_chat_id"),
  // epoch реалтайм-доставки; NULL = в реалтайм не слали (ждёт дайджеста).
  deliveredAt: integer("delivered_at"),
  // epoch батча дайджеста, в который вошло; NULL = ещё не сведено.
  digestBatchId: integer("digest_batch_id"),
  readAt: integer("read_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  index("idx_admin_notif_tenant_admin_created").on(t.tenantId, t.adminId, t.createdAt),
  index("idx_admin_notif_dedup").on(t.tenantId, t.dedupKey, t.createdAt),
  check(
    "admin_notifications_topic_check",
    sql`${t.topic} IN ('leads','escalation','orders','system')`,
  ),
  check(
    "admin_notifications_severity_check",
    sql`${t.severity} IN ('critical','important','info')`,
  ),
]);

// Durable pending previews for reactive operator bot actions. Telegram callback
// data only carries draft_key; full text and authorization live tenant-scoped here.
export const operatorActionDrafts = pgTable(
  "operator_action_drafts",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    adminId: integer("admin_id").references(() => admins.id, {
      onDelete: "set null",
    }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    draftKey: text("draft_key").notNull(),
    chatId: text("chat_id").notNull(),
    kind: text("kind").notNull().default("client_reply"),
    status: text("status").notNull().default("pending"),
    text: text("text").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    messageId: integer("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    outboundQueueId: integer("outbound_queue_id").references(() => outboundQueue.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull().default(epochNow()),
    expiresAt: integer("expires_at").notNull(),
    handledAt: integer("handled_at"),
    updatedAt: integer("updated_at").notNull().default(epochNow()),
  },
  (t) => [
    check(
      "operator_action_drafts_kind_check",
      sql`${t.kind} IN ('client_reply')`,
    ),
    check(
      "operator_action_drafts_status_check",
      sql`${t.status} IN ('pending','sent','cancelled','expired','failed')`,
    ),
    uniqueIndex("uniq_operator_action_drafts_key").on(t.tenantId, t.draftKey),
    index("idx_operator_action_drafts_conversation").on(
      t.tenantId,
      t.conversationId,
      sql`${t.createdAt} DESC`,
    ),
    index("idx_operator_action_drafts_pending")
      .on(t.tenantId, t.status, t.expiresAt)
      .where(sql`status = 'pending'`),
  ],
);

// ---- Exchange (обменный пункт) ----------------------------------------
// Курсы + формула. Итоговый курс = base_rate * (1 - margin_pct/100), минус
// fee_fixed_thb из итога. Один активный ряд на (tenant, asset, quote, network).
export const exchangeRates = pgTable("exchange_rates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  asset: text("asset").notNull(),
  quoteAsset: text("quote_asset").notNull().default("THB"),
  network: text("network").notNull().default(""),
  baseRate: doublePrecision("base_rate").notNull(),
  // 'multiply' (крипта: thb=amount*rate) | 'divide' (RUB: thb=amount/rate)
  quoteMode: text("quote_mode").notNull().default("multiply"),
  marginPct: doublePrecision("margin_pct").notNull().default(0),
  feeFixedThb: doublePrecision("fee_fixed_thb").notNull().default(0),
  minAmountFrom: doublePrecision("min_amount_from"),
  maxAmountFrom: doublePrecision("max_amount_from"),
  isActive: boolean("is_active").notNull().default(true),
  // base_rate тянется рыночным фидом (worker), маржа/комиссия — ручные.
  autoUpdate: boolean("auto_update").notNull().default(false),
  updatedByAdminId: integer("updated_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_exchange_rates_dir").on(t.tenantId, t.asset, t.quoteAsset, t.network),
  index("idx_exchange_rates_tenant_active").on(t.tenantId, t.isActive),
]);

// Одобренные диапазоны публичной rate-card. Это слой поверх базового рыночного
// курса: система предлагает display_rate по формуле отклонения, админ одобряет.
export const exchangeRateTiers = pgTable("exchange_rate_tiers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  asset: text("asset").notNull(),
  quoteAsset: text("quote_asset").notNull().default("THB"),
  network: text("network").notNull().default(""),
  rangeBasis: text("range_basis").notNull().default("target_thb"),
  minAmount: doublePrecision("min_amount").notNull(),
  maxAmount: doublePrecision("max_amount"),
  marketRate: doublePrecision("market_rate").notNull(),
  displayRate: doublePrecision("display_rate").notNull(),
  deviationPct: doublePrecision("deviation_pct").notNull(),
  formulaJson: text("formula_json"),
  isActive: boolean("is_active").notNull().default(true),
  approvedByAdminId: integer("approved_by_admin_id").references(() => admins.id, { onDelete: "set null" }),
  approvedAt: integer("approved_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("exchange_rate_tiers_range_basis_check", sql`${t.rangeBasis} IN ('target_thb','source_amount')`),
  uniqueIndex("uniq_exchange_rate_tier").on(t.tenantId, t.asset, t.quoteAsset, t.network, t.rangeBasis, t.minAmount),
  index("idx_exchange_rate_tiers_active").on(t.tenantId, t.asset, t.isActive),
]);

// Per-tenant настройки обменника (нет строки → платформенные дефолты):
// частота обновления auto-курсов планировщиком + порог «курсы устарели» (ops-watch).
// last-refresh планировщик держит в памяти процесса (на рестарте рефрешит всех).
export const exchangeSettings = pgTable("exchange_settings", {
  tenantId: integer("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  // как часто планировщик обновляет auto-курсы тенанта (сек). 180 = 3 мин.
  rateRefreshSec: integer("rate_refresh_sec").notNull().default(180),
  // порог «курсы устарели» для ops-watch (сек). NULL → авто: max(env, 3 × refresh).
  feedStaleSec: integer("feed_stale_sec"),
  // котируемая (локальная) валюта обменника: PHP (дефолт платформы), THB, VND…
  quoteAsset: text("quote_asset").notNull().default("PHP"),
  // отправлять ли клиенту сообщение при автоматической передаче exchange-диалога оператору.
  handoffCustomerNotice: boolean("handoff_customer_notice").notNull().default(true),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("exchange_settings_refresh_check", sql`${t.rateRefreshSec} >= 60 AND ${t.rateRefreshSec} <= 86400`),
  check("exchange_settings_stale_check", sql`${t.feedStaleSec} IS NULL OR ${t.feedStaleSec} >= 60`),
  check("exchange_settings_quote_asset_check", sql`${t.quoteAsset} ~ '^[A-Z]{3}$'`),
]);

// Заявка на обмен. rate/amount_to_thb — снапшот на момент создания заявки.
// Оборот считается агрегатом SUM(amount_to_thb) по completed.
export const exchangeOrders = pgTable("exchange_orders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  telegramId: text("telegram_id"),
  verificationId: text("verification_id"),
  direction: text("direction").notNull(),
  assetFrom: text("asset_from").notNull(),
  network: text("network").notNull().default(""),
  amountMode: text("amount_mode").notNull().default("source_amount"),
  requestedAmount: doublePrecision("requested_amount"),
  amountFrom: doublePrecision("amount_from").notNull(),
  rate: doublePrecision("rate").notNull(),
  amountToThb: doublePrecision("amount_to_thb").notNull(),
  paymentMethod: text("payment_method"),
  paymentRail: text("payment_rail"),
  sourceBank: text("source_bank"),
  payerName: text("payer_name"),
  thirdPartyApproved: boolean("third_party_approved").notNull().default(false),
  payoutMethod: text("payout_method"),
  payoutLocation: text("payout_location"),
  payoutDestinationJson: text("payout_destination_json"),
  payoutCode: text("payout_code"),
  payoutCodeExpiresAt: integer("payout_code_expires_at"),
  status: text("status").notNull().default("quote"),
  requisitesJson: text("requisites_json"),
  proofJson: text("proof_json"),
  riskJson: text("risk_json"),
  rateExpiresAt: integer("rate_expires_at"),
  idempotencyKey: text("idempotency_key"),
  lastReminderAt: integer("last_reminder_at"),
  completedAt: integer("completed_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("exchange_orders_status_check", sql`${t.status} IN ('quote','awaiting_payment','paid','payout','completed','cancelled','expired')`),
  check("exchange_orders_amount_mode_check", sql`${t.amountMode} IN ('source_amount','target_thb')`),
  check("exchange_orders_payment_method_check", sql`${t.paymentMethod} IS NULL OR ${t.paymentMethod} IN ('crypto_transfer','sbp_qr','card_transfer','bank_transfer','cash')`),
  check("exchange_orders_payout_method_check", sql`${t.payoutMethod} IS NULL OR ${t.payoutMethod} IN ('office_cash','cardless_atm','courier_cash','thai_bank_transfer','atm')`),
  uniqueIndex("uniq_exchange_orders_idem").on(t.idempotencyKey),
  index("idx_exchange_orders_tenant_status").on(t.tenantId, t.status),
  index("idx_exchange_orders_tenant_contact").on(t.tenantId, t.contactId),
  index("idx_exchange_orders_tenant_created").on(t.tenantId, t.createdAt),
  index("idx_exchange_orders_awaiting_ttl").on(t.status, t.rateExpiresAt).where(sql`status = 'awaiting_payment'`),
]);

// ---- Partner services & commission ledger ------------------------------
//
// Partner billing v1 is intentionally operator-driven: partner handoff creates
// a deal, then an admin enters final turnover and the commission is calculated
// from the service/partner percentage. Partner portal and complex settlements
// can build on these tables later.
export const partners = pgTable("partners", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  contactName: text("contact_name"),
  contactChannel: text("contact_channel"),
  contactValue: text("contact_value"),
  defaultCommissionPct: doublePrecision("default_commission_pct").notNull().default(0),
  settlementCurrency: text("settlement_currency").notNull().default("THB"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("partners_status_check", sql`${t.status} IN ('active','archived')`),
  index("idx_partners_tenant_status").on(t.tenantId, t.status),
]);

export const partnerServices = pgTable("partner_services", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  funnelId: integer("funnel_id").references(() => funnels.id, { onDelete: "set null" }),
  stageDefinitionId: integer("stage_definition_id").references(() => stageDefinitions.id, { onDelete: "set null" }),
  commissionPct: doublePrecision("commission_pct").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_partner_services_name").on(t.tenantId, t.partnerId, t.name),
  index("idx_partner_services_tenant_active").on(t.tenantId, t.isActive),
  index("idx_partner_services_stage").on(t.tenantId, t.stageDefinitionId),
]);

export const serviceCatalogItems = pgTable("service_catalog_items", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  routeType: text("route_type").notNull().default("manual"),
  funnelId: integer("funnel_id").references(() => funnels.id, { onDelete: "set null" }),
  partnerServiceId: integer("partner_service_id").references(() => partnerServices.id, { onDelete: "set null" }),
  webhookUrl: text("webhook_url"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("service_catalog_route_type_check", sql`${t.routeType} IN ('manual','funnel','partner_service','webhook')`),
  uniqueIndex("uniq_service_catalog_slug").on(t.tenantId, t.slug),
  index("idx_service_catalog_tenant_active").on(t.tenantId, t.isActive, t.sortOrder),
  index("idx_service_catalog_funnel").on(t.tenantId, t.funnelId),
  index("idx_service_catalog_partner_service").on(t.tenantId, t.partnerServiceId),
]);

export const partnerDeals = pgTable("partner_deals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  partnerId: integer("partner_id").references(() => partners.id, { onDelete: "set null" }),
  serviceId: integer("service_id").references(() => partnerServices.id, { onDelete: "set null" }),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  stageDefinitionId: integer("stage_definition_id").references(() => stageDefinitions.id, { onDelete: "set null" }),
  status: text("status").notNull().default("sent"),
  handoffUrl: text("handoff_url"),
  handoffMode: text("handoff_mode").notNull().default("fire_and_forget"),
  grossAmount: doublePrecision("gross_amount"),
  currency: text("currency").notNull().default("THB"),
  commissionPct: doublePrecision("commission_pct").notNull().default(0),
  commissionAmount: doublePrecision("commission_amount"),
  proofJson: text("proof_json"),
  notes: text("notes"),
  settlementId: integer("settlement_id").references(() => partnerSettlements.id, { onDelete: "set null" }),
  sentAt: integer("sent_at"),
  acceptedAt: integer("accepted_at"),
  completedAt: integer("completed_at"),
  cancelledAt: integer("cancelled_at"),
  settledAt: integer("settled_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("partner_deals_status_check", sql`${t.status} IN ('sent','accepted','rejected','completed','cancelled','disputed','settled')`),
  check("partner_deals_mode_check", sql`${t.handoffMode} IN ('fire_and_forget','await_callback')`),
  index("idx_partner_deals_tenant_status").on(t.tenantId, t.status),
  index("idx_partner_deals_partner").on(t.tenantId, t.partnerId),
  index("idx_partner_deals_lead").on(t.tenantId, t.leadId),
  index("idx_partner_deals_settlement").on(t.tenantId, t.settlementId),
]);

export const partnerSettlements = pgTable("partner_settlements", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "cascade" }),
  periodStart: integer("period_start").notNull(),
  periodEnd: integer("period_end").notNull(),
  status: text("status").notNull().default("draft"),
  totalGross: doublePrecision("total_gross").notNull().default(0),
  totalCommission: doublePrecision("total_commission").notNull().default(0),
  currency: text("currency").notNull().default("THB"),
  paidAt: integer("paid_at"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("partner_settlements_status_check", sql`${t.status} IN ('draft','issued','paid','cancelled')`),
  index("idx_partner_settlements_partner").on(t.tenantId, t.partnerId, t.periodStart),
]);

// ---- Provider relay & brokered orders ----------------------------------
//
// Cross-channel broker flow: customer can request a service in one channel,
// provider can negotiate in another, and the order aggregate mediates status,
// payment, commission, and what each side is allowed to see.
export const providerProfiles = pgTable("provider_profiles", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  status: text("status").notNull().default("active"),
  serviceArea: text("service_area"),
  defaultCommissionPct: doublePrecision("default_commission_pct").notNull().default(0),
  notes: text("notes"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("provider_profiles_status_check", sql`${t.status} IN ('active','paused','archived')`),
  uniqueIndex("uniq_provider_profiles_contact").on(t.tenantId, t.contactId),
  index("idx_provider_profiles_tenant_status").on(t.tenantId, t.status),
  index("idx_provider_profiles_category").on(t.tenantId, t.category),
]);

export const providerServices = pgTable("provider_services", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  providerId: integer("provider_id").notNull().references(() => providerProfiles.id, { onDelete: "cascade" }),
  serviceType: text("service_type").notNull(),
  name: text("name").notNull(),
  serviceArea: text("service_area"),
  pricingPolicyJson: text("pricing_policy_json").notNull().default("{}"),
  commissionPct: doublePrecision("commission_pct"),
  isActive: boolean("is_active").notNull().default(true),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  uniqueIndex("uniq_provider_services_name").on(t.tenantId, t.providerId, t.serviceType, t.name),
  index("idx_provider_services_tenant_active").on(t.tenantId, t.isActive),
  index("idx_provider_services_type").on(t.tenantId, t.serviceType, t.isActive),
]);

export const serviceOrders = pgTable("service_orders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  customerContactId: integer("customer_contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  customerConversationId: integer("customer_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  assignedProviderId: integer("assigned_provider_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  requestType: text("request_type").notNull(),
  status: text("status").notNull().default("intake"),
  summary: text("summary"),
  quotedAmount: doublePrecision("quoted_amount"),
  customerAmount: doublePrecision("customer_amount"),
  commissionPct: doublePrecision("commission_pct"),
  commissionAmount: doublePrecision("commission_amount"),
  currency: text("currency").notNull().default("THB"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentProvider: text("payment_provider"),
  paymentRef: text("payment_ref"),
  idempotencyKey: text("idempotency_key"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  expiresAt: integer("expires_at"),
  confirmedAt: integer("confirmed_at"),
  completedAt: integer("completed_at"),
  cancelledAt: integer("cancelled_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("service_orders_status_check", sql`${t.status} IN ('intake','matching','awaiting_provider','provider_declined','offer_ready','awaiting_customer_payment','paid','confirmed','fulfilled','cancelled','failed')`),
  check("service_orders_payment_status_check", sql`${t.paymentStatus} IN ('unpaid','pending','paid','refunded','failed')`),
  uniqueIndex("uniq_service_orders_idem").on(t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  index("idx_service_orders_tenant_status").on(t.tenantId, t.status),
  index("idx_service_orders_customer").on(t.tenantId, t.customerContactId),
  index("idx_service_orders_lead").on(t.tenantId, t.leadId),
  index("idx_service_orders_provider").on(t.tenantId, t.assignedProviderId),
  index("idx_service_orders_payment").on(t.tenantId, t.paymentStatus),
]);

export const providerRequests = pgTable("provider_requests", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => serviceOrders.id, { onDelete: "cascade" }),
  providerId: integer("provider_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  providerConversationId: integer("provider_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  channelId: integer("channel_id").references(() => channels.id, { onDelete: "set null" }),
  outboundQueueId: integer("outbound_queue_id").references(() => outboundQueue.id, { onDelete: "set null" }),
  status: text("status").notNull().default("draft"),
  quotedAmount: doublePrecision("quoted_amount"),
  customerAmount: doublePrecision("customer_amount"),
  commissionAmount: doublePrecision("commission_amount"),
  currency: text("currency").notNull().default("THB"),
  availableAt: integer("available_at"),
  quoteExpiresAt: integer("quote_expires_at"),
  responseText: text("response_text"),
  idempotencyKey: text("idempotency_key"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  sentAt: integer("sent_at"),
  respondedAt: integer("responded_at"),
  expiredAt: integer("expired_at"),
  cancelledAt: integer("cancelled_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("provider_requests_status_check", sql`${t.status} IN ('draft','sent','seen','quoted','accepted','declined','expired','cancelled','failed')`),
  uniqueIndex("uniq_provider_requests_idem").on(t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  index("idx_provider_requests_order").on(t.tenantId, t.orderId),
  index("idx_provider_requests_provider_status").on(t.tenantId, t.providerId, t.status),
  index("idx_provider_requests_tenant_status").on(t.tenantId, t.status),
  index("idx_provider_requests_quote_ttl").on(t.status, t.quoteExpiresAt).where(sql`status = 'quoted'`),
]);

export const orderEvents = pgTable("order_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => serviceOrders.id, { onDelete: "cascade" }),
  providerRequestId: integer("provider_request_id").references(() => providerRequests.id, { onDelete: "set null" }),
  conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
  actorType: text("actor_type").notNull().default("system"),
  eventType: text("event_type").notNull(),
  dataJson: text("data_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
}, (t) => [
  check("order_events_actor_type_check", sql`${t.actorType} IN ('system','customer','provider','operator','payment')`),
  index("idx_order_events_order_created").on(t.tenantId, t.orderId, t.createdAt),
  index("idx_order_events_provider_request").on(t.tenantId, t.providerRequestId),
  index("idx_order_events_type").on(t.tenantId, t.eventType),
]);

export const serviceOrderPayments = pgTable("service_order_payments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => serviceOrders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalIntentId: text("external_intent_id"),
  externalSessionId: text("external_session_id"),
  status: text("status").notNull().default("created"),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("THB"),
  idempotencyKey: text("idempotency_key"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
  paidAt: integer("paid_at"),
  failedAt: integer("failed_at"),
  cancelledAt: integer("cancelled_at"),
  refundedAt: integer("refunded_at"),
}, (t) => [
  check("service_order_payments_status_check", sql`${t.status} IN ('created','pending','paid','failed','cancelled','refunded')`),
  uniqueIndex("uniq_service_order_payments_idem").on(t.tenantId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  uniqueIndex("uniq_service_order_payments_provider_intent").on(t.tenantId, t.provider, t.externalIntentId).where(sql`external_intent_id IS NOT NULL`),
  uniqueIndex("uniq_service_order_payments_provider_session").on(t.tenantId, t.provider, t.externalSessionId).where(sql`external_session_id IS NOT NULL`),
  index("idx_service_order_payments_order").on(t.tenantId, t.orderId),
  index("idx_service_order_payments_status").on(t.tenantId, t.status),
]);

export const serviceOrderCommissions = pgTable("service_order_commissions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => serviceOrders.id, { onDelete: "cascade" }),
  providerId: integer("provider_id").references(() => providerProfiles.id, { onDelete: "set null" }),
  paymentId: integer("payment_id").references(() => serviceOrderPayments.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  grossAmount: doublePrecision("gross_amount").notNull(),
  commissionPct: doublePrecision("commission_pct").notNull().default(0),
  commissionAmount: doublePrecision("commission_amount").notNull().default(0),
  currency: text("currency").notNull().default("THB"),
  source: text("source").notNull().default("payment"),
  idempotencyKey: text("idempotency_key"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  earnedAt: integer("earned_at"),
  refundedAt: integer("refunded_at"),
  paidOutAt: integer("paid_out_at"),
  createdAt: integer("created_at").notNull().default(epochNow()),
  updatedAt: integer("updated_at").notNull().default(epochNow()),
}, (t) => [
  check("service_order_commissions_status_check", sql`${t.status} IN ('pending','earned','void','refunded','paid_out')`),
  uniqueIndex("uniq_service_order_commissions_idem").on(t.tenantId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  index("idx_service_order_commissions_order").on(t.tenantId, t.orderId),
  index("idx_service_order_commissions_provider").on(t.tenantId, t.providerId),
  index("idx_service_order_commissions_payment").on(t.tenantId, t.paymentId),
  index("idx_service_order_commissions_status").on(t.tenantId, t.status),
]);
