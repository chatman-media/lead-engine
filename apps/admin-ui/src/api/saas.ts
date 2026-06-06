// Minimal API client для SaaS endpoint'ов на новом backend'е (apps/api).
// Существующий api.ts (1251 LOC) bound к legacy /admin/api/* — мы его не
// трогаем; SaaS-flow живёт здесь под /api/auth/* и /api/admin/*.

export interface Admin {
  id: number;
  email: string;
  name?: string | null;
  role: "superadmin" | "manager";
  tenantId: number;
}

export interface Tenant {
  id: number;
  slug: string;
  plan: string;
}

export interface TenantRow {
  id: number;
  slug: string;
  plan: string;
  status: string;
  createdAt: number;
  ownerEmail: string | null;
  leadCount: number;
  conversationCount: number;
}

export interface KbDoc {
  id: number;
  source: string;
  title: string;
  topic: string | null;
  createdAt: number;
}

export interface KbSuggestion {
  id: number;
  tenantId: number;
  questionText: string;
  answerDraft: string | null;
  status: "pending" | "ingested" | "rejected";
  sourceConversationId: number | null;
  sourceMessageId: number | null;
  decidedByAdminId: number | null;
  decidedAt: number | null;
  kbDocumentId: number | null;
  rejectedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KbUploadResult {
  documentId: number;
  source: string;
  chunks: number;
  created: boolean;
}

export type LlmPurpose = "chat" | "embed" | "vision" | "judge" | "reranker" | "transcribe";
export type LlmProvider = "openai" | "openrouter" | "ollama" | "anthropic" | "jina" | "cohere";

export interface LlmConfig {
  purpose: LlmPurpose;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  embedDim: number | null;
  timeoutMs: number | null;
  hasSecret: boolean;
  updatedAt: number;
}

export interface VerticalInfo {
  slug: string;
  displayName: string;
  version: number;
  hasStyles: boolean;
  hasKbDocuments: boolean;
  hasFunnel: boolean;
}

export interface UpsertLlmConfigInput {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  embedDim?: number;
  timeoutMs?: number;
}

export type ChannelKind =
  | "telegram_bot"
  | "telegram_userbot"
  | "whatsapp"
  | "facebook"
  | "web";
export type ChannelStatus = "active" | "paused" | "error";

export interface ChannelItem {
  id: number;
  kind: ChannelKind;
  externalId: string;
  status: ChannelStatus;
  hasCredentials: boolean;
  /** Для telegram_userbot/bot — @username из metadata (если есть). */
  username?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserbotLoginStartResult {
  ok: boolean;
  loginId: string;
  awaiting: "code";
}

/** verify/2fa: либо запрашиваем 2FA, либо логин завершён (канал создан). */
export type UserbotLoginStepResult =
  | { ok: true; awaiting: "2fa" }
  | {
      ok: true;
      id: number;
      updated: boolean;
      externalId: string;
      username: string | null;
      reloadError?: string;
    };

export interface CreateTelegramChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  username: string;
  botId: number;
  webhookSet?: boolean;
  webhookError?: string;
}

export interface CreateWhatsAppChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  phoneNumberId: string;
  verifiedName?: string;
  displayPhoneNumber?: string;
  webhookSetupHint?: {
    url: string;
    verifyToken: string;
    appSecretHint: string;
  };
  reloadError?: string;
}

export interface CreateFacebookChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  pageId: string;
  pageName?: string;
  webhookSetupHint?: {
    url: string;
    verifyToken: string;
    appSecretHint: string;
  };
  reloadError?: string;
}

export interface CreateWebChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  externalId: string;
  brandName?: string;
  primaryColor?: string;
  snippet?: {
    html: string;
    wsUrl: string;
    demoUrl: string;
  };
  snippetHint?: string;
  reloadError?: string;
}

export interface AdminRow {
  id: number;
  email: string;
  role: "superadmin" | "manager";
  createdAt: number;
}

export interface InviteRow {
  id: number;
  email: string;
  role: "superadmin" | "manager";
  status: "pending" | "accepted" | "expired";
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export interface CreateInviteResult {
  ok: boolean;
  id: number;
  token: string;
  shareUrl?: string;
  email: string;
  role: "superadmin" | "manager";
  expiresAt: number;
}

export interface WebSnippet {
  ok: boolean;
  externalId: string;
  brandName?: string;
  primaryColor?: string;
  snippet: {
    html: string;
    wsUrl: string;
    demoUrl: string;
  };
}

export interface ConversationListItem {
  id: number;
  contactId: number;
  contactName: string | null;
  source: string;
  mode: string;
  status: string;
  unreadCount: number;
  assignedAdminId: number | null;
  currentStage: string | null;
  lastMessageAt: number | null;
  createdAt: number;
  escalatedAt?: number | null;
  lastMessagePreview?: string | null;
}

export interface ConversationDetail {
  id: number;
  contactId: number;
  contactName: string | null;
  source: string;
  mode: string;
  status: string;
  unreadCount: number;
  assignedAdminId: number | null;
  currentStage: string | null;
  lastMessageAt: number | null;
  createdAt: number;
  escalatedAt: number | null;
}

export interface MessageRow {
  id: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
  metaJson: string | null;
  createdAt: number;
  stage: string | null;
  deletedAt: number | null;
}

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  latencyMs?: number;
  message?: string;
}

export interface DiagnosticsResult {
  checks: DiagnosticCheck[];
  summary: {
    overall: DiagnosticStatus;
    passed: number;
    failed: number;
    warned: number;
    total: number;
  };
}

export type PlanKind = "free" | "starter" | "pro" | "enterprise";

export interface UsageReport {
  periodDays: number;
  totals: {
    calls: number;
    errors: number;
    successRate: number;
    avgLatencyMs: number;
  };
  byPurpose: Array<{
    purpose: string;
    calls: number;
    errors: number;
    avgLatencyMs: number;
  }>;
  byProvider: Array<{ provider: string; calls: number }>;
  thisMonth: { calls: number; errors: number; since: number };
}

export interface BillingPlan {
  plan: {
    kind: PlanKind;
    label: string;
    priceUsd: number | null;
    maxChannels: number;
    maxKbDocuments: number;
    rateLimitPerMinute: number;
    rateLimitPerHour: number;
  };
  usage: {
    channels: number;
    kbDocuments: number;
  };
  status: "ok" | "over_limit_channels" | "over_limit_kb";
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  period_start: number;
  period_end: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  description: string | null;
}

