import {
  type Db,
  DrizzleKbStore,
  ExperimentsRepo,
  getDecryptedSecret,
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
import { ABRouter, type AnyRagTool, type DirectorHookForPrompt, makeBookingLinkTool, type SkillForPrompt, type Style } from "@chatman-media/kb";
import {
  type EmbeddingClient as RagEmbeddingClient,
  InMemoryLlmRouter,
  type LlmProviderConfig as RouterCfg,
} from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";
import { LlmStageClassifier, RegexStageClassifier } from "@chatman-media/sales";
import { directorHooks, leads, skills, stageDefinitions } from "@chatman-media/storage";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { RECRUITMENT_V1 } from "@chatman-media/vertical-recruitment";
import type { ApiConfig } from "./config.ts";
import { type OnUsage, wrapChatClient, wrapEmbeddingClient } from "./lib/llm-metrics-wrapper.ts";

/**
 * Опциональный hook: фабрики передают каждому wrapped client'у callback
 * который фиксирует usage event per-call. apps/api на boot wire'ит его к
 * LlmUsageWriter'у — events batch'аются в DB для billing dashboard'а.
 * `tenantId` приходит из `resolveChat(tid)` контекста.
 */
export type RecordUsage = (tenantId: number, event: Parameters<OnUsage>[0]) => void;
import {
  getConfig,
  type LoadedLlmConfigs,
  type ResolvedLlmConfig,
} from "./lib/llm-config-loader.ts";
import { WhisperTranscriber } from "./lib/whisper-transcriber.ts";

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
  recordUsage?: RecordUsage,
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
        return wrapChatClient(
          inner,
          metrics,
          {
            provider: cfg?.provider ?? "unknown",
            purpose: "memory",
            ...(cfg?.model ? { model: cfg.model } : {}),
          },
          recordUsage ? (ev) => recordUsage(tenantId, ev) : undefined,
        );
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
  recordUsage?: RecordUsage,
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
        return wrapChatClient(
          inner,
          metrics,
          {
            provider: chatCfg?.provider ?? "unknown",
            purpose: "stage",
            ...(chatCfg?.model ? { model: chatCfg.model } : {}),
          },
          recordUsage ? (ev) => recordUsage(tenantId, ev) : undefined,
        );
      },
    });
  }
  return null;
}

function makeSupportModeResolver(db: Db) {
  return async (input: { tenantId: number; contactId: number }): Promise<boolean> => {
    const rows = await db
      .select({ supportMode: stageDefinitions.supportMode })
      .from(leads)
      .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
      .where(
        and(
          eq(leads.tenantId, input.tenantId),
          eq(leads.userId, input.contactId),
          isNotNull(leads.stageDefinitionId),
        ),
      )
      .limit(1);
    return rows[0]?.supportMode === true;
  };
}

export interface ReplyStrategyBundle {
  strategy: ReplyStrategy;
  /**
   * Invalidate the per-tenant tools cache for a specific tenant.
   * Call this after the tenant updates their tool configuration (booking URL, etc.)
   * so the next incoming message picks up the new config without a restart.
   */
  invalidateToolsFor: (tenantId: number) => void;
}

