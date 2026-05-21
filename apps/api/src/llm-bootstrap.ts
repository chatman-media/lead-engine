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
  type LlmProviderConfig as RouterCfg,
} from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";
import { LlmStageClassifier, RegexStageClassifier } from "@chatman-media/sales";
import { RECRUITMENT_UAE_V1 } from "@chatman-media/vertical-recruitment-uae";
import type { ApiConfig } from "./config.ts";
import { wrapChatClient, wrapEmbeddingClient } from "./lib/llm-metrics-wrapper.ts";
import {
  getConfig,
  type LoadedLlmConfigs,
  type ResolvedLlmConfig,
} from "./lib/llm-config-loader.ts";

/**
 * Bootstrap LlmRouter + ReplyStrategy. Per-tenant configs приходят из
 * `LoadedLlmConfigs` (DB → env fallback, см. llm-config-loader).
 *
 * Hot-reload: фабрики принимают НЕ static snapshot, а `LoadedRef`
 * (mutable wrapper). После PUT/DELETE через admin-API tenant-reloader
 * мутирует .current, и provider-label в metrics обновляется
 * автоматически (closures lazy-читают .current на каждом resolveChat).
 * Сам router updates через router.invalidate + setConfig в reloader.
 *
 * Выбор стратегии:
 *   - any tenant имеет chat + embed → RagReplyStrategy
 *   - any tenant имеет только chat → LlmReplyStrategy
 *   - никто не имеет chat → null (бот persist'ит и молчит)
 */

export interface LoadedRef {
  current: LoadedLlmConfigs;
  /**
   * Shared router instance. Lives across reloads — invalidate(tenantId)
   * сбрасывает cache, setConfig инжектит новые. Один router на process.
   */
  router: InMemoryLlmRouter;
}

function toRouterConfig(
  tenantId: number,
  purpose: "chat" | "embed" | "vision" | "judge",
  cfg: ResolvedLlmConfig,
): RouterCfg {
  // RouterCfg union'нится по provider; cast'им через any к одному shape'у.
  return {
    tenantId,
    purpose,
    provider: cfg.provider as RouterCfg["provider"],
    model: cfg.model,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.embedDim !== undefined ? { embedDim: cfg.embedDim } : {}),
    ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: union of provider-specific shapes
  } as any;
}

/**
 * Опциональный memory extractor. Использует тот же chat-config что и
 * reply-strategy. apps/api прокидывает его в webhook-route → ProcessInboundDeps.
 */
