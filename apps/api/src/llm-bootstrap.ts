import {
	type AgentToolCallSource,
	AgentToolCallsRepo,
	ConversationsRepo,
	type Db,
	DrizzleKbStore,
	EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
	type ExchangeOrderPolicyState,
	type ExchangePolicyState,
	type ExchangeResponseGuardFinding,
	type ExchangeVerificationPolicyState,
	ExperimentsRepo,
	getDecryptedSecret,
	type ITranscriber,
	KbSuggestionsRepo,
	LlmMemoryExtractor,
	LlmReplyStrategy,
	loadExperimentVariants,
	type MemoryExtractor,
	MessagesRepo,
	parseStyleConfig,
	RagReplyStrategy,
	type RagTurnContext,
	type RagTurnInput,
	type ReplyStrategy,
	type ResolvedStyleAssignment,
	type StageClassifier,
	StylesRepo,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	ABRouter,
	type AnswerTelemetry,
	type AnyRagTool,
	CohereReranker,
	type DirectorHookForPrompt,
	JinaReranker,
	type KbScope,
	makeBookingLinkTool,
	type Reranker,
	type SkillForPrompt,
	type Style,
	type ToolCallRecord,
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
	funnels,
	leads,
	llmProviderConfigs,
	skills,
	stageDefinitions,
	tenantFeatureFlags,
} from "@chatman-media/storage";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { ApiConfig } from "./config.ts";
import { findActiveOrder, type OrderRow } from "./lib/exchange/orders.ts";
import {
	hasActiveExchangeRates,
	isKnownExchangeStage,
	makeExchangeTools,
	type RateGuardAlert,
} from "./lib/exchange/tools.ts";
import {
	type ExchangeVerificationStatus,
	getExchangeVerificationStatus,
} from "./lib/exchange/verification.ts";
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
	makeConciergeRequestsTool,
	REQUEST_TYPE_LABEL,
	tenantSupportsMultiRequest,
} from "./lib/concierge-tools.ts";
import {
	getConfig,
	type LoadedLlmConfigs,
	type ResolvedLlmConfig,
} from "./lib/llm-config-loader.ts";
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
		// Самый свежий ОТКРЫТЫЙ лид: с несколькими лидами на контакта (мульти-
		// воронка) limit(1) без сортировки брал произвольный, в т.ч. закрытый.
		const rows = await db
			.select({
				supportMode: stageDefinitions.supportMode,
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
					isNotNull(leads.stageDefinitionId),
				),
			)
			.orderBy(desc(leads.updatedAt));
		const open = rows.filter(
			(r) => r.kind !== "terminal_won" && r.kind !== "terminal_lost",
		);
		return open[0]?.supportMode === true;
	};
}

/**
 * Resolves the lead's current funnel-stage goal/guidance (Phase 2 C-2) so the
 * reply prompt can carry per-stage instructions. Mirrors the support-mode query
 * (leads → stage_definitions by leads.stageDefinitionId). null = no instructions.
 */
