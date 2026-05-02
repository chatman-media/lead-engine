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

function envEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(
      `Env ${name} must be one of ${allowed.join(", ")} (got "${raw}")`,
    );
  }
  return raw as T;
}

export const LLM_PROVIDERS = ["openai", "ollama", "openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const llmProvider = envEnum<LlmProvider>(
  "LLM_PROVIDER",
  LLM_PROVIDERS,
  "openai",
);

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
  dbPath: envOptional("DB_PATH", "./data/bot.db"),
  telegram: {
    botToken: envOptional("TELEGRAM_BOT_TOKEN"),
    webhookSecret: envOptional("TELEGRAM_WEBHOOK_SECRET", "dev-secret"),
  },
  llm: {
    provider: llmProvider,
    embeddingProvider,
  },
  rag: {
    /** sqlite-vec L2 distance threshold; hits above are dropped before LLM. */
    maxDistance: envFloat("RAG_MAX_DISTANCE"),
    /** Top-K vector hits per query. */
    topK: envInt("RAG_TOP_K", 5),
  },
  openai: {
    apiKey: envOptional("OPENAI_API_KEY"),
    baseUrl: envOptional("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    chatModel: envOptional("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
    embeddingModel: envOptional(
      "OPENAI_EMBEDDING_MODEL",
      "text-embedding-3-small",
    ),
    embeddingDim: envInt("OPENAI_EMBEDDING_DIM", envInt("EMBEDDING_DIM", 1536)),
  },
  ollama: {
    host: envOptional("OLLAMA_HOST", "http://localhost:11434"),
    chatModel: envOptional("OLLAMA_CHAT_MODEL", ollamaDefaults.chatModel),
    embeddingModel: envOptional(
      "OLLAMA_EMBEDDING_MODEL",
      ollamaDefaults.embedModel,
    ),
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
  },
  admin: {
    sessionCookie: envOptional("ADMIN_SESSION_COOKIE", "tg_admin_sid"),
    sessionTtlDays: envInt("ADMIN_SESSION_TTL_DAYS", 14),
  },
  persona: {
    /** What the bot calls itself in chat. */
    name: envOptional("BOT_PERSONA_NAME", "Менеджер"),
    /** "human" → bot poses as a real person; "assistant" → openly an AI. */
    role: envEnum<PersonaRole>("BOT_PERSONA_ROLE", PERSONA_ROLES, "human"),
    /** Company / agency name (optional, used in greetings and signatures). */
    company: envOptional("BOT_PERSONA_COMPANY", ""),
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
  return c.llm.embeddingProvider === "ollama"
    ? c.ollama.embeddingDim
    : c.openai.embeddingDim;
}

/** True when there is enough config for the bot to actually answer via LLM.
 *  Both chat AND embeddings must be configured (RAG without embeddings = useless). */
export function llmIsConfigured(c: typeof config = config): boolean {
  const chatOk =
    c.llm.provider === "ollama"
      ? !!c.ollama.host
      : c.llm.provider === "openrouter"
        ? !!c.openrouter.apiKey
        : !!c.openai.apiKey;
  const embedOk =
    c.llm.embeddingProvider === "ollama" ? !!c.ollama.host : !!c.openai.apiKey;
  return chatOk && embedOk;
}

export { env };
