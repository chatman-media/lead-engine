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

export interface EarlyAccessRequest {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  useCase: string | null;
  source: string;
  locale: string;
  status: string;
  tenantId: number | null;
  tenantSlug: string | null;
  tenantPlan: string | null;
  inviteId: number | null;
  inviteUrl: string | null;
  inviteExpiresAt: number | null;
  inviteUsedAt: number | null;
  approvedAt: number | null;
  approvedByAdminId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApproveEarlyAccessResult {
  ok: boolean;
  item: EarlyAccessRequest;
  tenant: { id: number; slug: string; plan: string };
  invite: {
    id: number;
    shareUrl: string;
    expiresAt: number;
    usedAt: number | null;
  };
}

export type KbDocFormat = "text" | "markdown" | "pdf" | "json";

export interface KbDoc {
  id: number;
  source: string;
  title: string;
  topic: string | null;
  format: KbDocFormat;
  hasStoredFile: boolean;
  fileName: string | null;
  fileMimeType: string | null;
  fileSizeBytes: number | null;
  fileUploadedAt: number | null;
  scopeType: "global" | "funnel" | "stage";
  funnelId: number | null;
  stageSlug: string | null;
  createdAt: number;
}

export interface KbDocDetail extends KbDoc {
  text: string;
  chunks: Array<{
    chunkIndex: number;
    text: string;
    tokenCount: number;
  }>;
}

export interface KbSuggestion {
  id: number;
  tenantId: number;
  questionText: string;
  answerDraft: string | null;
  status: "pending" | "ingested" | "rejected";
  scopeType: "global" | "funnel" | "stage";
  funnelId: number | null;
  stageSlug: string | null;
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
  hasStoredFile?: boolean;
  fileName?: string | null;
  fileMimeType?: string | null;
  fileSizeBytes?: number | null;
  fileUploadedAt?: number | null;
  scopeType: "global" | "funnel" | "stage";
  funnelId: number | null;
  stageSlug: string | null;
}

export interface KbRequirement {
  key: string;
  title: string;
  description: string;
  topic: string;
  required: boolean;
  scopeType: "funnel" | "stage";
  funnelId: number;
  stageSlug: string | null;
  covered: boolean;
  matchedDocuments: number;
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
  | "vk"
  | "max"
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

export interface CreateVkChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  groupId: string;
  groupName?: string;
  screenName?: string;
  webhookSetupHint?: {
    url: string;
    confirmationCode: string;
    secretKeyHint: string;
    eventTypes: string[];
  };
  reloadError?: string;
}

export interface CreateMaxChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  botId: string;
  username?: string;
  botName?: string;
  webhookSetupHint?: {
    url: string;
    secret: string;
    updateTypes: string[];
    requirement: string;
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

export type OperatorOutreachTarget = "all" | "role" | "admins";
export type OperatorOutreachRole = "superadmin" | "manager";
export type OperatorOutreachChannel = "in_app" | "telegram";
export type OperatorOutreachPriority = "normal" | "important" | "critical";

export interface OperatorOutreachInput {
  text: string;
  target: OperatorOutreachTarget;
  role?: OperatorOutreachRole;
  adminIds?: number[];
  channels: OperatorOutreachChannel[];
  priority: OperatorOutreachPriority;
}

export interface OperatorOutreachResult {
  ok: boolean;
  targets: number;
  inAppDelivered: number;
  telegramDelivered: number;
  telegramSkipped: number;
  telegramFailed: number;
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
  goal: string | null;
  guidance: string | null;
  autoAdvanceCondition: string | null;
  partnerWebhookUrl: string | null;
  partnerWebhookMode: "fire_and_forget" | "await_callback";
  fields: StageField[];
}

export interface FunnelData {
  funnel: {
    id: number;
    slug: string;
    verticalTemplateId?: string | null;
    isActive: boolean;
  } | null;
  stages: StageDefinition[];
}

export interface FunnelListItem {
  id: number;
  slug: string;
  verticalTemplateId: string | null;
  isActive: boolean;
  stagesCount: number;
  leadsCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FunnelTemplateInfo {
  key: string;
  displayName: string;
  description: string;
  verticalTemplateId: string | null;
  isCreatable: boolean;
  stagesCount: number;
  fieldsCount: number;
  stages: Array<{
    slug: string;
    displayName: string;
    kind: StageKind;
    stageType: StageType;
    phase: StagePhase | null;
    fieldsCount: number;
  }>;
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

export interface DripCampaign {
  id: number;
  name: string;
  status: string;
  dripPerTick: number;
  dripIntervalSec: number;
  createdAt: number;
  total: number;
  sent: number;
  skipped: number;
  pending: number;
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
  transferredThb?: number;
  ordersCompleted?: number;
  orders?: Array<{
    id: number;
    assetFrom: string;
    network: string | null;
    amountFrom: number | string | null;
    amountToThb: number | string | null;
    rate: number | string | null;
    status: string;
    payoutCode: string | null;
    createdAt: number;
    completedAt: number | null;
  }>;
  partnerDeals?: PartnerDeal[];
}

export interface Partner {
  id: number;
  name: string;
  status: string;
  contactName: string | null;
  contactChannel: string | null;
  contactValue: string | null;
  defaultCommissionPct: number;
  settlementCurrency: string;
  notes: string | null;
  servicesCount?: number;
  dealsCount?: number;
  completedCount?: number;
  commissionTotal?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PartnerService {
  id: number;
  partnerId: number;
  partnerName?: string | null;
  name: string;
  category: string | null;
  funnelId: number | null;
  stageDefinitionId: number | null;
  stageName?: string | null;
  commissionPct: number;
  isActive: boolean;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PartnerDeal {
  id: number;
  partnerId: number | null;
  partnerName?: string | null;
  serviceId: number | null;
  serviceName?: string | null;
  partnerServiceNotes?: string | null;
  leadId: number | null;
  stageDefinitionId: number | null;
  stageName?: string | null;
  status: string;
  handoffUrl: string | null;
  handoffMode: string;
  grossAmount: number | null;
  currency: string;
  commissionPct: number;
  commissionAmount: number | null;
  notes: string | null;
  sentAt: number | null;
  acceptedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  settledAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderMarketplaceInstall {
  partnerId: number;
  partnerName: string;
  partnerServiceId: number;
  serviceName: string;
  serviceCatalogItemId: number;
  serviceCatalogSlug: string;
  installedAt: number | null;
}

export interface ProviderMarketplaceItem {
  key: string;
  category: string;
  name: string;
  description: string;
  coverage: string;
  sla: string;
  pricingMode: string;
  commissionPct: number;
  commissionHint: string;
  requiredFields: string[];
  defaultServiceName: string;
  serviceSlug: string;
  handoffMode: "fire_and_forget" | "await_callback";
  installed: ProviderMarketplaceInstall | null;
}

export interface CustomProviderMarketplaceItem {
  key: string;
  category: string;
  name: string;
  serviceName: string;
  description: string | null;
  installed: ProviderMarketplaceInstall;
}

export interface CustomProviderMarketplaceInput {
  providerName: string;
  serviceName: string;
  category?: string | null;
  description?: string | null;
  coverage?: string | null;
  sla?: string | null;
  pricingMode?: string | null;
  commissionPct?: number;
  requiredFields?: string | string[];
}

export type ServiceCatalogRouteType = "manual" | "funnel" | "partner_service" | "webhook";

export interface ServiceCatalogItem {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  routeType: ServiceCatalogRouteType;
  funnelId: number | null;
  funnelSlug?: string | null;
  funnelVerticalTemplateId?: string | null;
  partnerServiceId: number | null;
  partnerServiceName?: string | null;
  partnerName?: string | null;
  webhookUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  metadataJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceCatalogInput {
  slug?: string;
  name: string;
  category?: string | null;
  description?: string | null;
  routeType: ServiceCatalogRouteType;
  funnelId?: number | null;
  partnerServiceId?: number | null;
  webhookUrl?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  metadataJson?: string;
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

export interface ExperimentPreview {
  experiment: {
    id: number;
    slug: string;
    status: ExperimentItem["status"];
    successMetric: string;
  };
  sampleSize: number;
  canRun: boolean;
  variants: Array<{
    styleSlug: string;
    displayName: string | null;
    weight: number;
    targetPct: number;
    status: "valid" | "missing" | "invalid_config";
  }>;
  assignments: Array<{ userId: string; styleSlug: string }>;
  counts: Array<{ styleSlug: string; count: number; observedPct: number }>;
}

export type QualityOutcome = "won" | "lost" | "draw";
export type QualityPairwiseWinner = "a" | "b" | "draw";
export type QualityCoachProposalStatus = "pending" | "applied" | "dismissed";
export type QualityCoachProposalDecisionStatus = "pending" | "dismissed";
export type QualityShadowStatus = "running" | "complete" | "failed";
export type QualityShadowDecision = "keep" | "rollback" | "inconclusive";

export interface QualityTranscriptTurn {
  role: "candidate" | "salesperson";
  text: string;
}

export interface QualitySelfPlayMatch {
  styleSlug: string;
  personaSlug: string;
  turns: number;
  transcript: QualityTranscriptTurn[];
  skillsAttributed: string[];
  verdict: {
    outcome: QualityOutcome;
    reason: string | null;
  };
  outcome: QualityOutcome;
  leadId: number;
  fabricationsCaught: number;
  matchId: number | null;
  persisted: boolean;
  warnings: string[];
}

export interface QualityPairwiseMatch {
  styleASlug: string;
  styleBSlug: string;
  personaSlug: string;
  matchA: QualitySelfPlayMatch;
  matchB: QualitySelfPlayMatch;
  verdict: {
    winner: QualityPairwiseWinner;
    reason: string | null;
  };
  eloAAfter: number;
  eloBAfter: number;
  pairwiseId: number | null;
  persisted: boolean;
}

export interface QualityRunOptions {
  styles: Array<{
    id: number;
    slug: string;
    displayName: string;
    isActive: boolean;
  }>;
  personas: Array<{
    slug: string;
    displayName: string;
    summary: string;
  }>;
}

export interface QualitySelfPlayRunOptions {
  styleSlug: string;
  personaSlug: string;
  maxTurns?: number;
  reflect?: boolean;
}

export interface QualityPairwiseRunOptions {
  styleASlug: string;
  styleBSlug: string;
  personaSlug: string;
  maxTurns?: number;
  reflect?: boolean;
}

export interface QualityCoachGenerateOptions {
  styleSlug: string;
  sampleSize?: number;
  personaSlug?: string;
  model?: string;
}

export interface QualitySelfPlaySummary {
  totals: {
    total: number;
    won: number;
    lost: number;
    draw: number;
    winRate: number;
    fabricationsCaught: number;
    avgTurns: number | null;
    lastMatchAt: number | null;
  };
  byStyle: Array<{
    styleSlug: string;
    total: number;
    won: number;
    lost: number;
    draw: number;
    winRate: number;
    fabricationsCaught: number;
    avgTurns: number | null;
    lastMatchAt: number | null;
  }>;
  byPersona: Array<{
    personaSlug: string;
    total: number;
    won: number;
    lost: number;
    draw: number;
    winRate: number;
    lastMatchAt: number | null;
  }>;
  recent: Array<{
    id: number;
    styleSlug: string;
    personaSlug: string;
    outcome: QualityOutcome;
    judgeReason: string | null;
    turns: number;
    fabricationsCaught: number;
    createdAt: number;
  }>;
}

export interface QualityExportOptions {
  styleSlug?: string;
  personaSlug?: string;
  outcome?: QualityOutcome;
  limit?: number;
  includeTranscript?: boolean;
}

export interface QualityPairwiseSummary {
  totals: {
    total: number;
    aWins: number;
    bWins: number;
    draws: number;
    aWinRate: number;
    bWinRate: number;
    lastMatchAt: number | null;
  };
  byPair: Array<{
    styleASlug: string;
    styleBSlug: string;
    total: number;
    aWins: number;
    bWins: number;
    draws: number;
    aWinRate: number;
    bWinRate: number;
    lastMatchAt: number | null;
  }>;
  recent: Array<{
    id: number;
    styleASlug: string;
    styleBSlug: string;
    personaSlug: string;
    winner: QualityPairwiseWinner;
    judgeReason: string | null;
    matchAId: number | null;
    matchBId: number | null;
    eloAAfter: number;
    eloBAfter: number;
    createdAt: number;
  }>;
}

export interface QualityPairwiseExportOptions {
  styleASlug?: string;
  styleBSlug?: string;
  personaSlug?: string;
  winner?: QualityPairwiseWinner;
  limit?: number;
  includeTranscript?: boolean;
}

export interface QualityCoachProposal {
  id: number;
  styleSlug: string;
  sampleSize: number;
  personaFilter: string | null;
  summary: string;
  editsJson: string;
  rationaleJson: string;
  rawOutput: string | null;
  status: QualityCoachProposalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedByAdminId: number | null;
  edits: unknown;
  rationale: string[];
}

export interface QualityCoachApplyResult {
  ok: boolean;
  proposal: QualityCoachProposal;
  style: StyleItem;
}

export interface QualityShadowEvaluation {
  id: number;
  proposalId: number;
  parentStyleSlug: string;
  parentStyleId: number;
  newStyleSlug: string;
  newStyleId: number;
  pairsPlanned: number;
  pairsDone: number;
  aWins: number;
  bWins: number;
  draws: number;
  winRateLb: number | null;
  status: QualityShadowStatus;
  decision: QualityShadowDecision | null;
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface QualityShadowEvaluationResult {
  ok: boolean;
  shadow: QualityShadowEvaluation;
}

export interface QualityShadowPreview {
  ready: boolean;
  proposalId: number;
  parentStyle: {
    id: number;
    slug: string;
  };
  candidateStyle: {
    id: number;
    slug: string;
    parentId: number | null;
  };
  pairwise: {
    limit: number;
    total: number;
    aWins: number;
    bWins: number;
    draws: number;
    bWinsAdjusted: number;
    winRateLb: number | null;
    decision: QualityShadowDecision | null;
    recentIds: number[];
  };
  missing: {
    reason: "no_pairwise";
    nextAction: "run_pairwise" | "run_shadow_eval";
    styleASlug: string;
    styleBSlug: string;
  } | null;
}

export interface QualityShadowPreviewResult {
  ok: boolean;
  preview: QualityShadowPreview;
}

export interface QualityShadowEvaluationOptions {
  pairsPlanned?: number;
  limit?: number;
  newStyleSlug?: string;
}

export interface QualityShadowRunOptions {
  runs?: number;
  personas?: string[];
  maxTurns?: number;
  newStyleSlug?: string;
}

export interface QualityCoachSummary {
  totals: {
    proposals: {
      total: number;
      pending: number;
      applied: number;
      dismissed: number;
      lastProposalAt: number | null;
    };
    shadows: {
      total: number;
      running: number;
      complete: number;
      failed: number;
      keep: number;
      rollback: number;
      inconclusive: number;
      lastShadowAt: number | null;
    };
  };
  proposals: QualityCoachProposal[];
  shadows: QualityShadowEvaluation[];
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
  listDocs(opts: { scopeType?: KbDoc["scopeType"]; funnelId?: number; stageSlug?: string } = {}) {
    const p = new URLSearchParams();
    if (opts.scopeType) p.set("scopeType", opts.scopeType);
    if (opts.funnelId) p.set("funnelId", String(opts.funnelId));
    if (opts.stageSlug) p.set("stageSlug", opts.stageSlug);
    const qs = p.toString();
    return request<{ items: KbDoc[] }>(`/api/admin/kb/documents${qs ? `?${qs}` : ""}`);
  },
  getDoc(id: number) {
    return request<{ item: KbDocDetail }>(`/api/admin/kb/documents/${id}`);
  },
  async getDocFile(id: number) {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/admin/kb/documents/${id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errorCode = (body.error as string | undefined) ?? res.statusText;
      const { error: _e, ...extra } = body;
      throw new ApiError(res.status, errorCode, Object.keys(extra).length > 0 ? extra : undefined);
    }
    return res.blob();
  },
  listKbRequirements(funnelId: number) {
    return request<{
      funnel: { id: number; slug: string; verticalTemplateId: string | null };
      items: KbRequirement[];
    }>(`/api/admin/kb/requirements?funnelId=${funnelId}`);
  },
  uploadJson(input: {
    title: string;
    body: string;
    topic?: string;
    scopeType?: KbDoc["scopeType"];
    funnelId?: number;
    stageSlug?: string;
  }) {
    return request<KbUploadResult>("/api/admin/kb/documents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  uploadFile(
    file: File,
    opts: {
      title?: string;
      topic?: string;
      scopeType?: KbDoc["scopeType"];
      funnelId?: number;
      stageSlug?: string;
    } = {},
  ) {
    const form = new FormData();
    form.append("file", file);
    if (opts.title) form.append("title", opts.title);
    if (opts.topic) form.append("topic", opts.topic);
    if (opts.scopeType) form.append("scopeType", opts.scopeType);
    if (opts.funnelId) form.append("funnelId", String(opts.funnelId));
    if (opts.stageSlug) form.append("stageSlug", opts.stageSlug);
    return uploadMultipart<KbUploadResult>("/api/admin/kb/documents", form);
  },
  deleteDoc(id: number) {
    return request<{ ok: boolean; deleted: number }>(`/api/admin/kb/documents/${id}`, {
      method: "DELETE",
    });
  },

  // ── KB suggestions ───────────────────────────────────────────────────
  listKbSuggestions(
    opts: {
      status?: "pending" | "ingested" | "rejected";
      limit?: number;
      offset?: number;
      scopeType?: KbDoc["scopeType"];
      funnelId?: number;
      stageSlug?: string;
    } = {},
  ) {
    const p = new URLSearchParams();
    if (opts.status) p.set("status", opts.status);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.offset) p.set("offset", String(opts.offset));
    if (opts.scopeType) p.set("scopeType", opts.scopeType);
    if (opts.funnelId) p.set("funnelId", String(opts.funnelId));
    if (opts.stageSlug) p.set("stageSlug", opts.stageSlug);
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
  createFacebookChannel(input: {
    pageAccessToken: string;
    verifyToken?: string;
    appSecret?: string;
  }) {
    return request<CreateFacebookChannelResult>("/api/admin/channels/facebook", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  createVkChannel(input: {
    groupId: string;
    accessToken: string;
    confirmationCode?: string;
    secretKey?: string;
  }) {
    return request<CreateVkChannelResult>("/api/admin/channels/vk", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  createMaxChannel(input: { botToken: string; webhookSecret?: string }) {
    return request<CreateMaxChannelResult>("/api/admin/channels/max", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  rotateMaxWebhookSecret(id: number) {
    return request<CreateMaxChannelResult>(`/api/admin/channels/max/${id}/rotate-secret`, {
      method: "POST",
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
  startSim(opts: {
    personaId?: string;
    brief?: string;
    displayName?: string;
    maxTurns?: number;
    targetFunnelId?: number;
    targetCatalogItemId?: number;
  }) {
    return request<{
      ok: boolean;
      conversationId: number;
      displayName: string;
      maxTurns: number;
      targetFunnelId?: number;
      targetCatalogItemId?: number;
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
    targetFunnelId?: number;
    targetCatalogItemId?: number;
  }) {
    return request<{
      ok: boolean;
      streamId: string;
      count: number;
      intervalSec: number;
      targetFunnelId?: number;
      targetCatalogItemId?: number;
    }>(
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
  walkSim(count = 1, displayName?: string, funnelId?: number) {
    return request<{ ok: boolean; leads: number[]; finalStage: string }>(
      "/api/admin/sim/walk",
      {
        method: "POST",
        body: JSON.stringify({
          count,
          ...(displayName ? { displayName } : {}),
          ...(funnelId ? { funnelId } : {}),
        }),
      },
    );
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
      funnelId?: number;
      state?: string;
      contactId?: number;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const p = new URLSearchParams();
    if (opts.stageId) p.set("stageId", String(opts.stageId));
    if (opts.funnelId) p.set("funnelId", String(opts.funnelId));
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
  getPrimaryFunnel() {
    return request<FunnelData>("/api/admin/funnel?primary=1");
  },
  listFunnels() {
    return request<{ items: FunnelListItem[] }>("/api/admin/funnels");
  },
  getFunnelById(id: number) {
    return request<FunnelData>(`/api/admin/funnels/${id}`);
  },
  listFunnelTemplates() {
    return request<{ items: FunnelTemplateInfo[] }>("/api/admin/funnel/templates");
  },
  createFunnel(data: { slug: string; template?: string }) {
    return request<{
      ok: boolean;
      funnelId: number;
      stagesCreated: number;
      template: string;
      verticalTemplateId: string | null;
    }>("/api/admin/funnels", {
      method: "POST",
      body: JSON.stringify(data),
    });
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

  getFunnelAnalytics(funnelId?: number) {
    return request<FunnelAnalytics>(
      `/api/admin/funnel/analytics${funnelId ? `?funnelId=${funnelId}` : ""}`,
    );
  },
  getPrimaryFunnelAnalytics() {
    return request<FunnelAnalytics>("/api/admin/funnel/analytics?primary=1");
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
  previewExperiment(id: number, sampleSize = 20) {
    return request<ExperimentPreview>(`/api/admin/experiments/${id}/preview?sampleSize=${sampleSize}`);
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
  getQualitySelfPlaySummary() {
    return request<QualitySelfPlaySummary>("/api/admin/quality/self-play/summary");
  },
  getQualityPairwiseSummary() {
    return request<QualityPairwiseSummary>("/api/admin/quality/pairwise/summary");
  },
  getQualitySelfPlayMatch(id: number) {
    return request<{ match: QualitySelfPlayMatch }>(`/api/admin/quality/self-play/matches/${id}`);
  },
  getQualityPairwiseMatch(id: number) {
    return request<{ pairwise: QualityPairwiseMatch }>(`/api/admin/quality/pairwise/matches/${id}`);
  },
  getQualityRunOptions() {
    return request<QualityRunOptions>("/api/admin/quality/run-options");
  },
  runQualitySelfPlay(data: QualitySelfPlayRunOptions) {
    return request<{ ok: boolean; match: QualitySelfPlayMatch }>(
      "/api/admin/quality/self-play/matches",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  },
  runQualityPairwise(data: QualityPairwiseRunOptions) {
    return request<{ ok: boolean; pairwise: QualityPairwiseMatch }>(
      "/api/admin/quality/pairwise/matches",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  },
  getQualityCoachSummary() {
    return request<QualityCoachSummary>("/api/admin/quality/coach/summary");
  },
  generateQualityCoachProposal(data: QualityCoachGenerateOptions) {
    return request<{ ok: boolean; proposal: QualityCoachProposal }>(
      "/api/admin/quality/coach/proposals",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  },
  setQualityCoachProposalStatus(id: number, status: QualityCoachProposalDecisionStatus) {
    return request<{ ok: boolean; proposal: QualityCoachProposal }>(
      `/api/admin/quality/coach/proposals/${id}/status`,
      {
        method: "PATCH",
        body: JSON.stringify({ status }),
      },
    );
  },
  applyQualityCoachProposal(id: number) {
    return request<QualityCoachApplyResult>(`/api/admin/quality/coach/proposals/${id}/apply`, {
      method: "POST",
    });
  },
  getQualityShadowPreview(id: number, opts: Omit<QualityShadowEvaluationOptions, "pairsPlanned"> = {}) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.newStyleSlug) params.set("newStyleSlug", opts.newStyleSlug);
    const qs = params.toString();
    return request<QualityShadowPreviewResult>(
      `/api/admin/quality/coach/proposals/${id}/shadow-preview${qs ? `?${qs}` : ""}`,
    );
  },
  createQualityShadowEvaluation(id: number, opts: QualityShadowEvaluationOptions = {}) {
    return request<QualityShadowEvaluationResult>(
      `/api/admin/quality/coach/proposals/${id}/shadow-evaluations`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    );
  },
  runQualityShadowEvaluation(id: number, opts: QualityShadowRunOptions = {}) {
    return request<QualityShadowEvaluationResult>(
      `/api/admin/quality/coach/proposals/${id}/shadow-evaluations/run`,
      {
        method: "POST",
        body: JSON.stringify(opts),
      },
    );
  },
  async exportQualitySelfPlayJsonl(opts: QualityExportOptions = {}): Promise<void> {
    const params = new URLSearchParams();
    if (opts.styleSlug) params.set("styleSlug", opts.styleSlug);
    if (opts.personaSlug) params.set("personaSlug", opts.personaSlug);
    if (opts.outcome) params.set("outcome", opts.outcome);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.includeTranscript === false) params.set("includeTranscript", "false");

    const token = getToken();
    const qs = params.toString();
    const res = await fetch(
      `${API_BASE}/api/admin/quality/self-play/export.jsonl${qs ? `?${qs}` : ""}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(res.status, (body.error as string | undefined) ?? res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "self-play-matches.jsonl";
    a.click();
    URL.revokeObjectURL(url);
  },
  async exportQualityPairwiseJsonl(opts: QualityPairwiseExportOptions = {}): Promise<void> {
    const params = new URLSearchParams();
    if (opts.styleASlug) params.set("styleASlug", opts.styleASlug);
    if (opts.styleBSlug) params.set("styleBSlug", opts.styleBSlug);
    if (opts.personaSlug) params.set("personaSlug", opts.personaSlug);
    if (opts.winner) params.set("winner", opts.winner);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.includeTranscript === false) params.set("includeTranscript", "false");

    const token = getToken();
    const qs = params.toString();
    const res = await fetch(
      `${API_BASE}/api/admin/quality/pairwise/export.jsonl${qs ? `?${qs}` : ""}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(res.status, (body.error as string | undefined) ?? res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pairwise-matches.jsonl";
    a.click();
    URL.revokeObjectURL(url);
  },

  // ── Dashboard ────────────────────────────────────────────────────────
  getDashboardStats() {
    return request<DashboardStats>("/api/admin/dashboard");
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
  sendOperatorOutreach(body: OperatorOutreachInput) {
    return request<OperatorOutreachResult>("/api/admin/outreach/operators", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  // ── Drip campaigns ────────────────────────────────────────────────────
  listDripCampaigns() {
    return request<{ campaigns: DripCampaign[] }>("/api/admin/outreach-campaigns");
  },
  createDripCampaign(body: {
    name: string;
    greetingText: string;
    dripPerTick?: number;
    dripIntervalSec?: number;
    leadIds?: number[];
  }) {
    return request<{ ok: boolean; id: number; leadsAdded: number; status: string }>(
      "/api/admin/outreach-campaigns",
      { method: "POST", body: JSON.stringify(body) },
    );
  },
  updateDripCampaign(
    id: number,
    patch: Partial<{
      status: string;
      name: string;
      greetingText: string;
      dripPerTick: number;
      dripIntervalSec: number;
    }>,
  ) {
    return request<{ ok: boolean }>(`/api/admin/outreach-campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
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

  // ── Partner ledger ───────────────────────────────────────────────────
  listPartners() {
    return request<{ items: Partner[] }>("/api/admin/partners");
  },
  createPartner(data: {
    name: string;
    contactName?: string | null;
    contactChannel?: string | null;
    contactValue?: string | null;
    defaultCommissionPct?: number;
    settlementCurrency?: string;
    notes?: string | null;
  }) {
    return request<{ item: Partner }>("/api/admin/partners", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updatePartner(id: number, patch: Partial<Partner>) {
    return request<{ item: Partner }>(`/api/admin/partners/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  listPartnerServices() {
    return request<{ items: PartnerService[] }>("/api/admin/partner-services");
  },
  createPartnerService(data: {
    partnerId: number;
    name: string;
    category?: string | null;
    funnelId?: number | null;
    stageDefinitionId?: number | null;
    commissionPct?: number;
    notes?: string | null;
  }) {
    return request<{ item: PartnerService }>("/api/admin/partner-services", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  listPartnerDeals(opts: { status?: string; leadId?: number } = {}) {
    const p = new URLSearchParams();
    if (opts.status) p.set("status", opts.status);
    if (opts.leadId) p.set("leadId", String(opts.leadId));
    const q = p.toString();
    return request<{ items: PartnerDeal[] }>(`/api/admin/partner-deals${q ? `?${q}` : ""}`);
  },
  createPartnerDeal(data: {
    partnerId?: number | null;
    serviceId?: number | null;
    leadId?: number | null;
    stageDefinitionId?: number | null;
    grossAmount?: number | null;
    currency?: string;
    commissionPct?: number;
    notes?: string | null;
  }) {
    return request<{ item: PartnerDeal }>("/api/admin/partner-deals", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updatePartnerDeal(id: number, patch: Partial<PartnerDeal>) {
    return request<{ item: PartnerDeal }>(`/api/admin/partner-deals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  // ── Provider marketplace ─────────────────────────────────────────────
  listProviderMarketplace() {
    return request<{
      items: ProviderMarketplaceItem[];
      customProviders: CustomProviderMarketplaceItem[];
    }>("/api/admin/provider-marketplace");
  },
  installMarketplaceProvider(providerKey: string) {
    return request<{ provider: ProviderMarketplaceItem; created: boolean }>(
      `/api/admin/provider-marketplace/${providerKey}/install`,
      { method: "POST" },
    );
  },
  createCustomMarketplaceProvider(data: CustomProviderMarketplaceInput) {
    return request<{ provider: CustomProviderMarketplaceItem; created: boolean }>(
      "/api/admin/provider-marketplace/custom",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  },

  // ── Service catalog ──────────────────────────────────────────────────
  listServiceCatalog() {
    return request<{ items: ServiceCatalogItem[] }>("/api/admin/service-catalog");
  },
  createServiceCatalogItem(data: ServiceCatalogInput) {
    return request<{ item: ServiceCatalogItem }>("/api/admin/service-catalog/items", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  updateServiceCatalogItem(id: number, patch: Partial<ServiceCatalogInput>) {
    return request<{ item: ServiceCatalogItem }>(`/api/admin/service-catalog/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  deleteServiceCatalogItem(id: number) {
    return request<{ ok: boolean }>(`/api/admin/service-catalog/items/${id}`, { method: "DELETE" });
  },

  // ── Superadmin ────────────────────────────────────────────────────────
  listAllTenants() {
    return request<{ items: TenantRow[] }>("/api/superadmin/tenants");
  },
  listEarlyAccessRequests() {
    return request<{ items: EarlyAccessRequest[] }>("/api/superadmin/early-access");
  },
  approveEarlyAccess(id: number, input: { plan?: string; tenantSlug?: string } = {}) {
    return request<ApproveEarlyAccessResult>(`/api/superadmin/early-access/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(input),
    });
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
      informerQuietFrom?: number | null;
      informerQuietTo?: number | null;
    }>("/api/admin/notifications/settings");
  },
  updateInformerSettings(body: {
    informerLevel?: string;
    informerTopics?: Record<string, boolean>;
    informerDigest?: string;
    informerDigestHour?: number;
    informerTz?: string;
    informerMutedUntil?: number | null;
    informerQuietFrom?: number | null;
    informerQuietTo?: number | null;
  }) {
    return request<{ ok: boolean }>("/api/admin/notifications/informer", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  sendTestNotification() {
    return request<{ ok: boolean; error?: string }>("/api/admin/notifications/settings/test", {
      method: "POST",
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
    return request<{ ok: boolean; settings: ExchangeSettings }>("/api/admin/exchange/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
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
    return request<{ items: Array<{ key: string; value: string; hasValue?: boolean; sensitive?: boolean }> }>(
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
  confirmExchangePayment(id: number, text?: string) {
    return request<{ ok: boolean; delivered: boolean; order: ExchangeOrder }>(
      `/api/admin/exchange/orders/${id}/confirm-payment`,
      { method: "POST", body: JSON.stringify(text ? { text } : {}) },
    );
  },
  issueExchangePayoutCode(
    id: number,
    opts: Partial<{
      payoutCode: string;
      generate: boolean;
      payoutLocation: string;
      payoutMethod: string;
      ttlMinutes: number;
    }> = {},
  ) {
    return request<{
      ok: boolean;
      payoutCode: string;
      expiresAt: number | null;
      delivered: boolean;
      order: ExchangeOrder;
    }>(`/api/admin/exchange/orders/${id}/issue-payout-code`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  },
  runExchangeEval(personaIds?: string[], maxTurns?: number) {
    return request<{
      summary: { passed: number; total: number };
      report: Array<{
        id: string;
        displayName: string;
        passed: boolean;
        reasons?: string[];
        error?: string;
        signals?: {
          reachedQuote: boolean;
          requisitesIssued: boolean;
          payoutDelivered: boolean;
          prematureOperator: boolean;
        };
      }>;
    }>("/api/admin/sim/exchange-eval", {
      method: "POST",
      body: JSON.stringify({ personaIds, maxTurns }),
    });
  },
  exchangeTurnover() {
    return request<ExchangeTurnover>("/api/admin/exchange/turnover");
  },
};
