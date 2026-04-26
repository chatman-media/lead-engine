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

export const LLM_PROVIDERS = ["openai", "ollama"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const llmProvider = envEnum<LlmProvider>(
  "LLM_PROVIDER",
  LLM_PROVIDERS,
  "openai",
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
} as const;

export type AppConfig = typeof config;
export type Persona = AppConfig["persona"];

/** The single source of truth for the embedding dimension currently in use. */
export function activeEmbeddingDim(c: typeof config = config): number {
  return c.llm.provider === "ollama"
    ? c.ollama.embeddingDim
    : c.openai.embeddingDim;
}

/** True when there is enough config for the bot to actually answer via LLM. */
export function llmIsConfigured(c: typeof config = config): boolean {
  return c.llm.provider === "ollama" ? !!c.ollama.host : !!c.openai.apiKey;
}

export { env };