export interface TenantInfo {
  id: number;
  slug: string;
  plan: string;
  status: "active" | "suspended" | "deleted";
  llmBillingMode: "byok" | "managed";
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  adminId: number | null;
  adminEmail: string | null;
  createdAt: number;
}

export interface OnboardingStatus {
  channelConnected: boolean;
  channelKind?: string;
  channelExternalId?: string;
  chatLlmConfigured: boolean;
  chatProvider?: string;
  chatModel?: string;
  chatHasSecret?: boolean;
  embedLlmConfigured: boolean;
  embedProvider?: string;
  embedModel?: string;
  hasKbDocuments: boolean;
  /** Активная вертикаль тенанта (funnels.vertical_template_id), напр. "exchange". */
  vertical?: string | null;
  isExchange?: boolean;
  funnelInstalled?: boolean;
  activeRateCount?: number;
  requisiteCount?: number;
  done: boolean;
}

// ── Lead pipeline types ──────────────────────────────────────────────────

export type StageKind = "intake" | "active" | "terminal_won" | "terminal_lost";
/** Макро-фаза костяка — хранится только на active-стадиях. */
export type StagePhase = "qualify" | "offer" | "clear" | "fulfill";
export type StageType =
  | "form_fill"
  | "document_upload"
  | "document_signature"
  | "rate_confirmation"
  | "external_approval"
  | "payment"
  | "waiting"
  | "awaiting_operator"
  | "interaction"
  | "assessment"
  | "milestone";
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "boolean"
  | "phone"
  | "email"
  | "file"
  | "photo"
  | "video";

export interface StageField {
  id: number;
  stageId: number;
  slug: string;
  displayName: string;
  fieldType: FieldType;
  required: boolean;
  position: number;
  optionsJson: string;
  validationJson: string;
  hint: string | null;
  aiExtractable: boolean;
}

export interface StageDefinition {
  id: number;
  funnelId: number;
  slug: string;
  displayName: string;
  description: string | null;
  position: number;
  kind: StageKind;
  stageType: StageType;
  phase: StagePhase | null;
  configJson: string;
  nextStages: string[];
  staleTimeoutDays: number | null;
  checkinIntervalDays: number | null;
  supportMode: boolean;
  color: string | null;
  icon: string | null;
  fields: StageField[];
}

export interface FunnelData {
  funnel: { id: number; slug: string; isActive: boolean } | null;
  stages: StageDefinition[];
}

/** Сквозное распределение лидов по макро-фазам костяка (capture→…→won/lost). */
export interface PhaseStats {
  phases: Array<{ phase: string; leads: number }>;
  unassigned: number;
}

export interface WorkflowChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WorkflowPreviewField {
  slug: string;
  displayName: string;
  fieldType: string;
  required: boolean;
  aiExtractable: boolean;
}

export interface WorkflowPreviewStage {
  slug: string;
  displayName: string;
  kind: string;
  stageType: string;
  supportMode: boolean;
  nextStages: string[];
  fields: WorkflowPreviewField[];
}

export interface WorkflowChatResponse {
  reply: string;
  readyToGenerate: boolean;
  /** Полные стадии для передачи в applyWorkflow (server-shape). */
  stages?: unknown[];
  /** Компактный preview для отображения. */
  preview?: WorkflowPreviewStage[];
}

// ── AI-ассистент (copilot) ───────────────────────────────────────────────

export interface CopilotChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Предложенное ассистентом действие. Эндпоинт chat НЕ выполняет его — UI
 * рендерит карточку подтверждения и по кнопке зовёт существующие методы
 * (`installVertical` / `applyWorkflow`). `build_funnel.preview` совпадает по
 * форме с `WorkflowPreviewStage`.
 */
export type CopilotAction =
  | { type: "install_vertical"; slug: string; displayName: string }
  | { type: "build_funnel"; stages: unknown[]; preview: WorkflowPreviewStage[] }
  | { type: "navigate"; to?: string; step?: number };

export interface CopilotChatResponse {
  reply: string;
  action: CopilotAction | null;
}

export interface CopilotChatInput {
  page: string;
  context?: unknown;
  messages: CopilotChatMessage[];
}

export interface LeadListItem {
  id: number;
  state: string;
  stageDefinitionId: number | null;
  applicationId: string | null;
  createdAt: number;
  updatedAt: number;
  rejectedReason: string | null;
  contactId: number;
  contactName: string | null;
  requestType: string | null;
  requiredFieldsTotal: number;
  requiredFieldsFilled: number;
  stageName?: string | null;
  stagePhase?: string | null;
  stageType?: string | null;
  stageColor?: string | null;
  stagePosition?: number | null;
  funnelStageCount?: number | null;
  lastMessageText?: string | null;
  lastMessageAt?: number | null;
  source?: string | null;
  keyFields?: Array<{ label: string; value: string }>;
}

export interface LeadDetail {
  lead: {
    id: number;
    state: string;
    stageDefinitionId: number | null;
    applicationId: string | null;
    rejectedReason: string | null;
    createdAt: number;
    updatedAt: number;
  };
  stageDef: Omit<StageDefinition, "fields"> | null;
  fields: StageField[];
  fieldValues: Array<{ id: number; fieldId: number; valueJson: string; updatedAt: number }>;
  events: Array<{
    id: number;
    fromState: string | null;
    toState: string;
    byAdminId: number | null;
    notes: string | null;
    createdAt: number;
  }>;
  notes: Array<{
    id: number;
    byAdminId: number | null;
    body: string;
    source: string | null;
    createdAt: number;
  }>;
  contact: { id: number; displayName: string | null; attributesJson: string | null } | undefined;
}

export interface ContactItem {
  id: number;
  displayName: string | null;
}

export interface SkillItem {
  id: number;
  slug: string;
  family: string;
  displayName: string;
  description: string;
  promptFragment: string;
  applicableStagesJson: string;
  intent: string;
  isEnabled: boolean;
  createdAt: number;
}

export interface StyleItem {
  id: number;
  slug: string;
  displayName: string;
  configJson: string;
  isActive: boolean;
  version: number;
  parentId: number | null;
  createdAt: number;
}