export function makeMemoryExtractor(
  ref: LoadedRef,
  db: Db,
  metrics?: PlatformMetrics,
): MemoryExtractor | null {
  if (!ref.current.anyTenantHasChat) return null;
  // Регистрируем initial configs. После hot-reload tenant-reloader сам
  // setConfig'нет на router — фабрика об этом не знает.
  for (const [tenantId, perPurpose] of ref.current.byTenant) {
    const chat = perPurpose.get("chat");
    if (chat) ref.router.setConfig(toRouterConfig(tenantId, "chat", chat));
  }
  return new LlmMemoryExtractor(
    {
      resolveChat: (tenantId: number) => {
        const inner = ref.router.resolveChat(tenantId, "chat");
        if (!metrics) return inner;
        const cfg = getConfig(ref.current, tenantId, "chat");
        return wrapChatClient(inner, metrics, {
          provider: cfg?.provider ?? "unknown",
          purpose: "memory",
        });
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
  ref: LoadedRef,
  cfg: ApiConfig,
  db: Db,
  metrics?: PlatformMetrics,
): StageClassifier | null {
  void db; // db не нужен classifier'у; pipeline передаёт deps.db в applyClassifiedStage.
  if (cfg.stageClassifier === "regex") {
    return new RegexStageClassifier();
  }
  if (cfg.stageClassifier === "llm") {
    if (!ref.current.anyTenantHasChat) {
      console.warn(
        "[apps/api] STAGE_CLASSIFIER=llm requested but no tenant has chat LLM configured — disabling",
      );
      return null;
    }
    for (const [tenantId, perPurpose] of ref.current.byTenant) {
      const chat = perPurpose.get("chat");
      if (chat) ref.router.setConfig(toRouterConfig(tenantId, "chat", chat));
    }
    return new LlmStageClassifier({
      resolveChat: (tenantId: number) => {
        const inner = ref.router.resolveChat(tenantId, "chat");
        if (!metrics) return inner;
        const chatCfg = getConfig(ref.current, tenantId, "chat");
        return wrapChatClient(inner, metrics, {
          provider: chatCfg?.provider ?? "unknown",
          purpose: "stage",
        });
      },
    });
  }
  return null;
}

export function makeReplyStrategy(
  ref: LoadedRef,
  cfg: ApiConfig,
  db: Db,
  metrics?: PlatformMetrics,
): ReplyStrategy | null {
  if (!ref.current.anyTenantHasChat) return null;

  for (const [tenantId, perPurpose] of ref.current.byTenant) {
    const chat = perPurpose.get("chat");
    if (chat) ref.router.setConfig(toRouterConfig(tenantId, "chat", chat));
    const embed = perPurpose.get("embed");
    if (embed) ref.router.setConfig(toRouterConfig(tenantId, "embed", embed));
  }

  const template = RECRUITMENT_UAE_V1;

  // Если ни один tenant не имеет embed config'а — fall back на LlmReplyStrategy.
  // NB: проверка против initial snapshot'а; если tenant позже добавит embed,
  // reloader setConfig'нет на router, но strategy уже LlmReplyStrategy. После
  // hot-reload с появлением embed — restart нужен. (Acceptable trade-off:
  // chat/embed добавление редкое, токены/каналы — частое.)
  if (!ref.current.anyTenantHasEmbed) {
    return new LlmReplyStrategy(
      {
        template,
        resolveChat: (tenantId: number) => ref.router.resolveChat(tenantId, "chat"),
      },
      (tenantId: number) => new MessagesRepo({ db, tenantId }),
    );
  }

  // resolveStyle: priority chain (см. предыдущую версию для деталей).
  const styleCache = new Map<number, Style | null>();
  const experimentCache = new Map<number, ABRouter | "absent">();
  const defaultSlug = cfg.defaultStyleSlug;
  const experimentSlug = cfg.experimentSlug;

  const resolveStyle =
    experimentSlug || defaultSlug
      ? async (input: { tenantId: number; contactId: number }): Promise<Style | null> => {
          if (experimentSlug) {
            let abRouter = experimentCache.get(input.tenantId);
            if (abRouter === undefined) {
              const expRepo = new ExperimentsRepo({ db, tenantId: input.tenantId });
              const stylesRepo = new StylesRepo({ db, tenantId: input.tenantId });
              const exp = await expRepo.findRunningBySlug(experimentSlug);
              if (exp) {
                const variants = await loadExperimentVariants(exp, stylesRepo);
                if (variants) {
                  abRouter = new ABRouter({ variants, salt: exp.slug });
                  experimentCache.set(input.tenantId, abRouter);
                } else {
                  experimentCache.set(input.tenantId, "absent");
                  abRouter = "absent";
                }
              } else {
                experimentCache.set(input.tenantId, "absent");
                abRouter = "absent";
              }
            }
            if (abRouter !== "absent") {
              return abRouter.assign(String(input.contactId)).style;
            }
          }
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

  return new RagReplyStrategy(
    {
      template,
      resolveChat: (tenantId: number) => {
        const inner = ref.router.resolveChat(tenantId, "chat");
        if (!metrics) return inner;
        const chatCfg = getConfig(ref.current, tenantId, "chat");
        return wrapChatClient(inner, metrics, {
          provider: chatCfg?.provider ?? "unknown",
          purpose: "chat",
        });
      },
      resolveEmbed: (tenantId: number) => {
        const inner = ref.router.resolveEmbed(tenantId);
        if (!metrics) return inner as unknown as RagEmbeddingClient;
        const embedCfg = getConfig(ref.current, tenantId, "embed");
        const wrapped = wrapEmbeddingClient(inner, metrics, {
          provider: embedCfg?.provider ?? "unknown",
          purpose: "embed",
        });
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
 * per tenant. Возвращает null если ни один tenant не имеет embed config'а.
 */
export function makeEmbedderResolver(
  ref: LoadedRef,
): ((tenantId: number) => import("@chatman-media/llm-router").EmbeddingClient) | null {
  if (!ref.current.anyTenantHasEmbed) return null;
  for (const [tenantId, perPurpose] of ref.current.byTenant) {
    const embed = perPurpose.get("embed");
    if (embed) ref.router.setConfig(toRouterConfig(tenantId, "embed", embed));
  }
  return (tenantId: number) => ref.router.resolveEmbed(tenantId);
}
