// Minimal API client для SaaS endpoint'ов на новом backend'е (apps/api).
// Существующий api.ts (1251 LOC) bound к legacy /admin/api/* — мы его не
// трогаем; SaaS-flow живёт здесь под /api/auth/* и /api/admin/*.

export interface Admin {
  id: number;
  email: string;
  role: "superadmin" | "manager";
  tenantId: number;
}

export interface Tenant {
  id: number;
  slug: string;
  plan: string;
}

export interface KbDoc {
  id: number;
  source: string;
  title: string;
  topic: string | null;
  createdAt: number;
}

export interface KbUploadResult {
  documentId: number;
  source: string;
  chunks: number;
  created: boolean;
}

export type LlmPurpose = "chat" | "embed" | "vision" | "judge";
export type LlmProvider = "openai" | "openrouter" | "ollama" | "anthropic";

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

export interface UpsertLlmConfigInput {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  embedDim?: number;
  timeoutMs?: number;
}

export type ChannelKind = "telegram_bot" | "telegram_userbot" | "whatsapp" | "web";
export type ChannelStatus = "active" | "paused" | "error";

export interface ChannelItem {
  id: number;
  kind: ChannelKind;
  externalId: string;
  status: ChannelStatus;
  hasCredentials: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTelegramChannelResult {
  ok: boolean;
  id: number;
  updated: boolean;
  username: string;
  botId: number;
  webhookSet?: boolean;
  webhookError?: string;
}

export interface ConversationListItem {
  id: number;
  contactId: number;
  contactName: string | null;
  source: string;
  mode: string;
  currentStage: string | null;
  lastMessageAt: number | null;
  createdAt: number;
}

export interface ConversationDetail {
  id: number;
  contactId: number;
  contactName: string | null;
  source: string;
  mode: string;
  currentStage: string | null;
  lastMessageAt: number | null;
  createdAt: number;
  escalatedAt: number | null;
}

export interface MessageRow {
  id: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
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
  done: boolean;
}

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
  ) {
    super(`API ${status}: ${errorCode}`);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  withAuth = true,
): Promise<T> {
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
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
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
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const saas = {
  // ── Auth ────────────────────────────────────────────────────────────
  signup(email: string, password: string, tenantSlug?: string) {
    return request<{ token: string; admin: Admin; tenant: Tenant }>(
      "/api/auth/signup",
      {
        method: "POST",
        body: JSON.stringify({ email, password, ...(tenantSlug ? { tenantSlug } : {}) }),
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
    return request<{ ok: boolean; deleted: number }>(
      `/api/admin/kb/documents/${id}`,
      { method: "DELETE" },
    );
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
    return request<{ ok: boolean; deleted: number }>(
      `/api/admin/llm-configs/${purpose}`,
      { method: "DELETE" },
    );
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
  listConversations(opts: { limit?: number; cursor?: number } = {}) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", String(opts.cursor));
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
    return request<{ ok: boolean; mode: "ai" | "human" }>(
      `/api/admin/conversations/${id}/mode`,
      { method: "PUT", body: JSON.stringify({ mode }) },
    );
  },

  // ── Diagnostics ──────────────────────────────────────────────────────
  runDiagnostics() {
    return request<DiagnosticsResult>("/api/admin/diagnostics");
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

  // ── Audit log (read-only) ────────────────────────────────────────────
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
};
