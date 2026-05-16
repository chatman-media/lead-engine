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

export type ConversationSource = "bot" | "userbot" | "self_play";

export interface Conversation {
  id: number;
  mode: "ai" | "queued" | "human";
  /** Which channel the candidate reached us on. `bot` = test traffic via
   *  the BotAPI bot; `userbot` = real funnel via the personal account. */
  source: ConversationSource;
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
  /** Free-form per-message metadata. Set by the webhook when persisting
   *  assistant replies — `used_chunk_ids` (KB hits used for the answer) and
   *  `telemetry` (per-turn diagnostics: retrieval distances, latencies,
   *  reflection verdict, …). The frontend treats this opaquely except
   *  for the optional `telemetry` block surfaced in the debug panel. */
  meta_json?: string | null;
}

/** Per-turn telemetry — mirrors `AnswerTelemetry` in src/rag/answer.ts.
 *  Surfaced in the chat debug panel so operators can diagnose quality. */
export interface MessageTelemetry {
  path: "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok";
  total_ms?: number;
  retrieval_ms?: number;
  generation_ms?: number;
  top_distances?: number[];
  hybrid?: boolean;
  original_query?: string;
  rewritten_query?: string;
  reflect?: { grounded: boolean; reason?: string };
}

export interface UserMemory {
  facts: Record<string, string>;
  lastExtractedFromMsgId?: number;
  updatedAt?: number;
}

export interface ConversationSummary {
  summary: string;
  summarizedThroughMsgId: number;
  updatedAt: number;
}

export interface KbDocument {
  id: number;
  source: string;
  title: string;
  content_hash: string;
  topic: string | null;
  created_at: number;
  /** Present on list responses; absent on single-doc detail. */
  chunk_count?: number;
}

export interface SkillDto {
  id: number;
  slug: string;
  family: "cialdini" | "voss" | "nlp" | "sales" | "custom";
  display_name: string;
  description: string;
  prompt_fragment: string;
  applicable_stages: string[];
  intent: string;
  is_enabled: boolean;
  attached_to_styles: number;
  outcomes: {
    count: number;
    wins: number;
    losses: number;
    draws: number;
    win_rate: number | null;
  };
}

export interface SelfPlayMatchSummary {
  id: number;
  style_slug: string;
  persona_slug: string;
  outcome: "won" | "lost" | "draw";
  judge_reason: string | null;
  turns: number;
  skills_count: number;
  lead_id: number | null;
  fabrications_caught: number;
  created_at: number;
}

export interface SelfPlayMatchDetail {
  id: number;
  style_slug: string;
  persona_slug: string;
  persona_display_name: string;
  outcome: "won" | "lost" | "draw";
  judge_reason: string | null;
  turns: number;
  skills: string[];
  lead_id: number | null;
  fabrications_caught: number;
  created_at: number;
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
}

export interface SelfPlayMatrixRow {
  style_slug: string;
  persona_slug: string;
  won: number;
  lost: number;
  draw: number;
  total: number;
}

export interface SelfPlayPersona {
  slug: string;
  display_name: string;
  summary: string;
}

export interface PairwiseMatchRow {
  id: number;
  style_a_slug: string;
  style_b_slug: string;
  persona_slug: string;
  persona_display_name: string;
  winner: "a" | "b" | "draw";
  judge_reason: string | null;
  match_a_id: number | null;
  match_b_id: number | null;
  elo_a_after: number;
  elo_b_after: number;
  created_at: number;
}

export interface PairwiseMatrixRow {
  style_a_slug: string;
  style_b_slug: string;
  a_wins: number;
  b_wins: number;
  draws: number;
  total: number;
}

export type CoachProposalStatus = "pending" | "applied" | "dismissed";

export interface CoachProposalRow {
  id: number;
  style_slug: string;
  sample_size: number;
  persona_filter: string | null;
  summary: string;
  edits_json: string;
  rationale_json: string;
  raw_output: string | null;
  status: CoachProposalStatus;
  created_at: number;
  decided_at: number | null;
  decided_by_admin_id: number | null;
}

