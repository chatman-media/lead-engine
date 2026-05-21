import { OllamaChatClient } from "./providers/ollama-chat.ts";
import { OllamaEmbeddingClient } from "./providers/ollama-embed.ts";
import { OpenAIChatClient } from "./providers/openai-chat.ts";
import { OpenAIEmbeddingClient } from "./providers/openai-embed.ts";
import { OpenRouterChatClient } from "./providers/openrouter-chat.ts";
import type { ChatClient, EmbeddingClient } from "./types.ts";

/**
 * Цель LLM-вызова. Один tenant может держать разные модели под разные purpose'ы
 * (например, GPT-4 для chat, Gemini Flash для vision, локальный Ollama для
 * embed). Каждая purpose резолвится независимо.
 */
export type LlmPurpose = "chat" | "embed" | "vision" | "judge";

export type LlmProvider = "openai" | "openrouter" | "ollama";

/**
 * Конфиг одного (tenantId, purpose). В этап 6 будет читаться из таблицы
 * llm_provider_configs (по плану re-design). Сейчас инжектится in-memory.
 *
 * `apiKey` отсутствует для Ollama (локальный сервер без auth) и для
 * platform-managed BYOK-режима если ключ берётся из platform-secret store.
 */
export interface LlmProviderConfig {
  tenantId: number;
  purpose: LlmPurpose;
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Только для purpose='embed': размерность вектора (должна совпадать с DB). */
  embedDim?: number;
  /** Per-request timeout, ms. По умолчанию 60_000. */
  timeoutMs?: number;
}

const keyFor = (tenantId: number, purpose: LlmPurpose): string => `${tenantId}:${purpose}`;

/**
 * In-memory router: маршрутизирует (tenantId, purpose) на конкретного клиента.
 * Конфиги кладутся через `setConfig()` — в worker'е это произойдёт при boot
 * для всех активных tenants, либо лениво при первом запросе.
 *
 * Resolver'ы кэшируют построенный клиент в Map, поэтому повторный resolveChat()
 * не пересоздаёт HTTP-обёртку и не теряет timeout state. Если конфиг tenant'а
 * меняется (UI оператора), нужно явно сбросить через `invalidate(tenantId)`.
 */
export class InMemoryLlmRouter {
  private readonly configs = new Map<string, LlmProviderConfig>();
  private readonly chatCache = new Map<string, ChatClient>();
  private readonly embedCache = new Map<string, EmbeddingClient>();

  setConfig(cfg: LlmProviderConfig): void {
    const key = keyFor(cfg.tenantId, cfg.purpose);
    this.configs.set(key, cfg);
    // Сбрасываем кэшированные клиенты — следующий resolve пересоберёт.
    this.chatCache.delete(key);
    this.embedCache.delete(key);
  }

  /** Сбросить все клиенты tenant'а — после изменения tenant_secrets/llm_provider_configs. */
  invalidate(tenantId: number): void {
    for (const key of [...this.configs.keys()]) {
      if (key.startsWith(`${tenantId}:`)) {
        this.chatCache.delete(key);
        this.embedCache.delete(key);
      }
    }
  }

  resolveChat(
    tenantId: number,
    purpose: "chat" | "vision" | "judge" = "chat",
  ): ChatClient {
    const key = keyFor(tenantId, purpose);
    const cached = this.chatCache.get(key);
    if (cached) return cached;

    const cfg = this.configs.get(key);
    if (!cfg) {
      throw new Error(`LLM config not set: tenantId=${tenantId} purpose=${purpose}`);
    }
    const client = this.buildChat(cfg);
    this.chatCache.set(key, client);
    return client;
  }

  resolveEmbed(tenantId: number): EmbeddingClient {
    const key = keyFor(tenantId, "embed");
    const cached = this.embedCache.get(key);
    if (cached) return cached;

    const cfg = this.configs.get(key);
    if (!cfg) {
      throw new Error(`LLM config not set: tenantId=${tenantId} purpose=embed`);
    }
    if (cfg.purpose !== "embed") {
      throw new Error(`LLM config for tenantId=${tenantId} purpose=embed has wrong purpose`);
    }
    const client = this.buildEmbed(cfg);
    this.embedCache.set(key, client);
    return client;
  }

  /** Список tenant'ов с уже сохранённым конфигом — для admin-инспекции. */
  knownTenants(): number[] {
    const seen = new Set<number>();
    for (const cfg of this.configs.values()) seen.add(cfg.tenantId);
    return [...seen].sort((a, b) => a - b);
  }

  private buildChat(cfg: LlmProviderConfig): ChatClient {
    switch (cfg.provider) {
      case "openai": {
        if (!cfg.apiKey) throw new Error("openai provider requires apiKey");
        return new OpenAIChatClient({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
          model: cfg.model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        });
      }
      case "openrouter": {
        if (!cfg.apiKey) throw new Error("openrouter provider requires apiKey");
        return new OpenRouterChatClient({
          apiKey: cfg.apiKey,
          model: cfg.model,
          ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        });
      }
      case "ollama": {
        return new OllamaChatClient({
          host: cfg.baseUrl ?? "http://localhost:11434",
          model: cfg.model,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        });
      }
    }
  }

  private buildEmbed(cfg: LlmProviderConfig): EmbeddingClient {
    if (cfg.embedDim === undefined) {
      throw new Error(`embed config requires embedDim (tenant=${cfg.tenantId})`);
    }
    switch (cfg.provider) {
      case "openai":
      case "openrouter": {
        // OpenRouter не даёт embeddings — используем тот же OpenAI-совместимый
        // клиент (apiKey + baseUrl от tenant'а). Если кому-то нужен Voyage —
        // расширим в отдельном провайдере.
        if (!cfg.apiKey) throw new Error(`${cfg.provider} embed requires apiKey`);
        return new OpenAIEmbeddingClient({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
          model: cfg.model,
          dim: cfg.embedDim,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        });
      }
      case "ollama": {
        return new OllamaEmbeddingClient({
          host: cfg.baseUrl ?? "http://localhost:11434",
          model: cfg.model,
          dim: cfg.embedDim,
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        });
      }
    }
  }
}
