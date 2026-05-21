import {
  type Db,
  DrizzleKbStore,
  ExperimentsRepo,
  LlmMemoryExtractor,
  LlmReplyStrategy,
  loadExperimentVariants,
  type MemoryExtractor,
  MessagesRepo,
  parseStyleConfig,
  RagReplyStrategy,
  type ReplyStrategy,
  type StageClassifier,
  StylesRepo,
} from "@chatman-media/conversation-engine";
import { ABRouter, type Style } from "@chatman-media/kb";
import {
  type EmbeddingClient as RagEmbeddingClient,
  InMemoryLlmRouter,
} from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";
import { LlmStageClassifier, RegexStageClassifier } from "@chatman-media/sales";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import type { ApiConfig } from "./config.ts";
import { wrapChatClient, wrapEmbeddingClient } from "./lib/llm-metrics-wrapper.ts";

/**
 * Bootstrap LlmRouter + ReplyStrategy. На текущем этапе single-tenant
 * shim через env-vars (legacy tenant_id=1). После Этапа 8 router'у
 * хочется читать llm_provider_configs из БД per tenant.
 *
 * Выбор стратегии:
 *   - Если задан и chat-config, и embed-config → RagReplyStrategy
 *     (KB-aware ответы через @chatman-media/kb.answerWithRag).
 *   - Если только chat-config → LlmReplyStrategy (история + system prompt,
 *     без KB).
 *   - Если chat не задан → null (бот persist'ит и молчит).
 */
/**
 * Опциональный memory extractor. Использует тот же chat-config что и
 * reply-strategy. apps/api прокидывает его в webhook-route → ProcessInboundDeps.
 */
export function makeMemoryExtractor(
  cfg: ApiConfig,
  db: Db,
  metrics?: PlatformMetrics,
  /** Active tenant IDs — register chat config per-tenant. Default [1] (legacy). */
  tenantIds: readonly number[] = [1],
): MemoryExtractor | null {
  // Ollama не требует apiKey (локальный сервер без auth). Для openai/openrouter —
  // apiKey обязателен (см. buildChat в InMemoryLlmRouter).
  if (!cfg.llm.provider || !cfg.llm.model) return null;
  if (cfg.llm.provider !== "ollama" && !cfg.llm.apiKey) return null;
  const router = new InMemoryLlmRouter();
  for (const tenantId of tenantIds) {
    router.setConfig({
      tenantId,
      purpose: "chat",
      provider: cfg.llm.provider,
      model: cfg.llm.model,
      apiKey: cfg.llm.apiKey,
      ...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}),
    });
  }
  return new LlmMemoryExtractor(
    {
      resolveChat: (tenantId: number) => {
        const inner = router.resolveChat(tenantId, "chat");
        return metrics
          ? wrapChatClient(inner, metrics, { provider: cfg.llm.provider, purpose: "memory" })
          : inner;
      },
    },
    (tenantId: number) => new MessagesRepo({ db, tenantId }),
  );
}

/**
 * Опциональный stage classifier. На "regex" — pure CPU без LLM cost.
 * На "llm" — требует chat-config (тот же что reply-strategy). На пустом —
 * null (current_stage не пишется).
 */
export function makeStageClassifier(
  cfg: ApiConfig,
  db: Db,
  metrics?: PlatformMetrics,
  /** Active tenant IDs — register chat config per-tenant. Default [1] (legacy). */
  tenantIds: readonly number[] = [1],
): StageClassifier | null {
  void db; // db не нужен classifier'у; pipeline передаёт deps.db в applyClassifiedStage.
  if (cfg.stageClassifier === "regex") {
    return new RegexStageClassifier();
  }
  if (cfg.stageClassifier === "llm") {
    if (!cfg.llm.provider || !cfg.llm.apiKey || !cfg.llm.model) {
      console.warn(
        "[apps/api] STAGE_CLASSIFIER=llm requested but chat LLM not configured — disabling",
      );
      return null;
    }
    const router = new InMemoryLlmRouter();
    for (const tenantId of tenantIds) {
      router.setConfig({
        tenantId,
        purpose: "chat",
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        apiKey: cfg.llm.apiKey,
        ...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}),
      });
    }
    return new LlmStageClassifier({
      resolveChat: (tenantId: number) => {
        const inner = router.resolveChat(tenantId, "chat");
        return metrics
          ? wrapChatClient(inner, metrics, { provider: cfg.llm.provider, purpose: "stage" })
          : inner;
      },
    });
  }
  return null;
}

