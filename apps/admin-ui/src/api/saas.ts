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
};
