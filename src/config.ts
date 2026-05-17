import { resolve } from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function envOptional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer`);
  return n;
}

function envFloat(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be a number`);
  return n;
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(`Env ${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
  }
  return raw as T;
}

function envTruthy(name: string, fallback = false): boolean {
  const raw = process.env[name]?.toLowerCase()?.trim();
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export const LLM_PROVIDERS = ["openai", "ollama", "openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const llmProvider = envEnum<LlmProvider>("LLM_PROVIDER", LLM_PROVIDERS, "openai");

// Embeddings are decoupled from chat because OpenRouter only exposes chat
// completions — it has no /embeddings endpoint. When LLM_PROVIDER=openrouter
// you still need a place for vector search to live (OpenAI, or a local Ollama
// running a small embedder like `nomic-embed-text`/`bge-m3`).
//
// Default: match LLM_PROVIDER when it's openai/ollama. When chat is on
// OpenRouter, default the embedder to ollama (cheapest, runs locally on
// even modest hardware since embedding models are 100M-500M params).
export const EMBEDDING_PROVIDERS = ["openai", "ollama"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

const embeddingProvider = envEnum<EmbeddingProvider>(
  "EMBEDDING_PROVIDER",
  EMBEDDING_PROVIDERS,
  llmProvider === "openrouter" ? "ollama" : (llmProvider as EmbeddingProvider),
);

// Vision (photo classification) provider. Both OpenRouter and OpenAI expose
// the same OpenAI-compatible /chat/completions endpoint with `image_url`
// content parts — only the credentials, base URL, default model and the
// OpenRouter-only `reasoning` request param differ. Decoupled from
// LLM_PROVIDER so vision can run on a different provider than chat.
export const VISION_PROVIDERS = ["openrouter", "openai"] as const;
export type VisionProvider = (typeof VISION_PROVIDERS)[number];

const visionProvider = envEnum<VisionProvider>("VISION_PROVIDER", VISION_PROVIDERS, "openrouter");

export const PERSONA_ROLES = ["human", "assistant"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

const ollamaDefaults = {
  chatModel: "llama3.1",
  embedModel: "nomic-embed-text",
  embedDim: 768,
};

export const config = {
  port: envInt("PORT", 3000),
  publicBaseUrl: envOptional("PUBLIC_BASE_URL", "http://localhost:3000"),
  databaseUrl: envOptional("DATABASE_URL", ""),
  telegram: {
    botToken: envOptional("TELEGRAM_BOT_TOKEN"),
    webhookSecret: envOptional("TELEGRAM_WEBHOOK_SECRET", "dev-secret"),
    /**
     * Group chat where new lead cards are posted (with approve/reject
     * inline buttons). When unset, lead creation still works through the
     * admin UI but no Telegram card is posted. The bot must be added as
     * a member of this chat (admin role recommended for editing cards).
     */
    leadsChatId: (() => {
      const raw = envOptional("LEADS_CHAT_ID", "");
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    })(),
    /**
     * Group chat where the visa-submission package is posted once the
     * lead transitions to `docs_complete`. Same opt-in semantics as
     * LEADS_CHAT_ID.
     */
    visaChatId: (() => {
      const raw = envOptional("VISA_CHAT_ID", "");
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    })(),
  },
  llm: {
    provider: llmProvider,
    embeddingProvider,
  },
  rag: {
    /** pgvector cosine distance threshold; hits above are dropped before LLM. */
    maxDistance: envFloat("RAG_MAX_DISTANCE"),
    /** Top-K vector hits per query. */
    topK: envInt("RAG_TOP_K", 5),
    /**
     * Sampling temperature for the legacy persona path (`BOT_PERSONA_*` без sales-style).
     * Не действует когда включён BOT_SALES_STYLE — там температура из стиля.
     * Если не задано: человек («human») ~0.55, ассистент ~0.38 — живее текста,
     * но факты по-прежнему только из CONTEXT.
     */
    chatTemperature: envFloat("RAG_CHAT_TEMPERATURE"),
    /**
     * Cross-session memory: extract facts about the candidate after each
     * turn and inject them into the next system prompt. Adds one async LLM
     * call per turn AFTER the reply (does not delay the reply itself).
     * Default: off (opt-in until you've seen the extraction quality on your model).
     */
    userMemory: envTruthy("RAG_USER_MEMORY", true),
    /**
     * Query rewriting: rephrase the user question into a search-friendly
     * query before vector retrieval. Resolves pronouns ("это", "там") using
     * recent history — solves the "follow-up question loses context" issue.
     * Adds one LLM call per turn BEFORE the reply (small models are <500ms).
     * Default: off.
     */
    queryRewrite: envTruthy("RAG_QUERY_REWRITE", true),
    /**
     * Reflection: after generating an answer, verify all factual claims are
     * grounded in CONTEXT. If not, return NO_CONTEXT instead of sending a
     * potentially hallucinated reply. Adds one LLM call per turn — only
     * fires on grounded turns (skipped for smalltalk / fact / NO_CONTEXT).
     * Default: off.
     */
    reflect: envTruthy("RAG_REFLECT", true),
    /**
     * Hybrid retrieval: combine vector search with BM25 keyword search and
     * fuse via Reciprocal Rank Fusion. Catches exact-match queries (numbers,
     * proper nouns, technical terms) that pure embedding search misranks.
     * No extra LLM calls — only one extra PostgreSQL FTS query per turn.
     * Default: off.
     */
    hybridSearch: envTruthy("RAG_HYBRID_SEARCH", true),
    /**
     * Conversation summarization: when total messages exceed ~30, older
     * turns get compressed into a paragraph stored in
     * `conversations.summary_json` and injected into the system prompt so
     * the LLM has continuity beyond the last 12 raw messages. Refreshed
     * lazily after each reply (1 LLM call per refresh, NOT per turn —
     * staleness threshold is 8 messages). Default: off.
     */
    conversationSummary: envTruthy("RAG_CONVERSATION_SUMMARY", true),
    /**
     * Topic-routed retrieval: when the question's topic can be classified
     * deterministically (regex over visa / payment / schedule / housing /
     * locations / application keywords), filter KB search to docs tagged
     * with that topic. Falls back to global search on ambiguous questions
     * or when topic-filtered retrieval yields zero hits. Free at query time
     * (no LLM); requires KB docs to be tagged at ingest (--topic flag or
     * `<topic>/` directory layout in `bun scripts/ingest.ts`). Default: off.
     */
    topicRouting: envTruthy("RAG_TOPIC_ROUTING", true),
    /**
     * Self-grade each assistant reply against the configured skill set:
     * after generation, ask the LLM which skills were demonstrably used.
     * Result is appended to `messages.meta_json.telemetry.skills_used`
     * for later attribution (Phase 2 ELO, analytics dashboards).
     *
     * +1 LLM call per turn — fire-and-forget after reply, doesn't block
     * the candidate. Default off; flip on during research windows.
     */
    skillGrading: envTruthy("RAG_SKILL_GRADING", true),
    /**
     * Books-priority retrieval: when enabled, the bot first searches only
     * documents tagged with topic="books" (management / manipulation library).
     * If those return ≥1 hit the bot answers from books; only falls back to
     * the general KB when the books slice is empty. Default: off.
     */
    booksPriority: envTruthy("RAG_BOOKS_PRIORITY", true),
  },
  openai: {
    apiKey: envOptional("OPENAI_API_KEY"),
    baseUrl: envOptional("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    chatModel: envOptional("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
    embeddingModel: envOptional("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    embeddingDim: envInt("OPENAI_EMBEDDING_DIM", envInt("EMBEDDING_DIM", 1536)),
  },
  /** Optional separate embedding endpoint (e.g. Voyage AI, separate OpenAI key).
   *  When set, overrides the openai.* embedding fields for the embedder only.
   *  The chat LLM still uses OPENAI_API_KEY / OPENAI_BASE_URL. */
  embed: {
    apiKey: envOptional("EMBED_API_KEY") || undefined,
    baseUrl: envOptional("EMBED_BASE_URL") || undefined,
    model: envOptional("EMBED_MODEL") || undefined,
    dim: envInt("EMBED_DIM", 0) || undefined,
  },
  ollama: {
    host: envOptional("OLLAMA_HOST", "http://localhost:11434"),
    chatModel: envOptional("OLLAMA_CHAT_MODEL", ollamaDefaults.chatModel),
    embeddingModel: envOptional("OLLAMA_EMBEDDING_MODEL", ollamaDefaults.embedModel),
    embeddingDim: envInt("OLLAMA_EMBEDDING_DIM", ollamaDefaults.embedDim),
  },
  openrouter: {
    apiKey: envOptional("OPENROUTER_API_KEY"),
    baseUrl: envOptional("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    /** OpenRouter slug, e.g. "anthropic/claude-haiku-4.5", "openai/gpt-4o-mini". */
    chatModel: envOptional("OPENROUTER_CHAT_MODEL", "anthropic/claude-haiku-4.5"),
    /** Optional analytics: sent as `HTTP-Referer`. */
    siteUrl: envOptional("OPENROUTER_SITE_URL", ""),
    /** Optional analytics: sent as `X-Title`. */
    appName: envOptional("OPENROUTER_APP_NAME", "tg-chatbot"),
    /** Balance (USD) below which the monitor DMs the operator a low-balance
     *  warning. The background check itself is always on when chat runs
     *  through OpenRouter. */
    lowBalanceUsd: envFloat("OPENROUTER_LOW_BALANCE_USD", 5) ?? 5,
  },
  /**
   * Photo classification: when a candidate sends a photo, classify it as
   * passport / full-body / portrait / other via a vision model. Feeds the
   * lead intake counters (accurate passport detection instead of the
   * "total photos >= 7" heuristic). Routes through OpenRouter or OpenAI
   * (VISION_PROVIDER) — reuses that provider's apiKey / baseUrl. Resolve
   * the effective credentials via `visionCredentials()`. Default: off (opt-in).
   */
  vision: {
    enabled: envTruthy("VISION_ENABLED", true),
    provider: visionProvider,
    /** Vision-capable model id — OpenRouter slug or OpenAI model name. */
    model: envOptional(
      "VISION_MODEL",
      visionProvider === "openai" ? "gpt-4o-mini" : "google/gemini-2.5-flash",
    ),
  },
  /**
   * Proactive waiting-period check-ins: while a lead waits in
   * `docs_pending` / `submitted`, the bot DMs a warm "как дела?" nudge
   * every `checkinIntervalDays`. Opt-in — proactive outbound messaging
   * should be a deliberate operator choice.
   */
  leads: {
    proactiveCheckins: envTruthy("LEAD_PROACTIVE_CHECKINS", false),
    checkinIntervalDays: envInt("LEAD_CHECKIN_INTERVAL_DAYS", 4),
  },
  /**
   * Where userbot-channel media (photos sent to the personal account) is
   * stored on disk. Bot API media is fetched on demand via the bot token,
   * but MTProto media has no Bot API file_id — the userbot downloads the
   * bytes once and saves them here; the admin serves them from this dir.
   * Relative paths resolve against the app root.
   */
  media: {
    dir: resolve(import.meta.dir, "..", envOptional("MEDIA_DIR", "data/media")),
  },
  admin: {
    sessionCookie: envOptional("ADMIN_SESSION_COOKIE", "tg_admin_sid"),
    sessionTtlDays: envInt("ADMIN_SESSION_TTL_DAYS", 14),
    /**
     * When set, the bot sends a Telegram DM to this user ID whenever a new
     * unanswered question is queued (kb_suggestion created). Set to your own
     * Telegram user ID so you get notified without having to watch the admin UI.
     */
    tgUserId: (() => {
      const raw = envOptional("ADMIN_TG_USER_ID", "");
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    })(),
  },
  persona: {
    /** What the bot calls itself in chat. */
    name: envOptional("BOT_PERSONA_NAME", "Менеджер"),
    /** "human" → bot poses as a real person; "assistant" → openly an AI. */
    role: envEnum<PersonaRole>("BOT_PERSONA_ROLE", PERSONA_ROLES, "human"),
    /** Company / agency name (optional, used in greetings and signatures). */
    company: envOptional("BOT_PERSONA_COMPANY", ""),
    /**
     * JSON object of fixed personal facts, e.g.:
     * BOT_PERSONA_FACTS='{"city":"Шаохинг","age":"26","status":"Не замужем."}'
     * Known keys: city, age, status, experience. Bypasses RAG for direct
     * personal questions and grounds the system prompt.
     */
    facts: (() => {
      const raw = envOptional("BOT_PERSONA_FACTS", "");
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        return undefined;
      }
    })(),
  },
  userbot: {
    /** When true, connect to Telegram as a personal account via MTProto. */
    enabled: envTruthy("TELEGRAM_USERBOT", false),
    /** From https://my.telegram.org — required when TELEGRAM_USERBOT=1. */
    apiId: envInt("TELEGRAM_API_ID", 0),
    apiHash: envOptional("TELEGRAM_API_HASH", ""),
  },
  sales: {
    /**
     * When set, the bot uses the sales-style engine instead of the env-based
     * persona. Value is a Style.slug — see `src/sales/styles/` for available
     * slugs ("flirty-belfort-v1", "empathetic-nepq-v1", "cold-direct-pas-v1")
     * or `bun run scripts/list-sales-styles.ts` if added later.
     *
     * Empty string = use the legacy `BOT_PERSONA_*` path.
     *
     * Phase 1: single forced style applied to ALL conversations.
     * Phase 2: per-conversation A/B selection via DB-backed `styles` table.
     */
    forcedStyleSlug: envOptional("BOT_SALES_STYLE", ""),
    /**
     * Funnel-stage routing strategy:
     *   "regex" (default) — fast Cyrillic-aware regex in stage-router.ts.
     *   "llm"             — LLM-based classifier with regex fallback below
     *                        the confidence threshold. More accurate on
     *                        nuanced messages, but adds one LLM call per
     *                        inbound (5-30s extra on Ollama+CPU; ~$0.0001-
     *                        0.001 extra on OpenRouter per turn).
     */
    stageClassifier: envEnum<"regex" | "llm">(
      "SALES_STAGE_CLASSIFIER",
      ["regex", "llm"] as const,
      "regex",
    ),
    /** Below this confidence the LLM result is discarded for regex. Default 0.6. */
    stageClassifierThreshold: envFloat("SALES_STAGE_CLASSIFIER_THRESHOLD", 0.6),
  },
} as const;

export type AppConfig = typeof config;
export type Persona = AppConfig["persona"];

/** The single source of truth for the embedding dimension currently in use.
 *  Reads from the embedding provider, NOT the chat provider — these are decoupled. */
export function activeEmbeddingDim(c: typeof config = config): number {
  return c.llm.embeddingProvider === "ollama" ? c.ollama.embeddingDim : c.openai.embeddingDim;
}

/** True when there is enough config for the bot to answer via LLM chat.
 *  Embedder is optional — missing key falls back to NullEmbeddingClient (KB search disabled). */
export function llmIsConfigured(c: typeof config = config): boolean {
  return c.llm.provider === "ollama"
    ? !!c.ollama.host
    : c.llm.provider === "openrouter"
      ? !!c.openrouter.apiKey
      : !!c.openai.apiKey;
}

/** Effective credentials for the photo-classification vision call.
 *  Picks the OpenRouter or OpenAI endpoint based on `vision.provider`. */
export function visionCredentials(c: typeof config = config): {
  provider: VisionProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
} {
  if (c.vision.provider === "openai") {
    return {
      provider: "openai",
      apiKey: c.openai.apiKey,
      baseUrl: c.openai.baseUrl,
      model: c.vision.model,
    };
  }
  return {
    provider: "openrouter",
    apiKey: c.openrouter.apiKey,
    baseUrl: c.openrouter.baseUrl,
    model: c.vision.model,
  };
}

export { env };

/** When true, every Telegram sender is accepted: missing users rows are created on first message. */
export function telegramOpenAccess(): boolean {
  return envTruthy("TELEGRAM_OPEN_ACCESS", false);
}