export function makeReplyStrategy(
  ref: LoadedRef,
  cfg: ApiConfig,
  db: Db,
  metrics?: PlatformMetrics,
  recordUsage?: RecordUsage,
): ReplyStrategyBundle | null {
  if (!ref.current.anyTenantHasChat) return null;

  for (const [tenantId, perPurpose] of ref.current.byTenant) {
    const chat = perPurpose.get("chat");
    if (chat) ref.router.setConfig(toRouterConfig(tenantId, "chat", chat));
    const embed = perPurpose.get("embed");
    if (embed) ref.router.setConfig(toRouterConfig(tenantId, "embed", embed));
  }

  const template = RECRUITMENT_V1;

  // Если ни один tenant не имеет embed config'а — fall back на LlmReplyStrategy.
  // NB: проверка против initial snapshot'а; если tenant позже добавит embed,
  // reloader setConfig'нет на router, но strategy уже LlmReplyStrategy. После
  // hot-reload с появлением embed — restart нужен. (Acceptable trade-off:
  // chat/embed добавление редкое, токены/каналы — частое.)
  if (!ref.current.anyTenantHasEmbed) {
    return {
      strategy: new LlmReplyStrategy(
        {
          template,
          resolveChat: (tenantId: number) => ref.router.resolveChat(tenantId, "chat"),
          resolveIsSupport: makeSupportModeResolver(db),
        },
        (tenantId: number) => new MessagesRepo({ db, tenantId }),
      ),
      invalidateToolsFor: () => {}, // LlmReplyStrategy has no tools cache
    };
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

  // resolveSkills: loads all enabled skills for the tenant.
  // Stage-kind filtering (intake/active/always) happens inside composeSystemPrompt.
  // Results are cached per-tenant (skills rarely change at runtime; restart invalidates).
  const skillsCache = new Map<number, readonly SkillForPrompt[]>();
  async function resolveSkills(input: { tenantId: number }): Promise<readonly SkillForPrompt[]> {
    const cached = skillsCache.get(input.tenantId);
    if (cached !== undefined) return cached;
    const rows = await db
      .select({
        slug: skills.slug,
        displayName: skills.displayName,
        promptFragment: skills.promptFragment,
        applicableStagesJson: skills.applicableStagesJson,
      })
      .from(skills)
      .where(and(eq(skills.tenantId, input.tenantId), eq(skills.isEnabled, true)))
      .orderBy(asc(skills.family), asc(skills.displayName));
    const result: SkillForPrompt[] = rows.map((r) => ({
      slug: r.slug,
      displayName: r.displayName,
      promptFragment: r.promptFragment,
      // applicableStagesJson is a JSON array of FunnelStage strings (or empty = always).
      applicableStages: (() => {
        try {
          return JSON.parse(r.applicableStagesJson) as string[];
        } catch {
          return [];
        }
      })() as readonly string[],
    }));
    skillsCache.set(input.tenantId, result);
    return result;
  }

  // resolveDirectorHooks: loads active director hooks for the tenant.
  // No server-side cache — hooks can change at any time from the UI.
  // Each reply triggers one fast indexed query (idx_director_hooks_active).
  async function resolveDirectorHooks(input: {
    tenantId: number;
  }): Promise<readonly DirectorHookForPrompt[]> {
    const rows = await db
      .select({
        name: directorHooks.name,
        body: directorHooks.body,
        triggerHint: directorHooks.triggerHint,
      })
      .from(directorHooks)
      .where(and(eq(directorHooks.tenantId, input.tenantId), eq(directorHooks.isActive, true)))
      .orderBy(asc(directorHooks.position), asc(directorHooks.id));
    return rows;
  }

  // resolveTools: builds the list of agentic tools enabled for the tenant.
  // Results are cached per-tenant and invalidated via toolsCache.delete(tenantId)
  // when the admin UI updates tool config (onReload hook in admin-tools route).
  const toolsCache = new Map<number, AnyRagTool[]>();
  async function resolveTools(input: {
    tenantId: number;
    conversationId: number;
  }): Promise<AnyRagTool[]> {
    const cached = toolsCache.get(input.tenantId);
    if (cached !== undefined) return cached;

    const bookingUrl = await getDecryptedSecret({
      db,
      tenantId: input.tenantId,
      key: "tool_booking_url",
      masterKeyHex: cfg.masterKeyHex,
    });

    const tools: AnyRagTool[] = [];
    if (bookingUrl) tools.push(makeBookingLinkTool(bookingUrl));

    toolsCache.set(input.tenantId, tools);
    return tools;
  }

  const strategy = new RagReplyStrategy(
    {
      template,
      resolveChat: (tenantId: number) => {
        const inner = ref.router.resolveChat(tenantId, "chat");
        if (!metrics) return inner;
        const chatCfg = getConfig(ref.current, tenantId, "chat");
        return wrapChatClient(
          inner,
          metrics,
          {
            provider: chatCfg?.provider ?? "unknown",
            purpose: "chat",
            ...(chatCfg?.model ? { model: chatCfg.model } : {}),
          },
          recordUsage ? (ev) => recordUsage(tenantId, ev) : undefined,
        );
      },
      resolveEmbed: (tenantId: number) => {
        const inner = ref.router.resolveEmbed(tenantId);
        if (!metrics) return inner as unknown as RagEmbeddingClient;
        const embedCfg = getConfig(ref.current, tenantId, "embed");
        const wrapped = wrapEmbeddingClient(
          inner,
          metrics,
          {
            provider: embedCfg?.provider ?? "unknown",
            purpose: "embed",
            ...(embedCfg?.model ? { model: embedCfg.model } : {}),
          },
          recordUsage ? (ev) => recordUsage(tenantId, ev) : undefined,
        );
        return wrapped as unknown as RagEmbeddingClient;
      },
      resolveKb: (tenantId: number) => new DrizzleKbStore({ db, tenantId }),
      ...(resolveStyle ? { resolveStyle } : {}),
      resolveIsSupport: makeSupportModeResolver(db),
      resolveSkills,
      resolveDirectorHooks,
      resolveTools,
    },
    (tenantId: number) => new MessagesRepo({ db, tenantId }),
  );

  return {
    strategy,
    invalidateToolsFor: (tenantId: number) => toolsCache.delete(tenantId),
  };
}

/**
 * Resolver для STT-транскрибера голосовых сообщений (Whisper).
 * Использует API-ключ chat-конфига тенанта — тот же ключ, что в admin-UI.
 * Работает только для провайдеров с apiKey (openai, openrouter, custom).
 * Возвращает null если ни у одного тенанта нет подходящего ключа.
 */
export function makeTranscriberResolver(
  ref: LoadedRef,
): ((tenantId: number) => WhisperTranscriber | null) | null {
  const hasAnyKey = [...ref.current.byTenant.values()].some((m) => m.get("chat")?.apiKey);
  if (!hasAnyKey) return null;
  return (tenantId: number) => {
    const cfg = getConfig(ref.current, tenantId, "chat");
    if (!cfg?.apiKey) return null;
    return new WhisperTranscriber({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    });
  };
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