export function makeStageGuidanceResolver(db: Db) {
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<{ goal: string; guidance?: string } | null> => {
		// Самый свежий ОТКРЫТЫЙ лид (см. makeRequestContextResolver) — иначе при
		// нескольких лидах guidance мог браться из произвольного/закрытого.
		const rows = await db
			.select({
				goal: stageDefinitions.goal,
				guidance: stageDefinitions.guidance,
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
					isNotNull(leads.stageDefinitionId),
				),
			)
			.orderBy(desc(leads.updatedAt));
		const open = rows.filter(
			(r) => r.kind !== "terminal_won" && r.kind !== "terminal_lost",
		);
		const goal = open[0]?.goal;
		if (!goal) return null;
		const guidance = open[0]?.guidance;
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

/**
 * Воронка самого свежего ОТКРЫТОГО лида контакта (slug + verticalTemplateId).
 * null — открытых лидов нет (первый контакт). Нужна для скоупинга exchange-
 * guard'ов: у мульти-сервисного тенанта (обмен + трансфер + зелёный коридор)
 * guard'ы не должны переписывать ответы не-обменных воронок.
 */
export function makeLeadFunnelResolver(db: Db) {
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<{ slug: string; verticalTemplateId: string | null } | null> => {
		const rows = await db
			.select({
				slug: funnels.slug,
				verticalTemplateId: funnels.verticalTemplateId,
				kind: stageDefinitions.kind,
			})
			.from(leads)
			.leftJoin(
				stageDefinitions,
				eq(leads.stageDefinitionId, stageDefinitions.id),
			)
			.leftJoin(funnels, eq(stageDefinitions.funnelId, funnels.id))
			.where(
				and(
					eq(leads.tenantId, input.tenantId),
					eq(leads.userId, input.contactId),
					isNotNull(leads.stageDefinitionId),
				),
			)
			.orderBy(desc(leads.updatedAt))
			.limit(5);
		const open = rows.find(
			(r) =>
				r.kind !== "terminal_won" &&
				r.kind !== "terminal_lost" &&
				r.slug !== null,
		);
		return open?.slug
			? { slug: open.slug, verticalTemplateId: open.verticalTemplateId ?? null }
			: null;
	};
}

function makeKbScopeResolver(db: Db) {
	return async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<KbScope | null> => {
		return withTenant(db, input.tenantId, async (tx) => {
			const rows = await tx
				.select({
					funnelId: stageDefinitions.funnelId,
					stageSlug: stageDefinitions.slug,
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
						isNotNull(leads.stageDefinitionId),
					),
				)
				.orderBy(desc(leads.updatedAt))
				.limit(5);
			const current = rows.find(
				(row) =>
					row.funnelId !== null &&
					row.stageSlug !== null &&
					row.kind !== "terminal_won" &&
					row.kind !== "terminal_lost",
			);
			if (!current?.funnelId || !current.stageSlug) return null;
			return {
				scopeType: "stage",
				funnelId: current.funnelId,
				stageSlug: current.stageSlug,
			};
		});
	};
}

async function resolveCurrentExchangeStageSlug(
	db: Db,
	input: { tenantId: number; contactId: number },
): Promise<string | null> {
	const rows = await withTenant(db, input.tenantId, (tx) =>
		tx
			.select({
				requestType: leads.requestType,
				state: leads.state,
				slug: stageDefinitions.slug,
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
			.orderBy(desc(leads.updatedAt)),
	);
	const open = rows.filter(
		(r) => r.kind !== "terminal_won" && r.kind !== "terminal_lost",
	);
	const current = open[0];
	if (!current) return null;
	if (current.requestType && current.requestType !== "exchange") return null;
	const slug = current.slug ?? current.state;
	return isKnownExchangeStage(slug) ? slug : null;
}

const PAYMENT_VERIFIED_STATUSES = new Set(["paid", "payout", "completed"]);
const PAYOUT_READY_STATUSES = new Set(["payout", "completed"]);

function hasJsonPayload(value: string | null): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

export function exchangeOrderPolicyStateFromOrder(
	order: OrderRow,
): ExchangeOrderPolicyState {
	return {
		id: order.id,
		status: order.status,
		direction: order.direction,
		assetFrom: order.assetFrom,
		network: order.network,
		amountMode: order.amountMode,
		requestedAmount: order.requestedAmount,
		amountFrom: order.amountFrom,
		rate: order.rate,
		amountToThb: order.amountToThb,
		paymentMethod: order.paymentMethod,
		paymentRail: order.paymentRail,
		payoutMethod: order.payoutMethod,
		payoutLocation: order.payoutLocation,
		payoutDestinationJson: order.payoutDestinationJson,
		requisitesIssued: hasJsonPayload(order.requisitesJson),
		paymentProofReceived: hasJsonPayload(order.proofJson),
		paymentVerified: PAYMENT_VERIFIED_STATUSES.has(order.status),
		payoutReady: PAYOUT_READY_STATUSES.has(order.status),
		payoutCompleted: order.status === "completed",
		payoutCodeIssued: hasJsonPayload(order.payoutCode),
		verificationId: order.verificationId,
	};
}

function exchangeVerificationPolicyStateFromStatus(
	verification: ExchangeVerificationStatus,
): ExchangeVerificationPolicyState {
	return {
		verified: verification.verified,
		status: verification.status,
		needsVerification: verification.needsVerification,
		verificationId: verification.verificationId,
	};
}

export function buildExchangePolicyState(input: {
	stageSlug?: string | null;
	verification?: ExchangeVerificationStatus | null;
	order?: OrderRow | null;
}): ExchangePolicyState {
	return {
		stageSlug: input.stageSlug ?? null,
		verification: input.verification
			? exchangeVerificationPolicyStateFromStatus(input.verification)
			: null,
		order: input.order ? exchangeOrderPolicyStateFromOrder(input.order) : null,
	};
}

export function makeExchangePolicyStateResolver(db: Db) {
	return async (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
	}): Promise<ExchangePolicyState> => {
		const [stageSlug, verification, order] = await Promise.all([
			resolveCurrentExchangeStageSlug(db, {
				tenantId: input.tenantId,
				contactId: input.contactId,
			}),
			getExchangeVerificationStatus(db, input.tenantId, input.conversationId),
			findActiveOrder(db, input.tenantId, input.conversationId),
		]);
		return buildExchangePolicyState({ stageSlug, verification, order });
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

export interface ReplyStrategyTemplateOptions {
	/** Fallback for tenants without an installed vertical template. */
	fallbackTemplate: VerticalTemplate;
	/** Runtime tenant template resolver built from active funnels. */
	resolveTemplate?: (tenantId: number) => VerticalTemplate | null | undefined;
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

async function resolveTenantStyleAssignment(
	repo: Pick<StylesRepo, "findActiveBySlug" | "listActive">,
	defaultSlug: string,
): Promise<ResolvedStyleAssignment | null> {
	if (defaultSlug) {
		const row = await repo.findActiveBySlug(defaultSlug);
		if (row) {
			const parsed = parseStyleConfig(row.configJson);
			if (parsed) return { ...parsed, styleId: row.id, experimentId: null };
		}
	}
	const actives = await repo.listActive();
	if (actives.length === 0) return null;
	const latest = actives.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
	const parsed = parseStyleConfig(latest.configJson);
	return parsed ? { ...parsed, styleId: latest.id, experimentId: null } : null;
}

/**
 * resolveSkills: загружает enabled-навыки тенанта (кеш per-tenant). Stage-kind
 * фильтрация — внутри composeSystemPrompt. Вынесено из makeReplyStrategy для
 * прямого юнит-тестирования.
 */
export function makeSkillsResolver(
	db: Db,
): (input: { tenantId: number }) => Promise<readonly SkillForPrompt[]> {
	const cache = new Map<number, readonly SkillForPrompt[]>();
	return async (input: {
		tenantId: number;
	}): Promise<readonly SkillForPrompt[]> => {
		const cached = cache.get(input.tenantId);
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
			applicableStages: (() => {
				try {
					return JSON.parse(r.applicableStagesJson) as string[];
				} catch {
					return [];
				}
			})() as readonly string[],
		}));
		cache.set(input.tenantId, result);
		return result;
	};
}

/**
 * resolveDirectorHooks: активные director-hooks тенанта (без кеша — меняются из
 * UI в любой момент; один индексированный запрос на ответ).
 */
export function makeDirectorHooksResolver(
	db: Db,
): (input: { tenantId: number }) => Promise<readonly DirectorHookForPrompt[]> {
	return async (input: {
		tenantId: number;
	}): Promise<readonly DirectorHookForPrompt[]> => {
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
	};
}

/**
 * resolveReranker: per-tenant llm_provider_configs purpose='reranker' →
 * Cohere/Jina reranker (кеш per-tenant, инвалидация только рестартом).
 */
export function makeRerankerResolver(
	db: Db,
	masterKeyHex: string,
): (input: { tenantId: number }) => Promise<Reranker | null> {
	const cache = new Map<number, Reranker | null>();
	return async (input: { tenantId: number }): Promise<Reranker | null> => {
		if (cache.has(input.tenantId)) return cache.get(input.tenantId) ?? null;
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
			cache.set(input.tenantId, null);
			return null;
		}

		let apiKey: string | null = null;
		try {
			apiKey = await getDecryptedSecret({
				db,
				tenantId: input.tenantId,
				key: row.secretRef,
				masterKeyHex,
			});
		} catch (err) {
			console.warn(
				`[reranker] failed to decrypt API key for tenant ${input.tenantId}:`,
				err,
			);
			cache.set(input.tenantId, null);
			return null;
		}

		if (!apiKey) {
			cache.set(input.tenantId, null);
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

		cache.set(input.tenantId, reranker);
		return reranker;
	};
}

/**
 * resolveStyle: цепочка приоритета experiment (A/B) → global default slug →
 * активный стиль тенанта. Кеши per-tenant (style + experiment-router).
 */
export function makeStyleResolver(
	db: Db,
	opts: { defaultSlug: string; experimentSlug: string },
): {
	resolveStyle: (input: {
		tenantId: number;
		contactId: number;
	}) => Promise<ResolvedStyleAssignment | null>;
	invalidateStyle: (tenantId: number) => void;
} {
	const styleCache = new Map<number, ResolvedStyleAssignment | null>();
	const experimentCache = new Map<
		number,
		| { router: ABRouter; experimentId: number; experimentSlug: string }
		| "absent"
	>();
	const { defaultSlug, experimentSlug } = opts;
	const resolveStyle = async (input: {
		tenantId: number;
		contactId: number;
	}): Promise<ResolvedStyleAssignment | null> => {
		if (experimentSlug) {
			let abRouter = experimentCache.get(input.tenantId);
			if (abRouter === undefined) {
				const expRepo = new ExperimentsRepo({ db, tenantId: input.tenantId });
				const stylesRepo = new StylesRepo({ db, tenantId: input.tenantId });
				const exp = await expRepo.findRunningBySlug(experimentSlug);
				if (exp) {
					const variants = await loadExperimentVariants(exp, stylesRepo);
					if (variants) {
						abRouter = {
							router: new ABRouter({ variants, salt: exp.slug }),
							experimentId: exp.id,
							experimentSlug: exp.slug,
						};
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
				const assigned = abRouter.router.assign(String(input.contactId));
				const assignedStyle = assigned.style as ResolvedStyleAssignment;
				return {
					...assignedStyle,
					styleId: assignedStyle.styleId ?? null,
					experimentId: abRouter.experimentId,
					experimentSlug: abRouter.experimentSlug,
					variantSlug: assigned.variantSlug,
				};
			}
		}
		const cached = styleCache.get(input.tenantId);
		if (cached !== undefined) return cached;
		const repo = new StylesRepo({ db, tenantId: input.tenantId });
		const parsed = await resolveTenantStyleAssignment(repo, defaultSlug);
		styleCache.set(input.tenantId, parsed);
		return parsed;
	};
	const invalidateStyle = (tenantId: number) => {
		styleCache.delete(tenantId);
		experimentCache.delete(tenantId);
	};
	return { resolveStyle, invalidateStyle };
}

/**
 * resolveTools: agentic-инструменты тенанта. tenant-bound (booking_link)
 * кешируются; conversation-bound (exchange / concierge) строятся свежими (гейт
 * включённости — boolean-кеш). invalidateTools сбрасывает кеши тенанта.
 */
export function makeToolsResolver(opts: {
	db: Db;
	masterKeyHex: string;
	notifyRateGuard?: (alert: RateGuardAlert) => void;
}): {
	resolveTools: (input: {
		tenantId: number;
		conversationId: number;
		contactId?: number;
	}) => Promise<AnyRagTool[]>;
	invalidateTools: (tenantId: number) => void;
} {
	const { db, masterKeyHex, notifyRateGuard } = opts;
	const toolsCache = new Map<number, AnyRagTool[]>();
	const exchangeEnabledCache = new Map<number, boolean>();
	const multiRequestToolCache = new Map<number, boolean>();

	async function resolveTools(input: {
		tenantId: number;
		conversationId: number;
		contactId?: number;
	}): Promise<AnyRagTool[]> {
		let base = toolsCache.get(input.tenantId);
		if (base === undefined) {
			const bookingUrl = await getDecryptedSecret({
				db,
				tenantId: input.tenantId,
				key: "tool_booking_url",
				masterKeyHex,
			});
			base = [];
			if (bookingUrl) base.push(makeBookingLinkTool(bookingUrl));
			toolsCache.set(input.tenantId, base);
		}

		const conversationBound: AnyRagTool[] = [];

		let exchangeEnabled = exchangeEnabledCache.get(input.tenantId);
		if (exchangeEnabled === undefined) {
			exchangeEnabled = await hasActiveExchangeRates(db, input.tenantId).catch(
				() => false,
			);
			exchangeEnabledCache.set(input.tenantId, exchangeEnabled);
		}
		if (exchangeEnabled) {
			const stageSlug = input.contactId
				? await resolveCurrentExchangeStageSlug(db, {
						tenantId: input.tenantId,
						contactId: input.contactId,
					}).catch(() => null)
				: null;
			conversationBound.push(
				...makeExchangeTools({
					db,
					tenantId: input.tenantId,
					conversationId: input.conversationId,
					masterKeyHex,
					...(stageSlug ? { stageSlug } : {}),
					...(notifyRateGuard ? { notifyRateGuard } : {}),
				}),
			);
		}

		let multiRequestEnabled = multiRequestToolCache.get(input.tenantId);
		if (multiRequestEnabled === undefined) {
			multiRequestEnabled = await tenantSupportsMultiRequest(
				db,
				input.tenantId,
			).catch(() => false);
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

		return conversationBound.length > 0
			? [...base, ...conversationBound]
			: base;
	}

	const invalidateTools = (tenantId: number) => {
		toolsCache.delete(tenantId);
		exchangeEnabledCache.delete(tenantId);
		multiRequestToolCache.delete(tenantId);
	};

	return { resolveTools, invalidateTools };
}

type RecordedToolCall = Pick<
	ToolCallRecord,
	"name" | "args" | "result" | "error" | "cycle"
>;

const EXCHANGE_RESPONSE_GUARD_TRACE_TOOL = "exchange_response_guard";

function toolCallsFromTelemetry(
	telemetry: AnswerTelemetry,
): RecordedToolCall[] {
	if (telemetry.toolCalls && telemetry.toolCalls.length > 0)
		return telemetry.toolCalls;
	if (!telemetry.toolCall) return [];
	return [
		{
			name: telemetry.toolCall.name,
			args: {},
			result: telemetry.toolCall.result,
			cycle: 0,
		},
	];
}

function makeToolCallRecorder(db: Db, source: AgentToolCallSource) {
	return async (input: {
		tenantId: number;
		conversationId: number;
		contactId: number;
		telemetry?: AnswerTelemetry;
		toolCalls?: readonly ToolCallRecord[];
		guardFindings?: readonly ExchangeResponseGuardFinding[];
	}): Promise<void> => {
		const calls =
			input.toolCalls ??
			(input.telemetry ? toolCallsFromTelemetry(input.telemetry) : []);
		const guardFindings = input.guardFindings ?? [];
		if (calls.length === 0 && guardFindings.length === 0) return;
		const nowEpoch = Math.floor(Date.now() / 1000);
		await withTenant(db, input.tenantId, async (tx) => {
			await new AgentToolCallsRepo({
				db: tx,
				tenantId: input.tenantId,
			}).recordMany([
				...calls.map((call, index) => ({
					conversationId: input.conversationId,
					contactId: input.contactId,
					source,
					toolName: call.name,
					args: call.args,
					result: call.result,
					error: call.error ?? false,
					cycle: call.cycle,
					toolCallIndex: index,
					nowEpoch,
				})),
				...guardFindings.map((finding, index) => ({
					conversationId: input.conversationId,
					contactId: input.contactId,
					source,
					toolName: EXCHANGE_RESPONSE_GUARD_TRACE_TOOL,
					args: { originalText: finding.originalText },
					result: finding,
					error: finding.action !== "pass",
					cycle: 0,
					toolCallIndex: calls.length + index,
					nowEpoch,
				})),
			]);
		});
	};
}

function makeExchangeResponseGuardFlagResolver(db: Db) {
	return async (input: { tenantId: number }): Promise<boolean> => {
		try {
			return await withTenant(db, input.tenantId, async (tx) => {
				const [row] = await tx
					.select({ enabled: tenantFeatureFlags.enabled })
					.from(tenantFeatureFlags)
					.where(
						and(
							eq(tenantFeatureFlags.tenantId, input.tenantId),
							eq(
								tenantFeatureFlags.featureKey,
								EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
							),
						),
					)
					.limit(1);
				return row?.enabled !== false;
			});
		} catch (err) {
			console.warn(
				"[llm-bootstrap] failed to resolve exchange response guard flag:",
				err,
			);
			return true;
		}
	};
}

export function makeReplyStrategy(
	ref: LoadedRef,
	cfg: ApiConfig,
	db: Db,
	templates: ReplyStrategyTemplateOptions,
	metrics?: PlatformMetrics,
	recordUsage?: RecordUsage,
	notifyRateGuard?: (alert: RateGuardAlert) => void,
): ReplyStrategyBundle | null {
	if (!ref.current.anyTenantHasChat) return null;

	for (const [tenantId, perPurpose] of ref.current.byTenant) {
		const chat = perPurpose.get("chat");
		if (chat) ref.router.setConfig(toRouterConfig(tenantId, "chat", chat));
		const embed = perPurpose.get("embed");
		if (embed) ref.router.setConfig(toRouterConfig(tenantId, "embed", embed));
	}

	const { fallbackTemplate, resolveTemplate } = templates;

	// resolveTools: см. makeToolsResolver. Определён ДО embed-проверки, чтобы и
	// LLM-only fallback мог давать боту инструменты (напр. расчёт курса).
	const { resolveTools, invalidateTools } = makeToolsResolver({
		db,
		masterKeyHex: cfg.masterKeyHex,
		...(notifyRateGuard ? { notifyRateGuard } : {}),
	});
	const resolveExchangePolicyState = makeExchangePolicyStateResolver(db);
	const resolveExchangeResponseGuardEnabled =
		makeExchangeResponseGuardFlagResolver(db);

	// Если ни один tenant не имеет embed config'а — fall back на LlmReplyStrategy.
	// NB: проверка против initial snapshot'а; если tenant позже добавит embed,
	// reloader setConfig'нет на router, но strategy уже LlmReplyStrategy. После
	// hot-reload с появлением embed — restart нужен. (Acceptable trade-off:
	// chat/embed добавление редкое, токены/каналы — частое.)
	if (!ref.current.anyTenantHasEmbed) {
		return {
			strategy: new LlmReplyStrategy(
				{
					template: fallbackTemplate,
					resolveTemplate,
					resolveChat: (tenantId: number) =>
						ref.router.resolveChat(tenantId, "chat"),
					resolveIsSupport: makeSupportModeResolver(db),
					resolveTools,
					resolveExchangePolicyState,
					resolveExchangeResponseGuardEnabled,
					recordToolCalls: makeToolCallRecorder(db, "llm_reply"),
				},
				(tenantId: number) => new MessagesRepo({ db, tenantId }),
			),
			invalidateToolsFor: invalidateTools, // exchange/booking tools без RAG
			invalidateStyleFor: () => {}, // LlmReplyStrategy resolves no styles
		};
	}

	const { resolveStyle, invalidateStyle } = makeStyleResolver(db, {
		defaultSlug: cfg.defaultStyleSlug,
		experimentSlug: cfg.experimentSlug,
	});

	const resolveSkills = makeSkillsResolver(db);
	const resolveDirectorHooks = makeDirectorHooksResolver(db);
	const resolveReranker = makeRerankerResolver(db, cfg.masterKeyHex);
	const resolveIsSupport = makeSupportModeResolver(db);
	const resolveKbScope = makeKbScopeResolver(db);
	const resolveLeadFunnel = makeLeadFunnelResolver(db);
	const resolveStageGuidance = makeStageGuidanceResolver(db);
	const resolveRequestContext = makeRequestContextResolver(db);
	const resolveAwaitingOperator = makeAwaitingOperatorResolver(db);

	const resolveWrappedChat = (tenantId: number) => {
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
	};
	const resolveWrappedEmbed = (tenantId: number): RagEmbeddingClient => {
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
	};

	// Весь контекст хода собирается здесь одним вызовом (#514): support-гейт
	// первым (дёшево, и в support-mode остальное не грузим), затем независимые
	// источники параллельно. Exchange policy state — только для exchange_v1.
	const loadTurnContext = async (
		input: RagTurnInput,
	): Promise<RagTurnContext> => {
		const { tenantId, conversationId, contactId } = input;
		const template = resolveTemplate?.(tenantId) ?? fallbackTemplate;
		const base: RagTurnContext = {
			template,
			chat: resolveWrappedChat(tenantId),
			embedder: resolveWrappedEmbed(tenantId),
			kb: new DrizzleKbStore({ db, tenantId }),
			messages: new MessagesRepo({ db, tenantId }),
			conversations: new ConversationsRepo({ db, tenantId }),
			suggestions: new KbSuggestionsRepo({ db, tenantId }),
		};
		if (await resolveIsSupport({ tenantId, contactId })) {
			return { ...base, isSupport: true };
		}
		const isExchange = template?.slug === "exchange_v1";
		const [
			kbScope,
			style,
			skills,
			directorHooks,
			tools,
			reranker,
			stageGuidance,
			requestContext,
			awaitingOperator,
			exchangePolicyState,
			exchangeResponseGuardEnabled,
			leadFunnel,
		] = await Promise.all([
			resolveKbScope({ tenantId, contactId }),
			resolveStyle({ tenantId, contactId }),
			resolveSkills({ tenantId }),
			resolveDirectorHooks({ tenantId }),
			resolveTools({ tenantId, conversationId, contactId }),
			resolveReranker({ tenantId }),
			resolveStageGuidance({ tenantId, contactId }),
			resolveRequestContext({ tenantId, contactId }),
			resolveAwaitingOperator({ tenantId, contactId }),
			isExchange
				? resolveExchangePolicyState({
						tenantId,
						conversationId,
						contactId,
					}).catch((err) => {
						console.warn(
							"[llm-bootstrap] failed to resolve exchange policy state:",
							err,
						);
						return null;
					})
				: Promise.resolve(null),
			isExchange
				? resolveExchangeResponseGuardEnabled({ tenantId })
				: Promise.resolve(true),
			isExchange
				? resolveLeadFunnel({ tenantId, contactId }).catch((err) => {
						console.warn("[llm-bootstrap] failed to resolve lead funnel:", err);
						return null;
					})
				: Promise.resolve(null),
		]);
		// Скоупинг exchange-guard'ов по воронке открытого лида: у мульти-
		// сервисного тенанта transfer/green_corridor-диалоги не должны
		// переписываться обменным guard'ом («цена без computeQuote»). Нет
		// открытого лида (первый контакт) — guard остаётся включён.
		const leadFunnelIsExchange =
			leadFunnel === null ||
			`${leadFunnel.slug} ${leadFunnel.verticalTemplateId ?? ""}`
				.toLowerCase()
				.replaceAll("-", "_")
				.includes("exchange");
		return {
			...base,
			kbScope,
			style,
			skills,
			directorHooks,
			tools,
			reranker,
			stageGuidance,
			requestContext,
			awaitingOperator,
			exchangePolicyState,
			exchangeResponseGuardEnabled:
				exchangeResponseGuardEnabled && leadFunnelIsExchange,
		};
	};

	const strategy = new RagReplyStrategy({
		loadTurnContext,
		recordToolCalls: makeToolCallRecorder(db, "rag_reply"),
		// Если основной ответ пуст (модель «промолчала», нет KB-контекста) —
		// генерируем мягкий ответ в персоне, а не молчим.
		softFallback: true,
	});

	return {
		strategy,
		invalidateToolsFor: invalidateTools,
		invalidateStyleFor: invalidateStyle,
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