export function makeReplyStrategy(
  cfg: ApiConfig,
  db: Db,
  metrics?: PlatformMetrics,
  /** Active tenant IDs — register chat config per-tenant. Default [1] (legacy). */
  tenantIds: readonly number[] = [1],
): ReplyStrategy | null {
  // Ollama не требует apiKey (локальный сервер без auth). Для openai/openrouter —
  // apiKey обязателен (см. buildChat в InMemoryLlmRouter).
  if (!cfg.llm.provider || !cfg.llm.model) return null;
  if (cfg.llm.provider !== "ollama" && !cfg.llm.apiKey) return null;
  const chatProvider = cfg.llm.provider;
  const router = new InMemoryLlmRouter();
  for (const tenantId of tenantIds) {
    router.setConfig({
      tenantId,
      purpose: "chat",
      provider: chatProvider,
      model: cfg.llm.model,
      apiKey: cfg.llm.apiKey,
      ...(cfg.llm.baseUrl ? { baseUrl: cfg.llm.baseUrl } : {}),
    });
  }

  const template = RECRUITMENT_UAE_V1;

  const embedProvider = cfg.embed.provider;
  // Аналогично chat: Ollama embed без apiKey работает.
  const embedNeedsApiKey = embedProvider && embedProvider !== "ollama";
  if (!embedProvider || (embedNeedsApiKey && !cfg.embed.apiKey) || !cfg.embed.model) {
    return new LlmReplyStrategy(
      {
        template,
        resolveChat: (tenantId: number) => router.resolveChat(tenantId, "chat"),
      },
      (tenantId: number) => new MessagesRepo({ db, tenantId }),
    );
  }

  for (const tenantId of tenantIds) {
    router.setConfig({
      tenantId,
      purpose: "embed",
      provider: embedProvider,
      model: cfg.embed.model,
      apiKey: cfg.embed.apiKey,
      embedDim: cfg.embed.dim,
      ...(cfg.embed.baseUrl ? { baseUrl: cfg.embed.baseUrl } : {}),
    });
  }

  // resolveStyle: priority chain
  //   1. EXPERIMENT_SLUG задан → ABRouter поверх variants из experiments.
  //      allocation_json. Deterministic by hash(contactId+experiment.slug) —
  //      один контакт всегда получает тот же variant.
  //   2. STYLE_SLUG задан → load active style → передать as-is.
  //   3. Иначе → undefined, RagReplyStrategy fall back'нет на DEFAULT_PERSONA.
  //
  // Кеширование: experiment variants и default style загружаются один раз
  // на первый запрос per tenant, дальше держатся в памяти. Operator-правки
  // (паузу эксперимента, swap style) требуют рестарта apps/api.
  const styleCache = new Map<number, Style | null>();
  const experimentCache = new Map<number, ABRouter | "absent">();
  const defaultSlug = cfg.defaultStyleSlug;
  const experimentSlug = cfg.experimentSlug;

  const resolveStyle =
    experimentSlug || defaultSlug
      ? async (input: { tenantId: number; contactId: number }): Promise<Style | null> => {
          // (1) experiment first
          if (experimentSlug) {
            let router = experimentCache.get(input.tenantId);
            if (router === undefined) {
              const expRepo = new ExperimentsRepo({ db, tenantId: input.tenantId });
              const stylesRepo = new StylesRepo({ db, tenantId: input.tenantId });
              const exp = await expRepo.findRunningBySlug(experimentSlug);
              if (exp) {
                const variants = await loadExperimentVariants(exp, stylesRepo);
                if (variants) {
                  router = new ABRouter({ variants, salt: exp.slug });
                  experimentCache.set(input.tenantId, router);
                } else {
                  experimentCache.set(input.tenantId, "absent");
                  router = "absent";
                }
              } else {
                experimentCache.set(input.tenantId, "absent");
                router = "absent";
              }
            }
            if (router !== "absent") {
              return router.assign(String(input.contactId)).style;
            }
          }
          // (2) default-style fallback
          if (defaultSlug) {
            const cached = styleCache.get(input.tenantId);
            if (cached !== undefined) return cached;
            const repo = new StylesRepo({ db, tenantId: input.tenantId });
            const row = await repo.findActiveBySlug(defaultSlug);
            const parsed = row ? parseStyleConfig(row.configJson) : null;
            styleCache.set(input.tenantId, parsed);
            return parsed;
          }
          return null;
        }
      : undefined;

  const chatProviderLabel = cfg.llm.provider;
  const embedProviderLabel = embedProvider;

  return new RagReplyStrategy(
    {
      template,
      resolveChat: (tenantId: number) => {
        const inner = router.resolveChat(tenantId, "chat");
        return metrics
          ? wrapChatClient(inner, metrics, { provider: chatProviderLabel, purpose: "chat" })
          : inner;
      },
      // llm-router'овский EmbeddingClient structurally compatible с
      // rag's EmbeddingClient (embed(inputs)→number[][] + dim).
      resolveEmbed: (tenantId: number) => {
        const inner = router.resolveEmbed(tenantId);
        const wrapped = metrics
          ? wrapEmbeddingClient(inner, metrics, {
              provider: embedProviderLabel,
              purpose: "embed",
            })
          : inner;
        return wrapped as unknown as RagEmbeddingClient;
      },
      resolveKb: (tenantId: number) => new DrizzleKbStore({ db, tenantId }),
      ...(resolveStyle ? { resolveStyle } : {}),
    },
    (tenantId: number) => new MessagesRepo({ db, tenantId }),
  );
}

/**
 * Standalone embedder resolver — для admin-API endpoints'ов (KB upload),
 * которые не используют RagReplyStrategy но нуждаются в `EmbeddingClient`
 * per tenant. Возвращает null если embed-config не задан в env.
 *
 * Symmetric с makeReplyStrategy в плане tenant-config registration: loops
 * через active tenant IDs.
 */
export function makeEmbedderResolver(
  cfg: ApiConfig,
  tenantIds: readonly number[] = [1],
): ((tenantId: number) => import("@chatman-media/llm-router").EmbeddingClient) | null {
  const provider = cfg.embed.provider;
  if (!provider || !cfg.embed.model) return null;
  if (provider !== "ollama" && !cfg.embed.apiKey) return null;
  const router = new InMemoryLlmRouter();
  for (const tenantId of tenantIds) {
    router.setConfig({
      tenantId,
      purpose: "embed",
      provider,
      model: cfg.embed.model,
      apiKey: cfg.embed.apiKey,
      embedDim: cfg.embed.dim,
      ...(cfg.embed.baseUrl ? { baseUrl: cfg.embed.baseUrl } : {}),
    });
  }
  return (tenantId: number) => router.resolveEmbed(tenantId);
}
