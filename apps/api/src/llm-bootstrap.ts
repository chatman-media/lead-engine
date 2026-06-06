import {
	type Db,
	DrizzleKbStore,
	ExperimentsRepo,
	getDecryptedSecret,
	type ITranscriber,
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
import {
	ABRouter,
	type AnyRagTool,
	CohereReranker,
	type DirectorHookForPrompt,
	JinaReranker,
	makeBookingLinkTool,
	type Reranker,
	type SkillForPrompt,
	type Style,
} from "@chatman-media/kb";
import type {
	ChatClient,
	InMemoryLlmRouter,
	EmbeddingClient as RagEmbeddingClient,
	LlmProviderConfig as RouterCfg,
} from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";
import { LlmStageClassifier, RegexStageClassifier } from "@chatman-media/sales";
import {
	directorHooks,
	leads,
	llmProviderConfigs,
	skills,
	stageDefinitions,
} from "@chatman-media/storage";
import { RECRUITMENT_V1 } from "@chatman-media/vertical-recruitment";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { ApiConfig } from "./config.ts";
import {
	hasActiveExchangeRates,
	makeExchangeTools,
} from "./lib/exchange/tools.ts";
import {
	type OnUsage,
	wrapChatClient,
	wrapEmbeddingClient,
} from "./lib/llm-metrics-wrapper.ts";

/**
 * Опциональный hook: фабрики передают каждому wrapped client'у callback
 * который фиксирует usage event per-call. apps/api на boot wire'ит его к
 * LlmUsageWriter'у — events batch'аются в DB для billing dashboard'а.
 * `tenantId` приходит из `resolveChat(tid)` контекста.
 */
export type RecordUsage = (
	tenantId: number,
	event: Parameters<OnUsage>[0],
) => void;

import {
	getConfig,
	type LoadedLlmConfigs,
	type ResolvedLlmConfig,
} from "./lib/llm-config-loader.ts";
import { makeConciergeRequestsTool, REQUEST_TYPE_LABEL, tenantSupportsMultiRequest } from "./lib/concierge-tools.ts";
import { OpenRouterTranscriber } from "./lib/openrouter-transcriber.ts";
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
 * Резолвер chat-клиента для dev-симулятора диалогов (admin-sim). Использует
 * тот же per-tenant chat-config, что и reply-strategy/memory — это «клиент»,
 * который сам пишет реплики пользователя, имитируя живую переписку из Telegram.
 * Возвращает null если у тенанта не настроен chat LLM.
 */
export function makeSimChatResolver(
	ref: LoadedRef,
): (tenantId: number) => ChatClient | null {
	for (const [tenantId, perPurpose] of ref.current.byTenant) {
		const chat = perPurpose.get("chat");
		if (chat) ref.router.setConfig(toRouterConfig(tenantId, "chat", chat));
	}
	return (tenantId: number): ChatClient | null => {
		const cfg = getConfig(ref.current, tenantId, "chat");
		if (!cfg) return null;
		// setConfig идемпотентен — на случай tenant'а, добавленного после boot.
		ref.router.setConfig(toRouterConfig(tenantId, "chat", cfg));
		return ref.router.resolveChat(tenantId, "chat");
	};
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
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<boolean> => {
		const rows = await db
			.select({ supportMode: stageDefinitions.supportMode })
			.from(leads)
			.leftJoin(
				stageDefinitions,
				eq(leads.stageDefinitionId, stageDefinitions.id),
			)
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

/**
 * Resolves the lead's current funnel-stage goal/guidance (Phase 2 C-2) so the
 * reply prompt can carry per-stage instructions. Mirrors the support-mode query
 * (leads → stage_definitions by leads.stageDefinitionId). null = no instructions.
 */
function makeStageGuidanceResolver(db: Db) {
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<{ goal: string; guidance?: string } | null> => {
		const rows = await db
			.select({
				goal: stageDefinitions.goal,
				guidance: stageDefinitions.guidance,
			})
			.from(leads)
			.leftJoin(
				stageDefinitions,
				eq(leads.stageDefinitionId, stageDefinitions.id),
			)
			.where(
				and(
					eq(leads.tenantId, input.tenantId),
					eq(leads.userId, input.contactId),
					isNotNull(leads.stageDefinitionId),
				),
			)
			.limit(1);
		const goal = rows[0]?.goal;
		if (!goal) return null;
		const guidance = rows[0]?.guidance;
		return guidance ? { goal, guidance } : { goal };
	};
}

/**
 * Resolves dynamic per-request context for the reply prompt (R4): the
 * multi-request guest's current request_type + how many requests are open.
 * Mirrors the stage-guidance query (leads → stage_definitions). null for linear
 * verticals (no request_type) or no open request — no block injected.
 */
export function makeRequestContextResolver(db: Db) {
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<string | null> => {
		const rows = await db
			.select({
				requestType: leads.requestType,
				kind: stageDefinitions.kind,
			})
			.from(leads)
			.leftJoin(
				stageDefinitions,
				eq(leads.stageDefinitionId, stageDefinitions.id),
			)
			.where(
				and(
					eq(leads.tenantId, input.tenantId),
					eq(leads.userId, input.contactId),
				),
			)
			.orderBy(desc(leads.updatedAt));
		const open = rows.filter(
			(r) => r.kind !== "terminal_won" && r.kind !== "terminal_lost",
		);
		const rt = open[0]?.requestType;
		if (!rt) return null; // линейная вертикаль / нет открытых — блок не нужен
		const label = REQUEST_TYPE_LABEL[rt] ?? rt;
		const more =
			open.length > 1
				? ` Всего открытых запросов у гостя: ${open.length} — не путай их детали.`
				: "";
		return `гость сейчас ведёт запрос «${label}».${more}`;
	};
}

/**
 * Resolves whether the guest's current open lead sits on an `awaiting_operator`
 * stage (R5): the bot must hold — defer pricing/decision to a human operator and
 * not invent details. Mirrors makeRequestContextResolver's current-open-lead pick.
 */
export function makeAwaitingOperatorResolver(db: Db) {
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<boolean> => {
		const rows = await db
			.select({
				stageType: stageDefinitions.stageType,
				kind: stageDefinitions.kind,
			})
			.from(leads)
			.leftJoin(
				stageDefinitions,
				eq(leads.stageDefinitionId, stageDefinitions.id),
			)
			.where(
				and(
					eq(leads.tenantId, input.tenantId),
					eq(leads.userId, input.contactId),
				),
			)
			.orderBy(desc(leads.updatedAt));
		const open = rows.filter(
			(r) => r.kind !== "terminal_won" && r.kind !== "terminal_lost",
		);
		return open[0]?.stageType === "awaiting_operator";
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
	/**
	 * Invalidate the per-tenant style cache (+ experiment cache) after the tenant
	 * generates/edits/deletes a style — next reply uses it without a restart.
	 */
	invalidateStyleFor: (tenantId: number) => void;
}

/**
 * Per-tenant style resolution when no A/B experiment applies. Priority:
 *   1. the configured default slug (global `STYLE_SLUG`), if it resolves;
 *   2. fallback — the tenant's most-recently-created active style.
 * Lets an AI-generated (active) style drive the bot per tenant (Phase 2).
 */
export async function resolveTenantStyle(
	repo: Pick<StylesRepo, "findActiveBySlug" | "listActive">,
	defaultSlug: string,
): Promise<Style | null> {
	if (defaultSlug) {
		const row = await repo.findActiveBySlug(defaultSlug);
		const parsed = row ? parseStyleConfig(row.configJson) : null;
		if (parsed) return parsed;
	}
	const actives = await repo.listActive();
	if (actives.length === 0) return null;
	const latest = actives.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
	return parseStyleConfig(latest.configJson);
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
					resolveChat: (tenantId: number) =>
						ref.router.resolveChat(tenantId, "chat"),
					resolveIsSupport: makeSupportModeResolver(db),
				},
				(tenantId: number) => new MessagesRepo({ db, tenantId }),
			),
			invalidateToolsFor: () => {}, // LlmReplyStrategy has no tools cache
			invalidateStyleFor: () => {}, // LlmReplyStrategy resolves no styles
		};
	}

	// resolveStyle: priority chain (см. предыдущую версию для деталей).
	const styleCache = new Map<number, Style | null>();
	const experimentCache = new Map<number, ABRouter | "absent">();
	const defaultSlug = cfg.defaultStyleSlug;
	const experimentSlug = cfg.experimentSlug;

	// Always defined: experiment → global default slug → tenant's active style.
	const resolveStyle = async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<Style | null> => {
		if (experimentSlug) {
			let abRouter = experimentCache.get(input.tenantId);
			if (abRouter === undefined) {
				const expRepo = new ExperimentsRepo({
					db,
					tenantId: input.tenantId,
				});
				const stylesRepo = new StylesRepo({
					db,
					tenantId: input.tenantId,
				});
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
		const cached = styleCache.get(input.tenantId);
		if (cached !== undefined) return cached;
		const repo = new StylesRepo({ db, tenantId: input.tenantId });
		const parsed = await resolveTenantStyle(repo, defaultSlug);
		styleCache.set(input.tenantId, parsed);
		return parsed;
	};

	// resolveSkills: loads all enabled skills for the tenant.
	// Stage-kind filtering (intake/active/always) happens inside composeSystemPrompt.
	// Results are cached per-tenant (skills rarely change at runtime; restart invalidates).
	const skillsCache = new Map<number, readonly SkillForPrompt[]>();
	async function resolveSkills(input: {
		tenantId: number;
	}): Promise<readonly SkillForPrompt[]> {
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
			.where(
				and(eq(skills.tenantId, input.tenantId), eq(skills.isEnabled, true)),
			)
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
			.where(
				and(
					eq(directorHooks.tenantId, input.tenantId),
					eq(directorHooks.isActive, true),
				),
			)
			.orderBy(asc(directorHooks.position), asc(directorHooks.id));
		return rows;
	}

	// resolveTools: builds the list of agentic tools enabled for the tenant.
	//
	// Два класса tools:
	//   - tenant-bound (booking_link): зависят только от tenantId → кешируются.
	//   - conversation-bound (exchange): зависят от conversationId → строятся
	//     СВЕЖИМИ на каждый ответ (нельзя кешировать по тенанту, иначе захватят
	//     первый conversationId). Гейт «включён ли обмен» (наличие активных
	//     курсов) кешируется отдельным boolean.
	// Оба кеша сбрасываются через invalidateToolsFor(tenantId) (admin-tools /
	// admin-exchange onReload).
	const toolsCache = new Map<number, AnyRagTool[]>();
	const exchangeEnabledCache = new Map<number, boolean>();
	const multiRequestToolCache = new Map<number, boolean>();
	async function resolveTools(input: {
		tenantId: number;
		conversationId: number;
	}): Promise<AnyRagTool[]> {
		let base = toolsCache.get(input.tenantId);
		if (base === undefined) {
			const bookingUrl = await getDecryptedSecret({
				db,
				tenantId: input.tenantId,
				key: "tool_booking_url",
				masterKeyHex: cfg.masterKeyHex,
			});
			base = [];
			if (bookingUrl) base.push(makeBookingLinkTool(bookingUrl));
			toolsCache.set(input.tenantId, base);
		}

		// conversation-bound tools (зависят от conversationId — без кеша по тенанту).
		const conversationBound: AnyRagTool[] = [];

		let exchangeEnabled = exchangeEnabledCache.get(input.tenantId);
		if (exchangeEnabled === undefined) {
			exchangeEnabled = await hasActiveExchangeRates(db, input.tenantId).catch(
				() => false,
			);
			exchangeEnabledCache.set(input.tenantId, exchangeEnabled);
		}
		if (exchangeEnabled) {
			conversationBound.push(
				...makeExchangeTools({
					db,
					tenantId: input.tenantId,
					conversationId: input.conversationId,
					masterKeyHex: cfg.masterKeyHex,
				}),
			);
		}

		let multiRequestEnabled = multiRequestToolCache.get(input.tenantId);
		if (multiRequestEnabled === undefined) {
			multiRequestEnabled = await tenantSupportsMultiRequest(db, input.tenantId).catch(
				() => false,
			);
			multiRequestToolCache.set(input.tenantId, multiRequestEnabled);
		}
		if (multiRequestEnabled) {
			conversationBound.push(
				makeConciergeRequestsTool({
					db,
					tenantId: input.tenantId,
					conversationId: input.conversationId,
				}),
			);
		}

		return conversationBound.length > 0 ? [...base, ...conversationBound] : base;
	}

	// resolveReranker: reads per-tenant llm_provider_configs with purpose='reranker'.
	// Results are cached per-tenant (Reranker objects are stateless wrappers —
	// they hold only the API key and model, so caching per-tenant is safe).
	// Cache is never invalidated at runtime — requires restart if the admin
	// changes the reranker config. Acceptable trade-off: reranker changes rarely.
	const rerankerCache = new Map<number, Reranker | null>();
	async function resolveReranker(input: {
		tenantId: number;
	}): Promise<Reranker | null> {
		if (rerankerCache.has(input.tenantId)) {
			return rerankerCache.get(input.tenantId) ?? null;
		}
		const [row] = await db
			.select({
				provider: llmProviderConfigs.provider,
				model: llmProviderConfigs.model,
				secretRef: llmProviderConfigs.secretRef,
				baseUrl: llmProviderConfigs.baseUrl,
				timeoutMs: llmProviderConfigs.timeoutMs,
			})
			.from(llmProviderConfigs)
			.where(
				and(
					eq(llmProviderConfigs.tenantId, input.tenantId),
					eq(llmProviderConfigs.purpose, "reranker"),
				),
			)
			.limit(1);

		if (!row || !row.secretRef) {
			rerankerCache.set(input.tenantId, null);
			return null;
		}

		let apiKey: string | null = null;
		try {
			apiKey = await getDecryptedSecret({
				db,
				tenantId: input.tenantId,
				key: row.secretRef,
				masterKeyHex: cfg.masterKeyHex,
			});
		} catch (err) {
			console.warn(
				`[reranker] failed to decrypt API key for tenant ${input.tenantId}:`,
				err,
			);
			rerankerCache.set(input.tenantId, null);
			return null;
		}

		if (!apiKey) {
			rerankerCache.set(input.tenantId, null);
			return null;
		}

		let reranker: Reranker | null = null;
		if (row.provider === "cohere") {
			reranker = new CohereReranker({
				apiKey,
				...(row.model ? { model: row.model } : {}),
				...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
				...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
			});
		} else if (row.provider === "jina") {
			reranker = new JinaReranker({
				apiKey,
				...(row.model ? { model: row.model } : {}),
				...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
				...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
			});
		} else {
			console.warn(
				`[reranker] unsupported provider "${row.provider}" for tenant ${input.tenantId}`,
			);
		}

		rerankerCache.set(input.tenantId, reranker);
		return reranker;
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
			resolveStyle,
			resolveIsSupport: makeSupportModeResolver(db),
			resolveStageGuidance: makeStageGuidanceResolver(db),
			resolveRequestContext: makeRequestContextResolver(db),
			resolveAwaitingOperator: makeAwaitingOperatorResolver(db),
			resolveSkills,
			resolveDirectorHooks,
			resolveTools,
			resolveReranker,
			// Если основной ответ пуст (модель «промолчала», нет KB-контекста) —
			// генерируем мягкий ответ в персоне, а не молчим.
			softFallback: true,
		},
		(tenantId: number) => new MessagesRepo({ db, tenantId }),
	);

	return {
		strategy,
		invalidateToolsFor: (tenantId: number) => {
			toolsCache.delete(tenantId);
			exchangeEnabledCache.delete(tenantId);
			multiRequestToolCache.delete(tenantId);
		},
		invalidateStyleFor: (tenantId: number) => {
			styleCache.delete(tenantId);
			experimentCache.delete(tenantId);
		},
	};
}

/**
 * Resolver для STT-транскрибера голосовых сообщений (Whisper).
 * Использует API-ключ chat-конфига тенанта — тот же ключ, что в admin-UI.
 * Работает только для провайдеров с apiKey (openai, openrouter, custom).
 * Возвращает null если ни у одного тенанта нет подходящего ключа.
 */
// STT-эндпоинт /audio/transcriptions дают OpenAI (multipart, + Groq openai-
// совместимо) и OpenRouter (JSON+base64, модели whisper/chirp). НЕ-аудио
// провайдеры (ollama/anthropic/jina/cohere) тут не подходят.
const AUDIO_CAPABLE_PROVIDERS = new Set(["openai", "openrouter"]);

function pickTranscriberConfig(
	ref: LoadedRef,
	tenantId: number,
): { cfg: ResolvedLlmConfig; dedicated: boolean } | null {
	// 1) Явный purpose 'transcribe' (любой провайдер с ключом — пользователь сам
	//    выбрал модель/endpoint: OpenAI whisper-1, Groq, OpenRouter chirp-3) — приоритет.
	const dedicated = getConfig(ref.current, tenantId, "transcribe");
	if (dedicated?.apiKey) return { cfg: dedicated, dedicated: true };
	// 2) Фолбэк: ключ от любого аудио-способного назначения (chat → embed → vision).
	//    Так голос расшифровывается даже без отдельного ключа — на существующем
	//    OpenRouter- или OpenAI-ключе чата.
	for (const purpose of ["chat", "embed", "vision"] as const) {
		const cfg = getConfig(ref.current, tenantId, purpose);
		if (cfg?.apiKey && AUDIO_CAPABLE_PROVIDERS.has(cfg.provider)) {
			return { cfg, dedicated: false };
		}
	}
	return null;
}

/** Строит транскрайбер под провайдера. Модель берётся только для выделенного
 *  transcribe-конфига; в фолбэке — дефолтная STT-модель провайдера. */
function buildTranscriber(
	provider: string,
	apiKey: string,
	baseUrl: string | undefined,
	model: string | undefined,
): ITranscriber {
	if (provider === "openrouter") {
		return new OpenRouterTranscriber({
			apiKey,
			...(baseUrl ? { baseUrl } : {}),
			...(model ? { model } : {}),
		});
	}
	// openai (+ Groq через baseUrl) — multipart Whisper API.
	return new WhisperTranscriber({
		apiKey,
		...(baseUrl ? { baseUrl } : {}),
		...(model ? { model } : {}),
	});
}

export function makeTranscriberResolver(
	ref: LoadedRef,
): ((tenantId: number) => ITranscriber | null) | null {
	const anyAudioKey = [...ref.current.byTenant.keys()].some(
		(tenantId) => pickTranscriberConfig(ref, tenantId) !== null,
	);
	if (!anyAudioKey) return null;
	return (tenantId: number) => {
		const picked = pickTranscriberConfig(ref, tenantId);
		const apiKey = picked?.cfg.apiKey;
		if (!apiKey) return null;
		const { cfg, dedicated } = picked;
		// Модель берём только из выделенного transcribe-конфига — у chat/embed/
		// vision модель не для аудио, поэтому в фолбэке используем дефолтную STT.
		return buildTranscriber(
			cfg.provider,
			apiKey,
			cfg.baseUrl,
			dedicated ? cfg.model : undefined,
		);
	};
}

/**
 * Standalone embedder resolver — для admin-API endpoints'ов (KB upload),
 * которые не используют RagReplyStrategy но нуждаются в `EmbeddingClient`
 * per tenant. Возвращает null если ни один tenant не имеет embed config'а.
 */
export function makeEmbedderResolver(
	ref: LoadedRef,
):
	| ((tenantId: number) => import("@chatman-media/llm-router").EmbeddingClient)
	| null {
	if (!ref.current.anyTenantHasEmbed) return null;
	for (const [tenantId, perPurpose] of ref.current.byTenant) {
		const embed = perPurpose.get("embed");
		if (embed) ref.router.setConfig(toRouterConfig(tenantId, "embed", embed));
	}
	return (tenantId: number) => ref.router.resolveEmbed(tenantId);
}
