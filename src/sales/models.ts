/**
 * Registry of known-good models for the sales-bot use case, grouped by
 * provider. Used by the admin UI's model-picker dropdown and as
 * documentation about what's been actually tested.
 *
 * The runtime accepts ANY string as a model id (the existing OllamaChatClient
 * just passes it through), but this registry powers UX and validation hints.
 */

export interface ModelInfo {
  /** Provider-specific model id (Ollama tag, OpenRouter slug, etc.). */
  id: string;
  /** Which provider serves this model. */
  provider: "ollama" | "ollama-cloud" | "openrouter";
  /** Pretty name for the UI dropdown. */
  displayName: string;
  /** ~Memory required when loaded (local) OR "hosted" for cloud models. */
  size: string;
  /** How well the model handles conversational Russian (subjective). */
  russian: "excellent" | "good" | "decent" | "weak";
  /** Approximate output speed (tok/s). For local: warm GPU. For cloud: latency-bound. */
  approxTokensPerSec: number;
  /** When to pick this. One short sentence. */
  recommendation: string;
}

export const MODELS: readonly ModelInfo[] = [
  // ─── Local Ollama ─────────────────────────────────────────────────────
  {
    id: "qwen3:latest",
    provider: "ollama",
    displayName: "Qwen 3 (8B) — local",
    size: "~5.2 GB",
    russian: "excellent",
    approxTokensPerSec: 35,
    recommendation:
      "Default for production sales — best Russian fluency, picks up few-shot register cleanly.",
  },
  {
    id: "qwen3:14b",
    provider: "ollama",
    displayName: "Qwen 3 (14B) — local",
    size: "~9 GB",
    russian: "excellent",
    approxTokensPerSec: 18,
    recommendation: "When 8B is producing inconsistent style and you can spare the memory.",
  },
  {
    id: "qwen2.5:7b",
    provider: "ollama",
    displayName: "Qwen 2.5 (7B) — local",
    size: "~4.7 GB",
    russian: "good",
    approxTokensPerSec: 38,
    recommendation: "Solid fallback if Qwen 3 misbehaves on your stack; no thinking-mode quirks.",
  },
  {
    id: "llama3.2:latest",
    provider: "ollama",
    displayName: "Llama 3.2 (3B) — local",
    size: "~2.0 GB",
    russian: "decent",
    approxTokensPerSec: 60,
    recommendation:
      "Fast iteration and CPU-only setups. Russian is OK, occasionally drops English words.",
  },
  {
    id: "gemma2:9b",
    provider: "ollama",
    displayName: "Gemma 2 (9B) — local",
    size: "~5.5 GB",
    russian: "good",
    approxTokensPerSec: 28,
    recommendation: "Alternative voice when you want to A/B-test backbones with the same persona.",
  },
  {
    id: "moondream:v2",
    provider: "ollama",
    displayName: "Moondream v2 (1B) — local",
    size: "~1.7 GB",
    russian: "weak",
    approxTokensPerSec: 80,
    recommendation:
      "Smoke testing only — too small for real sales replies. Useful when you just need ANY response fast.",
  },

  // ─── Ollama Cloud ─────────────────────────────────────────────────────
  {
    id: "qwen3.5:cloud",
    provider: "ollama-cloud",
    displayName: "Qwen 3.5 — Ollama Cloud",
    size: "hosted",
    russian: "excellent",
    approxTokensPerSec: 90,
    recommendation:
      "Premium pick — sub-second replies even with our 700-token system prompt; great Russian.",
  },
  {
    id: "glm-4.6:cloud",
    provider: "ollama-cloud",
    displayName: "GLM 4.6 — Ollama Cloud",
    size: "hosted",
    russian: "good",
    approxTokensPerSec: 70,
    recommendation: "Good cheaper alternative on Ollama Cloud when Qwen 3.5 is overkill.",
  },

  // ─── OpenRouter (future — provider not yet wired into tg-chatbot) ─────
  {
    id: "anthropic/claude-haiku-4.5",
    provider: "openrouter",
    displayName: "Claude Haiku 4.5 — OpenRouter",
    size: "hosted",
    russian: "excellent",
    approxTokensPerSec: 120,
    recommendation:
      "Cheap, fast, and very natural Russian. Good default for OpenRouter-based deploys.",
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    provider: "openrouter",
    displayName: "Claude Sonnet 4.6 — OpenRouter",
    size: "hosted",
    russian: "excellent",
    approxTokensPerSec: 80,
    recommendation: "Best style adherence and few-shot pickup of any model tested. Premium tier.",
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "openrouter",
    displayName: "GPT-4o-mini — OpenRouter",
    size: "hosted",
    russian: "good",
    approxTokensPerSec: 100,
    recommendation: "Fast and cheap. Russian is fine but stylistically blander than Claude/Qwen.",
  },
  {
    id: "google/gemini-2.5-flash",
    provider: "openrouter",
    displayName: "Gemini 2.5 Flash — OpenRouter",
    size: "hosted",
    russian: "good",
    approxTokensPerSec: 110,
    recommendation: "Cheapest of the frontier-class. Good for high-volume cold outreach.",
  },
];

export function getModelInfo(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function listModels(): readonly ModelInfo[] {
  return MODELS;
}

export function listModelsByProvider(provider: ModelInfo["provider"]): readonly ModelInfo[] {
  return MODELS.filter((m) => m.provider === provider);
}

export const DEFAULT_MODEL_ID = MODELS[0]?.id ?? "qwen3:latest";