export type ShadowEvalStatus = "running" | "complete" | "failed";
export type ShadowEvalDecision = "keep" | "rollback" | "inconclusive";

export interface ShadowEvalRow {
  id: number;
  proposal_id: number;
  parent_style_slug: string;
  parent_style_id: number;
  new_style_slug: string;
  new_style_id: number;
  pairs_planned: number;
  pairs_done: number;
  a_wins: number;
  b_wins: number;
  draws: number;
  win_rate_lb: number | null;
  status: ShadowEvalStatus;
  decision: ShadowEvalDecision | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface CoachProposalDetail extends CoachProposalRow {
  edits: {
    voice_tone?: string;
    voice_forbid_add?: string[];
    hooks_add?: Array<{ kind: string; text: string }>;
    stage_guidance?: Partial<{
      opener: string;
      qualify: string;
      pitch: string;
      objection: string;
      close: string;
    }>;
    fewshot_add?: Array<{ user: string; assistant: string; stage?: string }>;
    skills_attach?: string[];
    skills_detach?: string[];
  };
  rationale: string[];
}

export interface StyleRatingDto {
  style_slug: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  last_outcome_at: number | null;
  updated_at: number;
}

export interface KbChunkPreview {
  id: number;
  chunk_index: number;
  token_count: number;
  text: string;
}

export interface Vacancy {
  id: number;
  title: string;
  body: string;
  url: string | null;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

export type LeadState =
  | "intake_pending"
  | "intake_complete"
  | "approved"
  | "rejected"
  | "docs_pending"
  | "docs_complete"
  | "submitted"
  | "closed";

export interface Lead {
  id: number;
  user_id: number;
  state: LeadState;
  intake_json: string | null;
  visa_docs_json: string | null;
  application_id: string | null;
  ops_chat_id: number | null;
  ops_message_id: number | null;
  rejected_reason: string | null;
  decided_by_admin_id: number | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
  tg_user_id: number;
  tg_username: string | null;
}

export interface LeadCounts {
  intake_pending: number;
  intake_complete: number;
  approved: number;
  rejected: number;
  docs_pending: number;
  docs_complete: number;
  submitted: number;
  closed: number;
}

/** Mirrors `VisaFields` in src/leads/visa-docs.ts. All fields optional. */
export interface VisaDocs {
  family_name?: string;
  given_name?: string;
  date_of_birth?: string;
  country_of_birth?: string;
  birth_province?: string;
  city_of_birth?: string;
  marital_status?: string;
  current_nationality?: string;
  national_id_number?: string;
  other_nationalities?: string;
  other_permanent_residence?: string;
  held_other_nationalities?: string;
  passport_number?: string;
  passport_issuing_country?: string;
  passport_issuing_place?: string;
  passport_expiration_date?: string;
  current_address?: string;
  phone?: string;
  mobile_phone?: string;
  email?: string;
  father_name?: string;
  father_nationality?: string;
  father_dob?: string;
  mother_name?: string;
  mother_nationality?: string;
  mother_dob?: string;
  been_to_china?: string;
  previous_chinese_visa?: string;
  work_experience?: string;
  education?: string;
  travel_history_12mo?: string;
  family_other?: string;
}

export interface IntakeFields {
  height?: string;
  weight?: string;
  city?: string;
  departure_readiness?: string;
  photos_count?: number;
  videos_count?: number;
  passport_photo_received?: boolean;
  dance_video_received?: boolean;
}

export interface LeadEvent {
  id: number;
  lead_id: number;
  from_state: LeadState | null;
  to_state: LeadState;
  by_admin_id: number | null;
  notes: string | null;
  created_at: number;
}

export interface LeadNote {
  id: number;
  lead_id: number;
  by_admin_id: number | null;
  body: string;
  created_at: number;
}

export interface LeadDetail {
  lead: Lead;
  user: User;
  intake: IntakeFields | null;
  visa_docs: VisaDocs | null;
  conversation_id: number | null;
  recent_messages: Array<{ role: string; text: string }>;
  events: LeadEvent[];
  notes: LeadNote[];
}

/** Mirror of the GET /admin/api/status response — see src/admin/api.ts. */
export interface SystemStatus {
  rag: {
    userMemory: boolean;
    queryRewrite: boolean;
    reflect: boolean;
    hybridSearch: boolean;
    conversationSummary: boolean;
    topicRouting: boolean;
    topK: number;
    maxDistance: number | null;
  };
  providers: {
    chat: { provider: string; model: string };
    embed: { provider: string; model: string; dim: number };
  };
  routing: {
    mode: "env_override" | "running_experiment" | "legacy_persona" | "none";
    active_style_slug: string | null;
    running_experiment_slug: string | null;
    legacy_persona: { name: string; role: string; company: string | null } | null;
    stage_classifier: "regex" | "llm";
  };
  kb: {
    documents: number;
    chunks: number;
    by_topic: Array<{ topic: string | null; documents: number; chunks: number }>;
    styles: number;
  };
  conversations: {
    total: number;
    by_mode: Record<string, number>;
    with_summary: number;
  };
  users: {
    total: number;
    by_status: Record<string, number>;
    with_memory: number;
  };
  messages: {
    total: number;
    by_role: Record<string, number>;
  };
  vacancies: {
    active: number;
  };
  leads: {
    by_state: LeadCounts;
    leads_chat_configured: boolean;
    visa_chat_configured: boolean;
  };
  bot_health:
    | {
        ok: true;
        bot_id: number;
        username: string | null;
        first_name: string | null;
        checked_at: number;
      }
    | { ok: false; error: string; checked_at: number };
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    req<{ admin: Admin }>("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () => req<{ ok: boolean }>("/admin/api/logout", { method: "POST" }),

  me: () => req<{ admin: Admin }>("/admin/api/me"),

  users: () => req<{ users: User[] }>("/admin/api/users"),

  userDetail: (id: number) =>
    req<{
      user: User;
      conversation: Conversation | null;
      lead: Lead | null;
      memory: UserMemory;
      recent_messages: Array<{
        id: number;
        role: "user" | "assistant" | "human" | "system";
        text: string;
        tg_message_id: number | null;
        created_at: number;
      }>;
    }>(`/admin/api/users/${id}`),

  conversations: (escalated?: boolean, source?: ConversationSource) => {
    const params = new URLSearchParams();
    if (escalated) params.set("escalated", "1");
    if (source) params.set("source", source);
    const qs = params.toString();
    return req<{ conversations: Conversation[] }>(`/admin/api/conversations${qs ? `?${qs}` : ""}`);
  },

  conversation: (id: number) =>
    req<{
      conversation: Conversation;
      user: User;
      messages: Message[];
      memory: UserMemory;
      summary: ConversationSummary | null;
    }>(`/admin/api/conversations/${id}`),

  status: () => req<SystemStatus>("/admin/api/status"),

  vacancies: () => req<{ vacancies: Vacancy[] }>("/admin/api/vacancies"),

  createVacancy: (input: {
    title: string;
    body: string;
    url?: string | null;
    is_active?: boolean;
  }) =>
    req<{ vacancy: Vacancy }>("/admin/api/vacancies", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateVacancy: (
    id: number,
    patch: {
      title?: string;
      body?: string;
      url?: string | null;
      is_active?: boolean;
    },
  ) =>
    req<{ vacancy: Vacancy }>(`/admin/api/vacancies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteVacancy: (id: number) =>
    req<{ ok: boolean; deleted: number }>(`/admin/api/vacancies/${id}`, {
      method: "DELETE",
    }),

  // KB management — operator-facing CRUD over indexed documents.
  kbDocuments: (opts?: { topic?: string | null; q?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.topic !== undefined) {
      qs.set("topic", opts.topic === null ? "__untagged__" : opts.topic);
    }
    if (opts?.q) qs.set("q", opts.q);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return req<{
      documents: KbDocument[];
      topics: string[];
      totals: { documents: number; chunks: number };
    }>(`/admin/api/kb/documents${tail}`);
  },

  kbDocument: (id: number) =>
    req<{ document: KbDocument; chunks: KbChunkPreview[] }>(`/admin/api/kb/documents/${id}`),

  updateKbDocument: (id: number, patch: { topic: string | null }) =>
    req<{ document: KbDocument }>(`/admin/api/kb/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteKbDocument: (id: number) =>
    req<{ ok: boolean; deleted: number }>(`/admin/api/kb/documents/${id}`, {
      method: "DELETE",
    }),

  analytics: (window: "1h" | "24h" | "7d" | "30d" = "24h") =>
    req<{
      window: string;
      window_seconds: number;
      since_unix: number;
      total_assistant_messages: number;
      by_path: Array<{ path: string; count: number }>;
      by_topic: Array<{ topic: string; count: number }>;
      latency: {
        total_ms: {
          p50: number | null;
          p95: number | null;
          p99: number | null;
          avg: number | null;
          count: number;
        };
        retrieval_ms: {
          p50: number | null;
          p95: number | null;
          p99: number | null;
          avg: number | null;
          count: number;
        };
        generation_ms: {
          p50: number | null;
          p95: number | null;
          p99: number | null;
          avg: number | null;
          count: number;
        };
      };
      ungrounded_count: number;
      hybrid_count: number;
      rewrite_count: number;
      unanswered_rate: number;
    }>(`/admin/api/analytics?window=${window}`),

  // Skill catalogue
  skills: () => req<{ skills: SkillDto[] }>("/admin/api/skills"),
  setSkillEnabled: (slug: string, enabled: boolean) =>
    req<{ skill: SkillDto }>(`/admin/api/skills/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify({ is_enabled: enabled }),
    }),
  styleSkills: (styleId: number) => req<{ slugs: string[] }>(`/admin/api/styles/${styleId}/skills`),
  styleRatings: () => req<{ ratings: StyleRatingDto[] }>("/admin/api/style-ratings"),
  selfPlayMatches: (opts?: {
    style?: string;
    persona?: string;
    outcome?: "won" | "lost" | "draw";
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.style) params.set("style", opts.style);
    if (opts?.persona) params.set("persona", opts.persona);
    if (opts?.outcome) params.set("outcome", opts.outcome);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return req<{
      total: number;
      matches: SelfPlayMatchSummary[];
      matrix: SelfPlayMatrixRow[];
      personas: SelfPlayPersona[];
    }>(`/admin/api/self-play${q ? `?${q}` : ""}`);
  },
  selfPlayMatch: (id: number) => req<{ match: SelfPlayMatchDetail }>(`/admin/api/self-play/${id}`),
  deleteSelfPlayMatch: (id: number) =>
    req<{ ok: true; deleted: number }>(`/admin/api/self-play/${id}`, {
      method: "DELETE",
    }),
  pairwiseMatches: (opts?: {
    a?: string;
    b?: string;
    persona?: string;
    winner?: "a" | "b" | "draw";
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.a) params.set("a", opts.a);
    if (opts?.b) params.set("b", opts.b);
    if (opts?.persona) params.set("persona", opts.persona);
    if (opts?.winner) params.set("winner", opts.winner);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return req<{
      total: number;
      matches: PairwiseMatchRow[];
      matrix: PairwiseMatrixRow[];
      personas: SelfPlayPersona[];
    }>(`/admin/api/pairwise${q ? `?${q}` : ""}`);
  },
  pairwiseMatch: (id: number) => req<{ match: PairwiseMatchRow }>(`/admin/api/pairwise/${id}`),
  deletePairwiseMatch: (id: number) =>
    req<{ ok: true; deleted: number }>(`/admin/api/pairwise/${id}`, {
      method: "DELETE",
    }),
  coachProposals: (opts?: { style?: string; status?: CoachProposalStatus; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.style) params.set("style", opts.style);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const q = params.toString();
    return req<{ proposals: CoachProposalRow[]; pending_count: number }>(
      `/admin/api/coach${q ? `?${q}` : ""}`,
    );
  },
  coachProposal: (id: number) => req<{ proposal: CoachProposalDetail }>(`/admin/api/coach/${id}`),
  runCoach: (body: { style_slug: string; sample?: number; persona?: string; model?: string }) =>
    req<{ proposal: CoachProposalDetail }>("/admin/api/coach/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  decideCoachProposal: (id: number, status: "applied" | "dismissed") =>
    req<{ proposal: CoachProposalDetail }>(`/admin/api/coach/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  applyCoachProposal: (id: number, opts?: { skip_skills?: boolean }) =>
    req<{
      proposal: CoachProposalDetail;
      new_style: { id: number; slug: string; version: number };
    }>(`/admin/api/coach/${id}/apply`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),
  startShadowEval: (
    id: number,
    body?: { runs?: number; personas?: string[]; max_turns?: number },
  ) =>
    req<{ shadow_eval: ShadowEvalRow }>(`/admin/api/coach/${id}/shadow-eval`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  getShadowEval: (id: number) =>
    req<{ shadow_eval: ShadowEvalRow | null }>(`/admin/api/coach/${id}/shadow-eval`),
  rollbackCoachProposal: (id: number) =>
    req<{
      ok: true;
      deactivated: { id: number; slug: string; version: number };
      reactivated: { id: number; slug: string; version: number };
    }>(`/admin/api/coach/${id}/rollback`, { method: "POST" }),
  deleteCoachProposal: (id: number) =>
    req<{ ok: true; deleted: number }>(`/admin/api/coach/${id}`, { method: "DELETE" }),
  recommendSkills: (opts?: { minSamples?: number; accept?: number }) => {
    const params = new URLSearchParams();
    if (opts?.minSamples !== undefined) params.set("minSamples", String(opts.minSamples));
    if (opts?.accept !== undefined) params.set("accept", String(opts.accept));
    const q = params.toString();
    return req<{
      params: { minSamples: number; accept: number };
      total_outcomes: number;
      recommendations: Array<{
        slug: string;
        display_name: string;
        family: string;
        observed_rate: number | null;
        confidence_lower: number;
        count: number;
        wins: number;
        losses: number;
        draws: number;
        recommended: boolean;
      }>;
    }>(`/admin/api/skills/recommend${q ? `?${q}` : ""}`);
  },
  setStyleSkills: (styleId: number, slugs: string[]) =>
    req<{ ok: true; attached: number }>(`/admin/api/styles/${styleId}/skills`, {
      method: "PUT",
      body: JSON.stringify({ slugs }),
    }),

  ingestKbDocument: (input: { title: string; body: string; topic?: string | null }) =>
    req<{ ok: true; document_id: number; chunks: number; created: boolean }>(
      "/admin/api/kb/ingest",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),

  uploadBook: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/admin/api/kb/books/upload", {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
    }
    return res.json() as Promise<{
      ok: true;
      document_id: number;
      chunks: number;
      created: boolean;
      filename: string;
    }>;
  },

  // Lead pipeline
  leads: (state?: LeadState) =>
    req<{ leads: Lead[]; counts: LeadCounts }>(`/admin/api/leads${state ? `?state=${state}` : ""}`),

  promoteLead: (conversationId: number) =>
    req<{ lead: Lead }>(`/admin/api/leads/from-conversation/${conversationId}`, { method: "POST" }),

  approveLead: (id: number) =>
    req<{ lead: Lead }>(`/admin/api/leads/${id}/approve`, { method: "POST" }),

  rejectLead: (id: number, reason?: string) =>
    req<{ lead: Lead }>(`/admin/api/leads/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  sendIntakeTemplate: (id: number) =>
    req<{ ok: boolean }>(`/admin/api/leads/${id}/send-intake`, {
      method: "POST",
    }),

  submitLeadToVisa: (id: number) =>
    req<{ lead: Lead; application_id: string }>(`/admin/api/leads/${id}/submit-to-visa`, {
      method: "POST",
    }),

  markLeadSubmitted: (id: number) =>
    req<{ lead: Lead; application_id: string | null }>(`/admin/api/leads/${id}/mark-submitted`, {
      method: "POST",
    }),

  leadDetail: (id: number) => req<LeadDetail>(`/admin/api/leads/${id}`),

  updateVisaDocs: (id: number, docs: Partial<VisaDocs>) =>
    req<{ visa_docs: VisaDocs }>(`/admin/api/leads/${id}/visa-docs`, {
      method: "PATCH",
      body: JSON.stringify({ docs }),
    }),

  addLeadNote: (leadId: number, body: string) =>
    req<{ note: LeadNote }>(`/admin/api/leads/${leadId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  deleteLeadNote: (leadId: number, noteId: number) =>
    req<{ ok: boolean }>(`/admin/api/leads/${leadId}/notes/${noteId}`, { method: "DELETE" }),

  deleteLead: (id: number) =>
    req<{ ok: boolean; deleted: number }>(`/admin/api/leads/${id}`, {
      method: "DELETE",
    }),

  updateUserMemory: (userId: number, facts: Record<string, string>) =>
    req<{ memory: UserMemory }>(`/admin/api/users/${userId}/memory`, {
      method: "PATCH",
      body: JSON.stringify({ facts }),
    }),

  take: (id: number) =>
    req<{ conversation: Conversation }>(`/admin/api/conversations/${id}/take`, { method: "POST" }),

  release: (id: number) =>
    req<{ conversation: Conversation }>(`/admin/api/conversations/${id}/release`, {
      method: "POST",
    }),

  sendMessage: (id: number, text: string) =>
    req<{ ok: boolean; tgError?: string }>(`/admin/api/conversations/${id}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  deleteConversation: (id: number) =>
    req<{ ok: boolean; deleted: number }>(`/admin/api/conversations/${id}`, { method: "DELETE" }),

  /** URL of the per-conversation JSONL export. Open in a new tab to trigger
   *  the browser's download flow (the server sets Content-Disposition). */
  conversationExportUrl: (id: number) => `/admin/api/conversations/${id}/export.jsonl`,

  /** Same-origin proxy URL for a Telegram file_id. Auth via admin
   *  session cookie. Used directly in <img src> / <video src>. */
  tgFileUrl: (fileId: string) => `/admin/api/tg-files/${encodeURIComponent(fileId)}`,

  /** URL of userbot-channel media (photos sent to the personal account),
   *  served from disk by message id — MTProto media has no Bot API file_id. */
  mediaUrl: (messageId: number) => `/admin/api/media/${messageId}`,

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
    if (filters.experimentId !== undefined) q.set("experiment_id", String(filters.experimentId));
    if (filters.userStatus) q.set("user_status", filters.userStatus);
    if (filters.mode) q.set("mode", filters.mode);
    if (filters.limit !== undefined) q.set("limit", String(filters.limit));
    const qs = q.toString();
    return `/admin/api/conversations/export.jsonl${qs ? `?${qs}` : ""}`;
  },

  // ─── Sales-style engine (Phase 2b) ───────────────────────────────────
  styles: () => req<{ styles: StyleSummary[] }>("/admin/api/styles"),

  style: (id: number) => req<{ style: StyleDetail }>(`/admin/api/styles/${id}`),

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

  experiments: () => req<{ experiments: Experiment[] }>("/admin/api/experiments"),

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

  // ─── KB Suggestions ───────────────────────────────────────────────────
  kbSuggestionCounts: () => req<SuggestionCounts>("/admin/api/kb/suggestions/counts"),

  kbSuggestions: (status?: SuggestionStatus) =>
    req<{ suggestions: KbSuggestion[]; counts: SuggestionCounts }>(
      `/admin/api/kb/suggestions${status ? `?status=${status}` : ""}`,
    ),

  kbSuggestion: (id: number) =>
    req<{ suggestion: KbSuggestion; context_messages: Message[] }>(
      `/admin/api/kb/suggestions/${id}`,
    ),

  updateKbSuggestionDraft: (id: number, answerDraft: string) =>
    req<{ suggestion: KbSuggestion }>(`/admin/api/kb/suggestions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ answer_draft: answerDraft }),
    }),

  approveKbSuggestion: (id: number) =>
    req<{ suggestion: KbSuggestion; kb_document_id: number }>(
      `/admin/api/kb/suggestions/${id}/approve`,
      { method: "POST" },
    ),

  rejectKbSuggestion: (id: number, reason?: string) =>
    req<{ suggestion: KbSuggestion }>(`/admin/api/kb/suggestions/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  createKbSuggestion: (input: {
    question_text: string;
    answer_draft?: string;
    source_conversation_id?: number;
  }) =>
    req<{ suggestion: KbSuggestion }>("/admin/api/kb/suggestions", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // ─── Operations / maintenance ─────────────────────────────────────────

  opsKbIngest: (body: { source: "curated" | "books" | "extracted" | "chats"; topic?: string }) =>
    req<{
      ok: boolean;
      source: string;
      dir: string;
      duration_ms: number;
      summary: { documents: number; chunks: number; skipped: number };
      provider: string;
      dim: number;
    }>("/admin/api/ops/kb/ingest", { method: "POST", body: JSON.stringify(body) }),

  opsKbWipe: () =>
    req<{ ok: boolean; deleted_chunks: number; deleted_documents: number }>(
      "/admin/api/ops/kb/wipe",
      { method: "POST", body: JSON.stringify({ confirm: "yes" }) },
    ),

  opsGetTelegramWebhook: () =>
    req<{ info: { url: string; pending_update_count: number } }>("/admin/api/ops/telegram/webhook"),

  opsSetTelegramWebhook: (input: { url: string; dropPending?: boolean }) =>
    req<{ ok: boolean; info: { url: string; pending_update_count: number } }>(
      "/admin/api/ops/telegram/webhook",
      { method: "PUT", body: JSON.stringify(input) },
    ),

  opsDeleteTelegramWebhook: (dropPending = false) =>
    req<{ ok: boolean }>("/admin/api/ops/telegram/webhook", {
      method: "DELETE",
      body: JSON.stringify({ dropPending }),
    }),

  opsReseedVacancies: () =>
    req<{ ok: boolean; inserted: number; urlPatched: number; skipped: number }>(
      "/admin/api/ops/vacancies/reseed",
      { method: "POST" },
    ),

  opsPurgeOutcomes: (input: { days?: number; dryRun?: boolean }) =>
    req<{
      ok: boolean;
      days: number;
      dry_run?: boolean;
      deleted?: { skill_outcomes: number; self_play_matches: number };
      would_delete?: { skill_outcomes: number; self_play_matches: number };
    }>("/admin/api/ops/skill-outcomes/purge", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  opsUserbotQueueStats: () =>
    req<{ by_status: Record<string, number>; userbot_enabled: boolean }>(
      "/admin/api/ops/userbot/queue-stats",
    ),

  getRuntimeSettings: () =>
    req<{ env_path: string; provider: string; settings: RuntimeSetting[] }>(
      "/admin/api/settings/runtime",
    ),

  updateRuntimeSettings: (updates: Record<string, string>) =>
    req<{ ok: boolean; updated: string[]; restart_required: boolean }>(
      "/admin/api/settings/runtime",
      { method: "PUT", body: JSON.stringify({ updates }) },
    ),
};

/** One operator-editable runtime setting (see src/admin/routes/settings.ts). */
export interface RuntimeSetting {
  key: string;
  label: string;
  hint: string;
  type: "text" | "number" | "boolean";
  /** Current effective value; "" means the code default is in use. */
  value: string;
}

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

// ─── KB Suggestions ───────────────────────────────────────────────────────

export type SuggestionStatus = "pending" | "ingested" | "rejected";

export interface KbSuggestion {
  id: number;
  question_text: string;
  answer_draft: string | null;
  status: SuggestionStatus;
  source_conversation_id: number | null;
  source_message_id: number | null;
  decided_by_admin_id: number | null;
  decided_at: number | null;
  kb_document_id: number | null;
  rejected_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface SuggestionCounts {
  pending: number;
  ingested: number;
  rejected: number;
}
