export interface Admin {
  id: number;
  email: string;
}

export interface User {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: number;
  mode: "ai" | "queued" | "human";
  escalated_at: number | null;
  last_message_at: number | null;
  assigned_admin_id: number | null;
  user: {
    id: number;
    tg_user_id: number;
    tg_username: string | null;
  };
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
  tg_message_id: number | null;
  created_at: number;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (body as { error?: string }).error ?? res.statusText,
    );
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    req<{ admin: Admin }>("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    req<{ ok: boolean }>("/admin/api/logout", { method: "POST" }),

  me: () =>
    req<{ admin: Admin }>("/admin/api/me"),

  users: () =>
    req<{ users: User[] }>("/admin/api/users"),

  conversations: (escalated?: boolean) =>
    req<{ conversations: Conversation[] }>(
      `/admin/api/conversations${escalated ? "?escalated=1" : ""}`,
    ),

  conversation: (id: number) =>
    req<{
      conversation: Conversation;
      user: User;
      messages: Message[];
    }>(`/admin/api/conversations/${id}`),

  take: (id: number) =>
    req<{ conversation: Conversation }>(
      `/admin/api/conversations/${id}/take`,
      { method: "POST" },
    ),

  release: (id: number) =>
    req<{ conversation: Conversation }>(
      `/admin/api/conversations/${id}/release`,
      { method: "POST" },
    ),

  sendMessage: (id: number, text: string) =>
    req<{ ok: boolean }>(
      `/admin/api/conversations/${id}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    ),

  deleteConversation: (id: number) =>
    req<{ ok: boolean; deleted: number }>(
      `/admin/api/conversations/${id}`,
      { method: "DELETE" },
    ),

  /** URL of the per-conversation JSONL export. Open in a new tab to trigger
   *  the browser's download flow (the server sets Content-Disposition). */
  conversationExportUrl: (id: number) =>
    `/admin/api/conversations/${id}/export.jsonl`,

  /** URL of the bulk JSONL export. Filters are forwarded as query params. */
  bulkConversationExportUrl: (filters: {
    styleId?: number;
    experimentId?: number;
    userStatus?: string;
    mode?: string;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (filters.styleId !== undefined) q.set("style_id", String(filters.styleId));
    if (filters.experimentId !== undefined)
      q.set("experiment_id", String(filters.experimentId));
    if (filters.userStatus) q.set("user_status", filters.userStatus);
    if (filters.mode) q.set("mode", filters.mode);
    if (filters.limit !== undefined) q.set("limit", String(filters.limit));
    const qs = q.toString();
    return `/admin/api/conversations/export.jsonl${qs ? `?${qs}` : ""}`;
  },

  // ─── Sales-style engine (Phase 2b) ───────────────────────────────────
  styles: () => req<{ styles: StyleSummary[] }>("/admin/api/styles"),

  style: (id: number) =>
    req<{ style: StyleDetail }>(`/admin/api/styles/${id}`),

  editStyle: (id: number, config: unknown) =>
    req<{ style: StyleDetail }>(`/admin/api/styles/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ config }),
    }),

  createStyle: (config: unknown) =>
    req<{ style: StyleDetail }>("/admin/api/styles", {
      method: "POST",
      body: JSON.stringify({ config }),
    }),

  playgroundStyle: (
    id: number,
    input: {
      userMessage: string;
      stage?: string;
      useKb?: boolean;
      dropFewShot?: boolean;
    },
  ) =>
    req<PlaygroundResult>(`/admin/api/styles/${id}/playground`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  experiments: () =>
    req<{ experiments: Experiment[] }>("/admin/api/experiments"),

  createExperiment: (input: {
    slug: string;
    status?: ExperimentStatus;
    successMetric?: SuccessMetric;
    allocation: Record<string, number>;
  }) =>
    req<{ experiment: Experiment }>("/admin/api/experiments", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  setExperimentStatus: (id: number, status: ExperimentStatus) =>
    req<{ experiment: Experiment }>(`/admin/api/experiments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  experimentFunnel: (id: number) =>
    req<{
      experiment_id: number;
      success_metric: SuccessMetric;
      funnel: FunnelRow[];
    }>(`/admin/api/experiments/${id}/funnel`),
};

export type ExperimentStatus = "draft" | "running" | "paused" | "done";
export type SuccessMetric = "qualified" | "won" | "replied_3+";

export interface StyleSummary {
  id: number;
  slug: string;
  display_name: string;
  version: number;
  parent_id: number | null;
  is_active: boolean;
  created_at: number;
}

export interface StyleDetail extends StyleSummary {
  /** Parsed Style object (matches StyleSchema) when valid, null otherwise. */
  config: unknown;
  /** Raw JSON string from the DB — useful when `config` is null due to parse error. */
  config_raw: string;
  /** Set when Zod validation failed; null when `config` is usable. */
  parse_error: string | null;
}

export interface Experiment {
  id: number;
  slug: string;
  status: ExperimentStatus;
  success_metric: SuccessMetric;
  allocation: Record<string, number> | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export interface PlaygroundResult {
  stage: string;
  stage_source: "auto" | "override";
  kb_hits: Array<{
    chunk_id: number;
    title: string;
    text: string;
    distance: number;
  }>;
  system_prompt: string;
  reply: string;
  duration_ms: number;
  model: { id: string; temperature: number };
}

export interface FunnelRow {
  style_id: number;
  slug: string;
  display_name: string;
  conversations: number;
  qualified: number;
  won: number;
  lost: number;
  pending: number;
  escalated_to_human: number;
}

export { ApiError };