export interface ExperimentItem {
  id: number;
  slug: string;
  status: "draft" | "running" | "paused" | "done";
  allocationJson: string;
  successMetric: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

export interface VacancyItem {
  id: number;
  tenantId: number;
  title: string;
  body: string;
  url: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardStats {
  leads: {
    total: number;
    byStage: Array<{
      slug: string;
      displayName: string;
      kind: string;
      color: string | null;
      position: number;
      count: number;
    }>;
  };
  conversations: {
    open: number;
    escalated: number;
    today: number;
  };
  messages: {
    last7days: number;
  };
}

// ── ROI dashboard ────────────────────────────────────────────────────────

export interface RoiStats {
  periodDays: number;
  leadsReceived: number;
  fastReply: {
    answered: number;
    within30: number;
    /** Доля авто-ответов ≤30с, % (null — ещё нет отвеченных сообщений). */
    rate: number | null;
    thresholdSeconds: number;
  };
  /** Диалоги, где AI ответил вне рабочих часов («пока вы спали»). */
  savedLeads: number;
  handoffs: number;
  conversions: { won: number; lost: number };
  funnel: Array<{ phase: string; leads: number }>;
  unassigned: number;
}

// ── Funnel analytics ─────────────────────────────────────────────────────

export interface FunnelAnalyticsStage {
  id: number;
  slug: string;
  displayName: string;
  kind: string;
  color: string | null;
  position: number;
  leadsCurrent: number;
  leadsEntered: number;
  avgDaysInStage: number | null;
}

export interface FunnelAnalytics {
  stages: FunnelAnalyticsStage[];
}

// ── Message templates ───────────────────────────────────────────────────

export interface MessageTemplate {
  id: number;
  tenantId: number;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

// ── Director hooks ────────────────────────────────────────────────────────

export interface DirectorHook {
  id: number;
  tenantId: number;
  name: string;
  body: string;
  triggerHint: string | null;
  isActive: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDirectorHookInput {
  name: string;
  body: string;
  triggerHint?: string;
  isActive?: boolean;
}

export interface UpdateDirectorHookInput {
  name?: string;
  body?: string;
  triggerHint?: string | null;
  isActive?: boolean;
}

export interface ReferralCode {
  id: number;
  code: string;
  usesCount: number;
  createdAt: number;
}

export interface StageWebhook {
  id: number;
  tenantId: number;
  url: string;
  hasSecret: boolean;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Bot Tester ─────────────────────────────────────────────────────────────

export interface TestScenarioStep {
  text: string;
  hint?: string;
}

export interface TestScenario {
  id: string;
  name: string;
  vertical: string;
  steps: TestScenarioStep[];
}

export interface TestOutboundPart {
  kind: "text" | "photo" | "video" | "document" | "audio";
  text?: string;
  mediaRef?: { channelId: string; externalRef: string };
  caption?: string;
}

export interface TestSendResult {
  parts: TestOutboundPart[];
  conversationId?: number;
  error?: string;
}

export interface NotificationRule {
  id: number;
  tenantId: number;
  eventType: string;
  conditionJson: string;
  channelType: string;
  targetId: string;
  priority: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationTemplate {
  id: number;
  tenantId: number;
  slug: string;
  body: string;
  updatedAt: number;
}

export interface InformerNotification {
  id: number;
  topic: string;
  severity: string;
  kind: string;
  title: string;
  body: string;
  deliveredAt: number | null;
  createdAt: number;
}

// ── Audit entry (for audit log page) ────────────────────────────────────

const TOKEN_KEY = "lead_engine_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Base URL для API. По умолчанию относительный — same-origin. На dev
 * с разнесённым Vite + apps/api: задать `VITE_API_BASE` env (например
 * "http://localhost:3000") в .env / .env.local.
 */
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    /** Optional extra fields from error response body (e.g. upgradeHint for 402). */
    public extra?: Record<string, unknown>,
  ) {
    super(`API ${status}: ${errorCode}`);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}, withAuth = true): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (withAuth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errorCode = (body.error as string | undefined) ?? res.statusText;
    // Preserve extra body fields for callers that want richer error details
    // (e.g. upgradeHint in 402 quota-exceeded responses).
    const { error: _e, ...extra } = body;
    throw new ApiError(res.status, errorCode, Object.keys(extra).length > 0 ? extra : undefined);
  }
  return res.json() as Promise<T>;
}

async function uploadMultipart<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errorCode = (body.error as string | undefined) ?? res.statusText;
    const { error: _e, ...extra } = body;
    throw new ApiError(res.status, errorCode, Object.keys(extra).length > 0 ? extra : undefined);
  }
  return res.json() as Promise<T>;
}

export interface ExchangeRate {
  id: number;
  tenantId: number;
  asset: string;
  quoteAsset: string;
  network: string;
  baseRate: number;
  quoteMode: "multiply" | "divide";
  marginPct: number;
  feeFixedThb: number;
  minAmountFrom: number | null;
  maxAmountFrom: number | null;
  isActive: boolean;
  autoUpdate: boolean;
  updatedAt: number;
}

export interface ExchangeRateInput {
  asset: string;
  quoteAsset?: string;
  network?: string;
  baseRate: number;
  quoteMode?: "multiply" | "divide";
  marginPct?: number;
  feeFixedThb?: number;
  minAmountFrom?: number | null;
  maxAmountFrom?: number | null;
  isActive?: boolean;
  autoUpdate?: boolean;
}

export interface ExchangeSettings {
  /** Как часто планировщик обновляет auto-курсы (сек). */
  rateRefreshSec: number;
  /** Порог «курсы устарели» (сек). null = авто (max(env, 3 × refresh)). */
  feedStaleSec: number | null;
}

export interface ExchangeRateCardProposal {
  asset: string;
  network: string;
  quoteMode: "multiply" | "divide";
  marketRate: number;
  message: string;
  tiers: Array<{
    minThb: number;
    maxThb: number | null;
    displayRate: number;
    deviationPct: number;
    formula: string;
  }>;
}

export interface ExchangeOrder {
  id: number;
  contactId: number | null;
  conversationId: number | null;
  leadId: number | null;
  telegramId: string | null;
  verificationId: string | null;
  direction: string;
  assetFrom: string;
  network: string;
  amountMode: string;
  requestedAmount: number | null;
  amountFrom: number;
  rate: number;
  amountToThb: number;
  paymentMethod: string | null;
  paymentRail: string | null;
  sourceBank: string | null;
  payerName: string | null;
  thirdPartyApproved: boolean;
  payoutMethod: string | null;
  payoutLocation: string | null;
  payoutDestinationJson: string | null;
  payoutCode: string | null;
  status: string;
  requisitesJson: string | null;
  proofJson: string | null;
  riskJson: string | null;
  rateExpiresAt: number | null;
  workflowStage?: {
    slug: string;
    label: string;
  };
  createdAt: number;
  updatedAt: number;
  /** Проставляется бэкендом при переходе статуса в 'completed'. */
  completedAt?: number | null;
}

export interface ExchangeTurnover {
  totals: { completedCount: number; openCount: number; totalThb: number };
  byContact: Array<{
    contactId: number | null;
    telegramId: string | null;
    orders: number;
    totalThb: number;
  }>;
}

export const saas = {
  // ── Auth ────────────────────────────────────────────────────────────
  signup(email: string, password: string, tenantSlug?: string, referralCode?: string) {
    return request<{ token: string; admin: Admin; tenant: Tenant }>(
      "/api/auth/signup",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          ...(tenantSlug ? { tenantSlug } : {}),
          ...(referralCode ? { referralCode } : {}),
        }),
      },
      false,
    );
  },
  login(email: string, password: string) {
    return request<{ token: string; admin: Admin }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) },
      false,
    );
  },
  logout() {
    clearToken();
    return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  },
  acceptInvite(token: string, password: string) {
    return request<{
      token: string;
      admin: Admin;
      tenant: Tenant | null;
    }>(
      "/api/auth/accept-invite",
      { method: "POST", body: JSON.stringify({ token, password }) },
      false,
    );
  },
  me() {
    return request<{ admin: Admin; tenant: Tenant | null }>("/api/auth/me");
  },

  // ── KB ──────────────────────────────────────────────────────────────
  listDocs() {
    return request<{ items: KbDoc[] }>("/api/admin/kb/documents");
  },
  uploadJson(input: { title: string; body: string; topic?: string }) {
    return request<KbUploadResult>("/api/admin/kb/documents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  uploadFile(file: File, opts: { title?: string; topic?: string } = {}) {
    const form = new FormData();
    form.append("file", file);
    if (opts.title) form.append("title", opts.title);
    if (opts.topic) form.append("topic", opts.topic);
    return uploadMultipart<KbUploadResult>("/api/admin/kb/documents", form);
  },
  deleteDoc(id: number) {
    return request<{ ok: boolean; deleted: number }>(`/api/admin/kb/documents/${id}`, {
      method: "DELETE",
    });
  },

  // ── KB suggestions ───────────────────────────────────────────────────
  listKbSuggestions(
    opts: { status?: "pending" | "ingested" | "rejected"; limit?: number; offset?: number } = {},
  ) {
    const p = new URLSearchParams();
    if (opts.status) p.set("status", opts.status);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.offset) p.set("offset", String(opts.offset));
    return request<{ items: KbSuggestion[]; pendingCount: number; limit: number; offset: number }>(
      `/api/admin/kb/suggestions?${p}`,
    );
  },
  decideKbSuggestion(
    id: number,
    action: "approve" | "reject",
    opts: { answerDraft?: string; rejectedReason?: string } = {},
  ) {
    return request<{ ok: boolean; kbDocumentId?: number }>(`/api/admin/kb/suggestions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action, ...opts }),
    });
  },

  // ── LLM provider configs (per-tenant) ───────────────────────────────
  listLlmConfigs() {
    return request<{ items: LlmConfig[] }>("/api/admin/llm-configs");
  },
  upsertLlmConfig(purpose: LlmPurpose, input: UpsertLlmConfigInput) {
    return request<{ ok: boolean; updated: boolean; id: number }>(
      `/api/admin/llm-configs/${purpose}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
  deleteLlmConfig(purpose: LlmPurpose) {
    return request<{ ok: boolean; deleted: number }>(`/api/admin/llm-configs/${purpose}`, {
      method: "DELETE",
    });
  },

  // ── Verticals ────────────────────────────────────────────────────────
  listVerticals() {
    return request<{ items: VerticalInfo[] }>("/api/admin/verticals");
  },
  installVertical(slug: string) {
    return request<{ ok: boolean; slug: string }>(`/api/admin/verticals/${slug}/install`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // ── Channels (per-tenant) ────────────────────────────────────────────
  listChannels() {
    return request<{ items: ChannelItem[] }>("/api/admin/channels");
  },
  createTelegramChannel(botToken: string) {
    return request<CreateTelegramChannelResult>("/api/admin/channels/telegram", {
      method: "POST",
      body: JSON.stringify({ botToken }),
    });
  },
  createWhatsAppChannel(input: {
    phoneNumberId: string;
    accessToken: string;
    businessAccountId?: string;
    verifyToken?: string;
    appSecret?: string;
  }) {
    return request<CreateWhatsAppChannelResult>("/api/admin/channels/whatsapp", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  createFacebookChannel(input: { pageAccessToken: string; verifyToken?: string; appSecret?: string }) {
    return request<CreateFacebookChannelResult>("/api/admin/channels/facebook", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  createWebChannel(input: { externalId?: string; brandName?: string; primaryColor?: string } = {}) {
    return request<CreateWebChannelResult>("/api/admin/channels/web", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  getWebSnippet() {
    return request<WebSnippet>("/api/admin/channels/web/snippet");
  },
  // ── Telegram userbot (личный аккаунт, MTProto) — пошаговый логин ──────
  startUserbotLogin(phone: string, apiId?: string, apiHash?: string) {
    return request<UserbotLoginStartResult>("/api/admin/channels/userbot/start", {
      method: "POST",
      body: JSON.stringify({
        phone,
        ...(apiId?.trim() ? { apiId: apiId.trim() } : {}),
        ...(apiHash?.trim() ? { apiHash: apiHash.trim() } : {}),
      }),
    });
  },
  verifyUserbotCode(loginId: string, code: string) {
    return request<UserbotLoginStepResult>("/api/admin/channels/userbot/verify", {
      method: "POST",
      body: JSON.stringify({ loginId, code }),
    });
  },
  submitUserbot2fa(loginId: string, password: string) {
    return request<UserbotLoginStepResult>("/api/admin/channels/userbot/2fa", {
      method: "POST",
      body: JSON.stringify({ loginId, password }),
    });
  },
  deleteChannel(id: number) {
    return request<{ ok: boolean; deleted: number }>(`/api/admin/channels/${id}`, {
      method: "DELETE",
    });
  },

  // ── Onboarding ───────────────────────────────────────────────────────
  onboardingStatus() {
    return request<OnboardingStatus>("/api/admin/onboarding-status");
  },

  // ── Conversations (read-only) ────────────────────────────────────────
  listConversations(
    opts: {
      limit?: number;
      cursor?: number;
      contactId?: number;
      source?: string;
      mode?: string;
      escalated?: boolean;
      q?: string;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", String(opts.cursor));
    if (opts.contactId) params.set("contactId", String(opts.contactId));
    if (opts.source) params.set("source", opts.source);
    if (opts.mode) params.set("mode", opts.mode);
    if (opts.escalated) params.set("escalated", "1");
    if (opts.q) params.set("q", opts.q);
    const qs = params.toString();
    return request<{
      items: ConversationListItem[];
      nextCursor?: number;
    }>(`/api/admin/conversations${qs ? `?${qs}` : ""}`);
  },
  getConversation(id: number) {
    return request<{
      conversation: ConversationDetail;
      messages: MessageRow[];
    }>(`/api/admin/conversations/${id}`);
  },
  // ── Dialog simulator (dev/test) ──────────────────────────────────────────
  listSimPersonas() {
    return request<{
      personas: Array<{ id: string; name: string; displayName: string; brief: string }>;
    }>("/api/admin/sim/personas");
  },
  startSim(opts: { personaId?: string; brief?: string; displayName?: string; maxTurns?: number }) {
    return request<{
      ok: boolean;
      conversationId: number;
      displayName: string;
      maxTurns: number;
      firstMessage: string;
    }>("/api/admin/sim/start", { method: "POST", body: JSON.stringify(opts) });
  },
  deleteSim(conversationId: number) {
    return request<{ ok: boolean }>(`/api/admin/sim/${conversationId}`, { method: "DELETE" });
  },
  startSimStream(opts: {
    count: number;
    intervalSec?: number;
    personaIds?: string[];
    maxTurns?: number;
  }) {
    return request<{ ok: boolean; streamId: string; count: number; intervalSec: number }>(
      "/api/admin/sim/stream",
      { method: "POST", body: JSON.stringify(opts) },
    );
  },
  listSimStreams() {
    return request<{
      streams: Array<{ id: string; total: number; spawned: number; intervalSec: number }>;
    }>("/api/admin/sim/streams");
  },
  stopSimStream(streamId: string) {
    return request<{ ok: boolean; spawned: number; total: number }>(
      `/api/admin/sim/stream/${streamId}`,
      { method: "DELETE" },
    );
  },
  stopAllSimStreams() {
    return request<{ ok: boolean; stopped: number }>("/api/admin/sim/streams", {
      method: "DELETE",
    });
  },
  advanceConversation(id: number, text?: string) {
    return request<{
      ok: boolean;
      from: string;
      to: string;
      toDisplayName: string;
      awaitingOperator: boolean;
      terminal: boolean;
    }>(`/api/admin/conversations/${id}/advance`, {
      method: "POST",
      body: JSON.stringify(text ? { text } : {}),
    });
  },
  updateConversation(id: number, patch: { status?: string; assignedAdminId?: number | null }) {
    return request<{ ok: boolean; conversation: ConversationDetail }>(
      `/api/admin/conversations/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
  },
  replyToConversation(id: number, text: string) {
    return request<{
      ok: boolean;
      messageId: number;
      channelKind: string;
    }>(`/api/admin/conversations/${id}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  },
  setConversationMode(id: number, mode: "ai" | "human") {
    return request<{ ok: boolean; mode: "ai" | "human" }>(`/api/admin/conversations/${id}/mode`, {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  },
  deleteMessage(conversationId: number, messageId: number) {
    return request<{ ok: boolean }>(
      `/api/admin/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
      },
    );
  },

  // ── Diagnostics ──────────────────────────────────────────────────────
  /**
   * Запускает health-check'и tenant'а.
   * @param live Если true — делает реальный LLM call (~1 токен) для проверки
   *   connectivity. Добавляет check `llm.ping` в результат.
   */
  runDiagnostics(opts: { live?: boolean } = {}) {
    const qs = opts.live ? "?live=1" : "";
    return request<DiagnosticsResult>(`/api/admin/diagnostics${qs}`);
  },

  // ── Billing & plan ───────────────────────────────────────────────────
  getBillingPlan() {
    return request<BillingPlan>("/api/admin/billing/plan");
  },
  getBillingUsage(days?: number) {
    const qs = days ? `?days=${days}` : "";
    return request<UsageReport>(`/api/admin/billing/usage${qs}`);
  },
  listPlans() {
    return request<{
      plans: Array<{
        kind: PlanKind;
        label: string;
        priceUsd: number | null;
        maxChannels: number;
        maxKbDocuments: number;
      }>;
      stripeEnabled: boolean;
    }>("/api/admin/billing/plans");
  },
  createCheckoutSession(plan: "starter" | "pro") {
    return request<{ ok: boolean; url: string; sessionId: string }>("/api/admin/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
  },
  createBillingPortalSession(returnUrl?: string) {
    return request<{ ok: boolean; url: string }>("/api/admin/billing/portal", {
      method: "POST",
      body: JSON.stringify(returnUrl ? { returnUrl } : {}),
    });
  },
  listInvoices() {
    return request<{ invoices: StripeInvoice[] }>("/api/admin/billing/invoices");
  },

  // ── Tenant management ────────────────────────────────────────────────
  getTenantInfo() {
    return request<{ tenant: TenantInfo }>("/api/admin/tenant");
  },
  setTenantPaused(paused: boolean) {
    return request<{ ok: boolean; status: TenantInfo["status"]; reloadError?: string }>(
      "/api/admin/tenant/status",
      { method: "PUT", body: JSON.stringify({ paused }) },
    );
  },

  // ── Multi-admin (M4) ─────────────────────────────────────────────────
  listAdmins() {
    return request<{ items: AdminRow[] }>("/api/admin/admins");
  },
  listInvites() {
    return request<{ items: InviteRow[] }>("/api/admin/admins/invites");
  },
  inviteAdmin(input: { email: string; role: "superadmin" | "manager" }) {
    return request<CreateInviteResult>("/api/admin/admins/invite", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  revokeInvite(id: number) {
    return request<{ ok: boolean }>(`/api/admin/admins/invites/${id}`, {
      method: "DELETE",
    });
  },

  // ── Audit log (read-only) ────────────────────────────────────────────
  changePassword(currentPassword: string, newPassword: string) {
    return request<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  // Обновить профиль текущего пользователя (display name).
  updateProfile(name: string) {
    return request<{ ok: true; admin: Admin }>("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  forgotPassword(email: string) {
    return request<{ ok: true }>(
      "/api/auth/forgot-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      },
      false,
    );
  },

  resetPassword(token: string, password: string) {
    return request<{ ok: true }>(
      "/api/auth/reset-password",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      },
      false,
    );
  },

  listAuditLog(opts: { limit?: number; cursor?: number } = {}) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", String(opts.cursor));
    const qs = params.toString();
    return request<{
      items: AuditEntry[];
      nextCursor?: number;
    }>(`/api/admin/audit-log${qs ? `?${qs}` : ""}`);
  },

  // ── Lead pipeline ────────────────────────────────────────────────────
  listLeads(
    opts: {
      stageId?: number;
      state?: string;
      contactId?: number;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const p = new URLSearchParams();
    if (opts.stageId) p.set("stageId", String(opts.stageId));
    if (opts.state) p.set("state", opts.state);
    if (opts.contactId) p.set("contactId", String(opts.contactId));
    if (opts.q) p.set("q", opts.q);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.offset) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return request<{ items: LeadListItem[]; limit: number; offset: number }>(
      `/api/admin/leads${qs ? `?${qs}` : ""}`,
    );
  },
  deleteLead(id: number) {
    return request<{ ok: boolean }>(`/api/admin/leads/${id}`, { method: "DELETE" });
  },
  async exportLeadsCsv(): Promise<void> {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/admin/leads/export.csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads.csv";
    a.click();
    URL.revokeObjectURL(url);
  },
  getLead(id: number) {
    return request<LeadDetail>(`/api/admin/leads/${id}`);
  },
  moveLeadStage(id: number, stageDefinitionId: number) {
    return request<{ ok: boolean }>(`/api/admin/leads/${id}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ stageDefinitionId }),
    });
  },
  advanceLead(id: number, text?: string) {
    return request<{
      ok: boolean;
      from: string;
      to: string;
      toDisplayName: string;
      awaitingOperator: boolean;
      terminal: boolean;
    }>(`/api/admin/leads/${id}/advance`, {
      method: "POST",
      body: JSON.stringify(text ? { text } : {}),
    });
  },
  upsertLeadFieldValues(id: number, values: Array<{ fieldId: number; value: unknown }>) {
    return request<{ ok: boolean; advanced: boolean; newStageSlug: string | null }>(
      `/api/admin/leads/${id}/field-values`,
      {
        method: "PUT",
        body: JSON.stringify({ values }),
      },
    );
  },
  addLeadNote(id: number, body: string) {
    return request<{ id: number }>(`/api/admin/leads/${id}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
  sendLeadPhoto(id: number, photoRef: string, caption?: string) {
    return request<{ ok: boolean; channelKind: string }>(`/api/admin/leads/${id}/send-photo`, {
      method: "POST",
      body: JSON.stringify({ photoRef, caption }),
    });
  },
  sendLeadOffer(id: number, text: string) {
    return request<{ ok: boolean; channelKind: string }>(`/api/admin/leads/${id}/send-offer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  },
  createLead(contactId: number, stageDefinitionId?: number) {
    return request<{ id: number }>("/api/admin/leads", {
      method: "POST",
      body: JSON.stringify({ contactId, stageDefinitionId }),
    });
  },
  listContacts(opts: { q?: string; limit?: number } = {}) {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    return request<{ items: ContactItem[] }>(`/api/admin/contacts${qs ? `?${qs}` : ""}`);
  },

  // ── Funnel builder ───────────────────────────────────────────────────
  getFunnel() {
    return request<FunnelData>("/api/admin/funnel");
  },
  getPhaseStats() {
    return request<PhaseStats>("/api/admin/funnel/phase-stats");
  },
  createStage(data: {
    funnelId: number;
    slug: string;
    displayName: string;
    kind?: StageKind;
    stageType?: StageType;
    position?: number;
    color?: string;
    icon?: string;
    description?: string;
    staleTimeoutDays?: number;
    checkinIntervalDays?: number;
    supportMode?: boolean;
    nextStages?: string[];
  }) {
    return request<StageDefinition>("/api/admin/funnel/stages", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateStage(
    stageId: number,
    patch: Partial<Omit<StageDefinition, "id" | "funnelId" | "fields">>,
  ) {
    return request<{ ok: boolean }>(`/api/admin/funnel/stages/${stageId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  deleteStage(stageId: number) {
    return request<{ ok: boolean }>(`/api/admin/funnel/stages/${stageId}`, {
      method: "DELETE",
    });
  },
  reorderStages(order: Array<{ id: number; position: number }>) {
    return request<{ ok: boolean }>("/api/admin/funnel/stages/reorder", {
      method: "PATCH",
      body: JSON.stringify({ order }),
    });
  },
  createStageField(
    stageId: number,
    data: {
      slug: string;
      displayName: string;
      fieldType?: FieldType;
      required?: boolean;
      position?: number;
      hint?: string;
      aiExtractable?: boolean;
      optionsJson?: string;
    },
  ) {
    return request<StageField>(`/api/admin/funnel/stages/${stageId}/fields`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateStageField(stageId: number, fieldId: number, patch: Partial<StageField>) {
    return request<{ ok: boolean }>(`/api/admin/funnel/stages/${stageId}/fields/${fieldId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  deleteStageField(stageId: number, fieldId: number) {
    return request<{ ok: boolean }>(`/api/admin/funnel/stages/${stageId}/fields/${fieldId}`, {
      method: "DELETE",
    });
  },
  seedFunnel(template: string) {
    return request<{ ok: boolean; funnelId: number; stagesCreated: number }>(
      "/api/admin/funnel/seed",
      {
        method: "POST",
        body: JSON.stringify({ template }),
      },
    );
  },

  // ── AI Workflow Builder ──────────────────────────────────────────────
  aiWorkflowChat(messages: WorkflowChatMessage[]) {
    return request<WorkflowChatResponse>("/api/admin/workflows/ai-chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
  },
  applyWorkflow(stages: unknown[]) {
    return request<{ ok: boolean; stageCount: number }>("/api/admin/workflows/apply", {
      method: "POST",
      body: JSON.stringify({ stages }),
    });
  },

  // ── AI-ассистент (copilot) ───────────────────────────────────────────
  copilotChat(input: CopilotChatInput) {
    return request<CopilotChatResponse>("/api/admin/copilot/chat", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  getFunnelAnalytics() {
    return request<FunnelAnalytics>("/api/admin/funnel/analytics");
  },

  // ── Skills / Styles / Experiments ────────────────────────────────────
  listSkills() {
    return request<{ items: SkillItem[] }>("/api/admin/skills");
  },
  seedSkills() {
    return request<{
      ok: boolean;
      seeded: number;
      updated: number;
      skipped: number;
      total: number;
    }>("/api/admin/skills/seed", { method: "POST" });
  },
  updateSkill(slug: string, data: { isEnabled?: boolean; promptFragment?: string }) {
    return request<{ ok: boolean }>(`/api/admin/skills/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  listStyles() {
    return request<{ items: StyleItem[] }>("/api/admin/styles");
  },
  generateStyle(samples: string) {
    return request<{
      displayName: string;
      slug: string;
      personaName: string;
      personaRole: string;
      personaCompany: string;
      framework: string;
    }>("/api/admin/styles/generate", {
      method: "POST",
      body: JSON.stringify({ samples }),
    });
  },
  createStyle(data: { displayName: string; slug: string; configJson: string; isActive: boolean }) {
    return request<StyleItem>("/api/admin/styles", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateStyle(
    id: number,
    data: Partial<{ displayName: string; configJson: string; isActive: boolean }>,
  ) {
    return request<StyleItem>(`/api/admin/styles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  deleteStyle(id: number) {
    return request<{ ok: boolean }>(`/api/admin/styles/${id}`, { method: "DELETE" });
  },
  listExperiments() {
    return request<{ items: ExperimentItem[] }>("/api/admin/experiments");
  },
  createExperiment(data: { slug: string; allocationJson: string; successMetric: string }) {
    return request<ExperimentItem>("/api/admin/experiments", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateExperiment(id: number, data: Partial<{ allocationJson: string; successMetric: string }>) {
    return request<ExperimentItem>(`/api/admin/experiments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  setExperimentStatus(id: number, status: "running" | "paused" | "done") {
    return request<ExperimentItem>(`/api/admin/experiments/${id}/status`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    });
  },

  // ── Dashboard ────────────────────────────────────────────────────────
  getDashboardStats() {
    return request<DashboardStats>("/api/admin/dashboard");
  },

  getRoi(periodDays = 30) {
    return request<RoiStats>(`/api/admin/roi?period=${periodDays}`);
  },

  // ── Vacancies ────────────────────────────────────────────────────────
  listVacancies() {
    return request<{ items: VacancyItem[] }>("/api/admin/vacancies");
  },
  createVacancy(data: { title: string; body: string; url?: string; isActive?: boolean }) {
    return request<VacancyItem>("/api/admin/vacancies", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateVacancy(
    id: number,
    data: { title?: string; body?: string; url?: string | null; isActive?: boolean },
  ) {
    return request<VacancyItem>(`/api/admin/vacancies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  deleteVacancy(id: number) {
    return request<{ ok: boolean }>(`/api/admin/vacancies/${id}`, { method: "DELETE" });
  },

  // ── Stage-change webhooks ─────────────────────────────────────────────
  listStageWebhooks() {
    return request<{ items: StageWebhook[] }>("/api/admin/stage-webhooks");
  },
  createStageWebhook(data: { url: string; secret?: string; isActive?: boolean }) {
    return request<StageWebhook>("/api/admin/stage-webhooks", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateStageWebhook(
    id: number,
    data: { url?: string; secret?: string | null; isActive?: boolean },
  ) {
    return request<StageWebhook>(`/api/admin/stage-webhooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  deleteStageWebhook(id: number) {
    return request<{ ok: boolean }>(`/api/admin/stage-webhooks/${id}`, { method: "DELETE" });
  },
  testStageWebhook(id: number) {
    return request<{ ok: boolean; status?: number; body?: string; error?: string }>(
      `/api/admin/stage-webhooks/${id}/test`,
      { method: "POST" },
    );
  },

  // ── Outreach campaigns ────────────────────────────────────────────────
  sendOutreach(body: {
    text: string;
    leadIds?: number[];
    stageSlug?: string;
    scheduledAt?: number;
  }) {
    return request<{ enqueued: number; skipped: number; scheduledAt: number | null }>(
      "/api/admin/outreach",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },

  async importLeadsCsv(
    file: File,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/api/admin/leads/import`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, err.error ?? "import_failed");
    }
    return res.json() as Promise<{ imported: number; skipped: number; errors: string[] }>;
  },

  // ── Message templates ────────────────────────────────────────────────
  listMessageTemplates() {
    return request<{ items: MessageTemplate[] }>("/api/admin/message-templates");
  },
  createMessageTemplate(data: { name: string; body: string }) {
    return request<MessageTemplate>("/api/admin/message-templates", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateMessageTemplate(id: number, data: { name?: string; body?: string }) {
    return request<MessageTemplate>(`/api/admin/message-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  deleteMessageTemplate(id: number) {
    return request<{ ok: boolean }>(`/api/admin/message-templates/${id}`, { method: "DELETE" });
  },

  // ── Director hooks ────────────────────────────────────────────────────
  listDirectorHooks() {
    return request<{ items: DirectorHook[] }>("/api/admin/director-hooks");
  },
  createDirectorHook(data: CreateDirectorHookInput) {
    return request<DirectorHook>("/api/admin/director-hooks", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateDirectorHook(id: number, data: UpdateDirectorHookInput) {
    return request<{ ok: boolean }>(`/api/admin/director-hooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
  deleteDirectorHook(id: number) {
    return request<{ ok: boolean }>(`/api/admin/director-hooks/${id}`, { method: "DELETE" });
  },
  reorderDirectorHooks(ids: number[]) {
    return request<{ ok: boolean }>("/api/admin/director-hooks/reorder", {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    });
  },

  // ── Referral codes ────────────────────────────────────────────────────
  listReferralCodes() {
    return request<{ items: ReferralCode[] }>("/api/admin/referral-codes");
  },
  createReferralCode(code?: string) {
    return request<{ item: ReferralCode }>("/api/admin/referral-codes", {
      method: "POST",
      body: JSON.stringify(code ? { code } : {}),
    });
  },
  deleteReferralCode(id: number) {
    return request<{ ok: boolean }>(`/api/admin/referral-codes/${id}`, { method: "DELETE" });
  },

  // ── Superadmin ────────────────────────────────────────────────────────
  listAllTenants() {
    return request<{ items: TenantRow[] }>("/api/superadmin/tenants");
  },
  updateTenantPlan(id: number, plan: string) {
    return request<{ id: number; slug: string; plan: string }>(
      `/api/superadmin/tenants/${id}/plan`,
      {
        method: "PATCH",
        body: JSON.stringify({ plan }),
      },
    );
  },

  // ── Notifications ─────────────────────────────────────────────────────
  getNotificationSettings() {
    return request<{
      adminId: number;
      telegramChatId: string | null;
      notifyOnAssignedOnly: boolean;
      informerLevel?: string;
      informerTopics?: string | null;
      informerDigest?: string;
      informerDigestHour?: number;
      informerTz?: string;
      informerMutedUntil?: number | null;
    }>("/api/admin/notifications/settings");
  },
  updateInformerSettings(body: {
    informerLevel?: string;
    informerTopics?: Record<string, boolean>;
    informerDigest?: string;
    informerDigestHour?: number;
    informerTz?: string;
    informerMutedUntil?: number | null;
  }) {
    return request<{ ok: boolean }>("/api/admin/notifications/informer", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  getInformerFeed(limit = 20) {
    return request<{ items: InformerNotification[] }>(
      `/api/admin/notifications/informer/feed?limit=${limit}`,
    );
  },
  updateNotificationSettings(body: {
    telegramChatId?: string | null;
    notifyOnAssignedOnly?: boolean;
  }) {
    return request<{ ok: boolean }>("/api/admin/notifications/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  generateNotificationLinkToken() {
    return request<{ token: string }>("/api/admin/notifications/settings/link", { method: "POST" });
  },
  generateGroupLinkToken(eventType = "stage_changed") {
    return request<{ token: string }>("/api/admin/notifications/group-link", {
      method: "POST",
      body: JSON.stringify({ eventType }),
    });
  },
  getNotificationRules() {
    return request<{ items: NotificationRule[] }>("/api/admin/notifications/rules");
  },
  createNotificationRule(body: { eventType: string; targetId: string; conditionJson?: string }) {
    return request<NotificationRule>("/api/admin/notifications/rules", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  deleteNotificationRule(id: number) {
    return request<{ ok: boolean }>(`/api/admin/notifications/rules/${id}`, { method: "DELETE" });
  },
  testNotificationRule(id: number) {
    return request<{ ok: boolean; error?: string }>(`/api/admin/notifications/rules/${id}/test`, {
      method: "POST",
    });
  },
  getOpsAlertStatus() {
    return request<{
      enabled: boolean;
      botConfigured: boolean;
      telegramLinked: boolean;
      emailConfigured: boolean;
    }>("/api/admin/notifications/ops-status");
  },
  testOpsAlert() {
    return request<{ ok: boolean; error?: string }>("/api/admin/notifications/ops-test", {
      method: "POST",
    });
  },
  getNotificationTemplates() {
    return request<{ items: NotificationTemplate[] }>("/api/admin/notifications/templates");
  },
  upsertNotificationTemplate(slug: string, body: string) {
    return request<{ ok: boolean }>(
      `/api/admin/notifications/templates/${encodeURIComponent(slug)}`,
      {
        method: "PUT",
        body: JSON.stringify({ body }),
      },
    );
  },
  deleteNotificationTemplate(slug: string) {
    return request<{ ok: boolean }>(
      `/api/admin/notifications/templates/${encodeURIComponent(slug)}`,
      {
        method: "DELETE",
      },
    );
  },

  // ── Bot Tester ────────────────────────────────────────────────────────
  getTestScenarios() {
    return request<{ scenarios: TestScenario[] }>("/api/admin/test/scenarios");
  },
  testSend(body: {
    text?: string;
    mediaUrl?: string;
    mediaType?: "photo" | "video";
    caption?: string;
  }) {
    return request<TestSendResult>("/api/admin/test/send", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  testResetSession() {
    return request<{ ok: boolean; note?: string }>("/api/admin/test/session", {
      method: "DELETE",
    });
  },

  // ── Exchange (обменный пункт) ─────────────────────────────────────────
  exchangeRates() {
    return request<{ rates: ExchangeRate[] }>("/api/admin/exchange/rates");
  },
  saveExchangeRate(input: ExchangeRateInput) {
    return request<{ ok: boolean; rate: ExchangeRate }>("/api/admin/exchange/rates", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deleteExchangeRate(id: number) {
    return request<{ ok: boolean }>(`/api/admin/exchange/rates/${id}`, { method: "DELETE" });
  },
  refreshExchangeRates() {
    return request<{ ok: boolean; updated: number; skipped: number; failed: number }>(
      "/api/admin/exchange/rates/refresh",
      { method: "POST" },
    );
  },
  exchangeSettings() {
    return request<ExchangeSettings>("/api/admin/exchange/settings");
  },
  saveExchangeSettings(input: ExchangeSettings) {
    return request<{ ok: boolean; settings: ExchangeSettings }>(
      "/api/admin/exchange/settings",
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
  previewExchangeRateCard() {
    return request<{ ok: boolean; proposals: ExchangeRateCardProposal[]; message: string }>(
      "/api/admin/exchange/rate-card/preview",
      { method: "POST" },
    );
  },
  approveExchangeRateCard(proposals: ExchangeRateCardProposal[]) {
    return request<{ ok: boolean; message: string }>("/api/admin/exchange/rate-card/approve", {
      method: "POST",
      body: JSON.stringify({ proposals }),
    });
  },
  saveExchangeRequisite(key: string, value: string) {
    return request<{ ok: boolean }>("/api/admin/exchange/requisites", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
  },
  exchangeRequisites() {
    return request<{ items: Array<{ key: string; value: string }> }>(
      "/api/admin/exchange/requisites",
    );
  },
  exchangeOrders(status?: string, limit?: number) {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (limit) p.set("limit", String(limit));
    const q = p.toString() ? `?${p.toString()}` : "";
    return request<{ orders: ExchangeOrder[] }>(`/api/admin/exchange/orders${q}`);
  },
  updateExchangeOrder(
    id: number,
    patch: Partial<{
      payoutCode: string;
      payoutLocation: string | null;
      payoutMethod: string | null;
      payoutDestinationJson: string | null;
      paymentMethod: string | null;
      paymentRail: string | null;
      sourceBank: string | null;
      payerName: string | null;
      thirdPartyApproved: boolean;
      verificationId: string;
      status: string;
    }>,
  ) {
    return request<{ ok: boolean; order: ExchangeOrder }>(`/api/admin/exchange/orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  exchangeTurnover() {
    return request<ExchangeTurnover>("/api/admin/exchange/turnover");
  },
};
