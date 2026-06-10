import type { Inbound } from "@chatman-media/channel-core";
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { ChatClient } from "@chatman-media/llm-router";
import {
	funnels,
	leadEvents,
	leadFieldValues,
	leads,
	partnerDeals,
	partnerServices,
	partners,
	serviceCatalogItems,
	stageDefinitions,
	stageFields,
} from "@chatman-media/storage";
import { and, asc, desc, eq, isNull, notInArray, or } from "drizzle-orm";
import { SERVICE_CATALOG_CLASSIFIER_SYSTEM_PROMPT } from "../prompts/service-catalog-runtime.ts";

export type ServiceCatalogRouteType =
	| "manual"
	| "funnel"
	| "partner_service"
	| "webhook";

export interface ServiceCatalogRuntime {
	extract(
		opts: ServiceCatalogRuntimeInput,
	): Promise<ServiceCatalogRuntimeResult>;
}

export interface ServiceCatalogRuntimeInput {
	db: Db;
	tenantId: number;
	contactId: number;
	conversationId?: number | null;
	text: string;
	inbound?: Inbound;
}

export interface ServiceCatalogRuntimeResult {
	created: Array<{
		leadId: number;
		serviceSlug: string;
		routeType: ServiceCatalogRouteType;
		partnerDealId?: number;
	}>;
	skipped: Array<{ serviceSlug: string; reason: string }>;
}

export interface ServiceCatalogRuntimeDeps {
	resolveChat?: (tenantId: number) => ChatClient | null;
	fetch?: typeof fetch;
	now?: () => number;
}

interface CatalogRow {
	id: number;
	slug: string;
	name: string;
	category: string | null;
	description: string | null;
	routeType: ServiceCatalogRouteType;
	funnelId: number | null;
	partnerServiceId: number | null;
	webhookUrl: string | null;
	metadataJson: string;
	partnerId: number | null;
	partnerName: string | null;
	partnerServiceName: string | null;
	partnerServiceFunnelId: number | null;
	partnerServiceStageDefinitionId: number | null;
	partnerServiceCommissionPct: number | null;
	partnerServiceNotes: string | null;
	partnerDefaultCommissionPct: number | null;
}

export interface CatalogMatchInput {
	id: number;
	slug: string;
	name: string;
	category?: string | null;
	description?: string | null;
	metadataJson?: string;
}

export interface ServiceRequestMatch {
	serviceSlug: string;
	requestType: string;
	confidence: number;
	fields: Record<string, unknown>;
	note?: string;
	source: "heuristic" | "llm";
}

interface StageTarget {
	stageId: number | null;
	stageSlug: string;
}

interface PendingWebhook {
	url: string;
	payload: Record<string, unknown>;
}

const GENERIC_WORDS = new Set([
	"service",
	"services",
	"provider",
	"custom",
	"offer",
	"услуга",
	"услуги",
	"провайдер",
	"партнер",
	"партнёр",
]);

const SERVICE_SYNONYMS: Record<string, string[]> = {
	transfer: [
		"transfer",
		"pickup",
		"driver",
		"airport",
		"taxi",
		"minivan",
		"трансфер",
		"аэропорт",
		"водитель",
		"такси",
		"минивен",
		"минивэн",
		"встрет",
	],
	cleaning: [
		"cleaning",
		"clean",
		"checkout",
		"laundry",
		"housekeeping",
		"уборка",
		"убрать",
		"клининг",
		"прачеч",
		"laundry",
	],
	massage: [
		"massage",
		"spa",
		"therapist",
		"thai",
		"deep tissue",
		"массаж",
		"спа",
		"мастер",
	],
	beauty: [
		"beauty",
		"salon",
		"hair",
		"nails",
		"makeup",
		"brows",
		"салон",
		"красот",
		"ногти",
		"волос",
		"макияж",
		"бров",
	],
	housing: [
		"housing",
		"villa",
		"apartment",
		"condo",
		"booking",
		"bedroom",
		"жилье",
		"жильё",
		"вилла",
		"апартамент",
		"кондо",
		"спальн",
		"бронь",
	],
	exchange: [
		"exchange",
		"usdt",
		"btc",
		"eth",
		"rub",
		"thb",
		"crypto",
		"rate",
		"обмен",
		"крипт",
		"курс",
		"рубл",
		"бат",
		"кошелек",
		"кошелёк",
	],
	food: [
		"food",
		"dinner",
		"chef",
		"restaurant",
		"delivery",
		"еда",
		"ужин",
		"шеф",
		"ресторан",
		"доставка",
	],
	tour: ["tour", "trip", "excursion", "island", "тур", "экскурс", "остров"],
};

export function makeServiceCatalogRuntime(
	deps: ServiceCatalogRuntimeDeps = {},
): ServiceCatalogRuntime {
	const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
	const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);

	return {
		async extract(input) {
			const text = input.text.trim();
			if (!text) return { created: [], skipped: [] };

			const catalog = await loadCatalog(input.db, input.tenantId);
			if (catalog.length === 0) return { created: [], skipped: [] };

			const matches = await resolveMatches({
				tenantId: input.tenantId,
				text,
				catalog,
				resolveChat: deps.resolveChat,
			});
			if (matches.length === 0) return { created: [], skipped: [] };

			const bySlug = new Map(catalog.map((row) => [row.slug, row]));
			const pendingWebhooks: PendingWebhook[] = [];
			const result = await withTenant(input.db, input.tenantId, async (tx) => {
				const created: ServiceCatalogRuntimeResult["created"] = [];
				const skipped: ServiceCatalogRuntimeResult["skipped"] = [];
				const epoch = now();

				for (const match of matches) {
					const item = bySlug.get(match.serviceSlug);
					if (!item) continue;
					const existing = await findOpenLeadForRequest({
						tx,
						tenantId: input.tenantId,
						contactId: input.contactId,
						requestType: match.requestType,
					});
					if (existing) {
						skipped.push({
							serviceSlug: item.slug,
							reason: "open_request_exists",
						});
						continue;
					}

					const target = await resolveStageTarget(tx, input.tenantId, item);
					const intake = buildIntake({
						item,
						match,
						text,
						inbound: input.inbound,
						conversationId: input.conversationId ?? null,
					});
					const [lead] = await tx
						.insert(leads)
						.values({
							tenantId: input.tenantId,
							userId: input.contactId,
							state: target.stageSlug,
							stageDefinitionId: target.stageId,
							requestType: match.requestType,
							intakeJson: JSON.stringify(intake),
							createdAt: epoch,
							updatedAt: epoch,
						})
						.returning({ id: leads.id });
					if (!lead) {
						skipped.push({
							serviceSlug: item.slug,
							reason: "lead_insert_failed",
						});
						continue;
					}

					await tx.insert(leadEvents).values({
						tenantId: input.tenantId,
						leadId: lead.id,
						fromState: null,
						toState: target.stageSlug,
						notes: `service_catalog:${item.slug}`,
						createdAt: epoch,
					});

					if (target.stageId) {
						await writeFieldValues({
							tx,
							tenantId: input.tenantId,
							leadId: lead.id,
							stageId: target.stageId,
							fields: match.fields,
							now: epoch,
						});
					}

					let partnerDealId: number | undefined;
					if (item.routeType === "partner_service" && item.partnerServiceId) {
						const [deal] = await tx
							.insert(partnerDeals)
							.values({
								tenantId: input.tenantId,
								partnerId: item.partnerId,
								serviceId: item.partnerServiceId,
								leadId: lead.id,
								stageDefinitionId: target.stageId,
								status: "sent",
								handoffUrl: readHandoffUrl(item),
								handoffMode: readHandoffMode(item),
								commissionPct: Number(
									item.partnerServiceCommissionPct ??
										item.partnerDefaultCommissionPct ??
										0,
								),
								notes: JSON.stringify({
									source: "service_catalog_runtime",
									serviceCatalogItemId: item.id,
									serviceSlug: item.slug,
									fields: match.fields,
									note: match.note ?? null,
								}),
								sentAt: epoch,
								createdAt: epoch,
								updatedAt: epoch,
							})
							.returning({ id: partnerDeals.id });
						partnerDealId = deal?.id;
					}

					if (item.routeType === "webhook" && item.webhookUrl) {
						pendingWebhooks.push({
							url: item.webhookUrl,
							payload: {
								event: "service_request.created",
								tenantId: input.tenantId,
								leadId: lead.id,
								contactId: input.contactId,
								conversationId: input.conversationId ?? null,
								service: {
									id: item.id,
									slug: item.slug,
									name: item.name,
									category: item.category,
								},
								requestType: match.requestType,
								fields: match.fields,
								text,
							},
						});
					}

					created.push({
						leadId: lead.id,
						serviceSlug: item.slug,
						routeType: item.routeType,
						...(partnerDealId ? { partnerDealId } : {}),
					});
				}

				return { created, skipped };
			});

			await Promise.allSettled(
				pendingWebhooks.map((hook) =>
					fetchFn(hook.url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(hook.payload),
					}),
				),
			);

			return result;
		},
	};
}

export function extractInboundText(inbound: Inbound): string {
	return inbound.parts
		.map((part) => {
			if (part.kind === "text") return part.text;
			if ("caption" in part && part.caption) return part.caption;
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function deterministicCatalogMatches(
	text: string,
	catalog: CatalogMatchInput[],
): ServiceRequestMatch[] {
	const normalizedText = normalizeText(text);
	if (!normalizedText) return [];

	const matches: ServiceRequestMatch[] = [];
	for (const item of catalog) {
		const requestType = requestTypeForCatalogItem(item);
		const kind = inferServiceKind(item);
		let score = 0;
		const haystack = normalizeText(
			[
				item.slug,
				item.name,
				item.category ?? "",
				item.description ?? "",
				readMetadata(item.metadataJson).requiredFields?.join(" ") ?? "",
			].join(" "),
		);

		if (kind) {
			for (const phrase of SERVICE_SYNONYMS[kind] ?? []) {
				if (normalizedText.includes(normalizeText(phrase))) score += 4;
			}
		}

		for (const token of importantTokens(item)) {
			if (normalizedText.includes(token)) score += 2;
			if (haystack.includes(token) && normalizedText.includes(token))
				score += 1;
		}

		if (score >= 4) {
			matches.push({
				serviceSlug: item.slug,
				requestType,
				confidence: Math.min(0.95, 0.55 + score / 20),
				fields: {},
				source: "heuristic",
			});
		}
	}

	return dedupeMatches(matches);
}

async function loadCatalog(db: Db, tenantId: number): Promise<CatalogRow[]> {
	return withTenant(db, tenantId, async (tx) =>
		tx
			.select({
				id: serviceCatalogItems.id,
				slug: serviceCatalogItems.slug,
				name: serviceCatalogItems.name,
				category: serviceCatalogItems.category,
				description: serviceCatalogItems.description,
				routeType: serviceCatalogItems.routeType,
				funnelId: serviceCatalogItems.funnelId,
				partnerServiceId: serviceCatalogItems.partnerServiceId,
				webhookUrl: serviceCatalogItems.webhookUrl,
				metadataJson: serviceCatalogItems.metadataJson,
				partnerId: partners.id,
				partnerName: partners.name,
				partnerServiceName: partnerServices.name,
				partnerServiceFunnelId: partnerServices.funnelId,
				partnerServiceStageDefinitionId: partnerServices.stageDefinitionId,
				partnerServiceCommissionPct: partnerServices.commissionPct,
				partnerServiceNotes: partnerServices.notes,
				partnerDefaultCommissionPct: partners.defaultCommissionPct,
			})
			.from(serviceCatalogItems)
			.leftJoin(
				partnerServices,
				and(
					eq(partnerServices.tenantId, tenantId),
					eq(partnerServices.id, serviceCatalogItems.partnerServiceId),
				),
			)
			.leftJoin(
				partners,
				and(
					eq(partners.tenantId, tenantId),
					eq(partners.id, partnerServices.partnerId),
				),
			)
			.where(
				and(
					eq(serviceCatalogItems.tenantId, tenantId),
					eq(serviceCatalogItems.isActive, true),
				),
			)
			.orderBy(asc(serviceCatalogItems.sortOrder), asc(serviceCatalogItems.id))
			.then((rows) =>
				rows
					.map((row) => ({
						...row,
						routeType: parseRouteType(row.routeType),
					}))
					.filter((row): row is CatalogRow => Boolean(row.routeType)),
			),
	);
}

async function resolveMatches(opts: {
	tenantId: number;
	text: string;
	catalog: CatalogRow[];
	resolveChat?: (tenantId: number) => ChatClient | null;
}): Promise<ServiceRequestMatch[]> {
	const heuristic = deterministicCatalogMatches(opts.text, opts.catalog);
	const chat = opts.resolveChat?.(opts.tenantId) ?? null;
	if (!chat) return heuristic;

	try {
		const llm = await llmCatalogMatches(chat, opts.text, opts.catalog);
		return dedupeMatches([...llm, ...heuristic]);
	} catch {
		return heuristic;
	}
}

async function llmCatalogMatches(
	chat: ChatClient,
	text: string,
	catalog: CatalogRow[],
): Promise<ServiceRequestMatch[]> {
	const compact = catalog.slice(0, 30).map((item) => ({
		slug: item.slug,
		name: item.name,
		category: item.category,
		description: item.description,
		routeType: item.routeType,
		requiredFields: readMetadata(item.metadataJson).requiredFields ?? [],
	}));
	const raw = await chat.complete(
		[
			{
				role: "system",
				content: SERVICE_CATALOG_CLASSIFIER_SYSTEM_PROMPT,
			},
			{
				role: "user",
				content: JSON.stringify({ catalog: compact, message: text }),
			},
		],
		{ temperature: 0, numPredict: 700 },
	);
	const parsed = parseJsonObject(raw);
	const requests = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.requests)
			? parsed.requests
			: [];
	const bySlug = new Map(catalog.map((item) => [item.slug, item]));
	return requests
		.map((req): ServiceRequestMatch | null => {
			if (!isRecord(req)) return null;
			const slug = typeof req.slug === "string" ? req.slug : "";
			const item = bySlug.get(slug);
			if (!item) return null;
			const confidence = Number(req.confidence ?? 0);
			if (!Number.isFinite(confidence) || confidence < 0.45) return null;
			return {
				serviceSlug: item.slug,
				requestType: requestTypeForCatalogItem(item),
				confidence: Math.min(1, Math.max(0, confidence)),
				fields:
					req.fields &&
					typeof req.fields === "object" &&
					!Array.isArray(req.fields)
						? (req.fields as Record<string, unknown>)
						: {},
				...(typeof req.note === "string"
					? { note: req.note.slice(0, 300) }
					: {}),
				source: "llm",
			};
		})
		.filter((match): match is ServiceRequestMatch => Boolean(match));
}

async function findOpenLeadForRequest(opts: {
	tx: Db;
	tenantId: number;
	contactId: number;
	requestType: string;
}): Promise<{ id: number } | null> {
	const [row] = await opts.tx
		.select({ id: leads.id })
		.from(leads)
		.leftJoin(
			stageDefinitions,
			eq(leads.stageDefinitionId, stageDefinitions.id),
		)
		.where(
			and(
				eq(leads.tenantId, opts.tenantId),
				eq(leads.userId, opts.contactId),
				eq(leads.requestType, opts.requestType),
				or(
					isNull(stageDefinitions.kind),
					notInArray(stageDefinitions.kind, ["terminal_won", "terminal_lost"]),
				),
			),
		)
		.orderBy(desc(leads.updatedAt))
		.limit(1);
	return row ?? null;
}

async function resolveStageTarget(
	tx: Db,
	tenantId: number,
	item: CatalogRow,
): Promise<StageTarget> {
	if (item.routeType === "funnel" && item.funnelId) {
		const stage = await firstStageInFunnel(tx, tenantId, item.funnelId);
		if (stage) return stage;
	}

	if (item.partnerServiceStageDefinitionId) {
		const [stage] = await tx
			.select({
				stageId: stageDefinitions.id,
				stageSlug: stageDefinitions.slug,
			})
			.from(stageDefinitions)
			.where(
				and(
					eq(stageDefinitions.tenantId, tenantId),
					eq(stageDefinitions.id, item.partnerServiceStageDefinitionId),
				),
			)
			.limit(1);
		if (stage) return { stageId: stage.stageId, stageSlug: stage.stageSlug };
	}

	if (item.partnerServiceFunnelId) {
		const stage = await firstStageInFunnel(
			tx,
			tenantId,
			item.partnerServiceFunnelId,
		);
		if (stage) return stage;
	}

	const [awaiting] = await tx
		.select({ stageId: stageDefinitions.id, stageSlug: stageDefinitions.slug })
		.from(stageDefinitions)
		.innerJoin(funnels, eq(funnels.id, stageDefinitions.funnelId))
		.where(
			and(
				eq(funnels.tenantId, tenantId),
				eq(funnels.isActive, true),
				eq(stageDefinitions.tenantId, tenantId),
				eq(stageDefinitions.stageType, "awaiting_operator"),
			),
		)
		.orderBy(asc(stageDefinitions.position))
		.limit(1);
	if (awaiting)
		return { stageId: awaiting.stageId, stageSlug: awaiting.stageSlug };

	const [first] = await tx
		.select({ stageId: stageDefinitions.id, stageSlug: stageDefinitions.slug })
		.from(stageDefinitions)
		.innerJoin(funnels, eq(funnels.id, stageDefinitions.funnelId))
		.where(
			and(
				eq(funnels.tenantId, tenantId),
				eq(funnels.isActive, true),
				eq(stageDefinitions.tenantId, tenantId),
			),
		)
		.orderBy(asc(stageDefinitions.position))
		.limit(1);
	if (first) return { stageId: first.stageId, stageSlug: first.stageSlug };

	return { stageId: null, stageSlug: `service_${item.slug}`.slice(0, 96) };
}

async function firstStageInFunnel(
	tx: Db,
	tenantId: number,
	funnelId: number,
): Promise<StageTarget | null> {
	const [stage] = await tx
		.select({ stageId: stageDefinitions.id, stageSlug: stageDefinitions.slug })
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.tenantId, tenantId),
				eq(stageDefinitions.funnelId, funnelId),
			),
		)
		.orderBy(asc(stageDefinitions.position))
		.limit(1);
	return stage ? { stageId: stage.stageId, stageSlug: stage.stageSlug } : null;
}

async function writeFieldValues(opts: {
	tx: Db;
	tenantId: number;
	leadId: number;
	stageId: number;
	fields: Record<string, unknown>;
	now: number;
}): Promise<void> {
	const entries = Object.entries(opts.fields).filter(([slug]) => slug.trim());
	if (entries.length === 0) return;
	const defs = await opts.tx
		.select({
			id: stageFields.id,
			slug: stageFields.slug,
			displayName: stageFields.displayName,
		})
		.from(stageFields)
		.where(
			and(
				eq(stageFields.tenantId, opts.tenantId),
				eq(stageFields.stageId, opts.stageId),
			),
		);
	if (defs.length === 0) return;
	const byKey = new Map<string, number>();
	for (const field of defs) {
		byKey.set(normalizeText(field.slug), field.id);
		byKey.set(normalizeText(field.displayName), field.id);
	}
	for (const [slug, value] of entries) {
		const fieldId = byKey.get(normalizeText(slug));
		if (!fieldId) continue;
		await opts.tx
			.insert(leadFieldValues)
			.values({
				tenantId: opts.tenantId,
				leadId: opts.leadId,
				fieldId,
				valueJson: JSON.stringify(value),
				updatedAt: opts.now,
			})
			.onConflictDoUpdate({
				target: [leadFieldValues.leadId, leadFieldValues.fieldId],
				set: { valueJson: JSON.stringify(value), updatedAt: opts.now },
			});
	}
}

function buildIntake(input: {
	item: CatalogRow;
	match: ServiceRequestMatch;
	text: string;
	inbound?: Inbound;
	conversationId: number | null;
}): Record<string, unknown> {
	return {
		source: "service_catalog_runtime",
		serviceCatalogItemId: input.item.id,
		serviceSlug: input.item.slug,
		serviceName: input.item.name,
		routeType: input.item.routeType,
		requestType: input.match.requestType,
		confidence: input.match.confidence,
		matchSource: input.match.source,
		fields: input.match.fields,
		note: input.match.note ?? null,
		conversationId: input.conversationId,
		externalMessageId: input.inbound?.externalMessageId ?? null,
		text: input.text.slice(0, 1000),
	};
}

function requestTypeForCatalogItem(item: CatalogMatchInput): string {
	return (
		inferServiceKind(item) ??
		(normalizeSlug(item.slug || item.name) || "service")
	);
}

function inferServiceKind(item: CatalogMatchInput): string | null {
	const value = normalizeText(
		`${item.slug} ${item.name} ${item.category ?? ""} ${item.description ?? ""}`,
	);
	for (const [kind, words] of Object.entries(SERVICE_SYNONYMS)) {
		if (words.some((word) => value.includes(normalizeText(word)))) return kind;
	}
	return null;
}

function importantTokens(item: CatalogMatchInput): string[] {
	const tokens = normalizeText(
		`${item.slug} ${item.name} ${item.category ?? ""}`,
	)
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 4 && !GENERIC_WORDS.has(token));
	return [...new Set(tokens)];
}

function dedupeMatches(matches: ServiceRequestMatch[]): ServiceRequestMatch[] {
	const byRequestType = new Map<string, ServiceRequestMatch>();
	for (const match of matches) {
		const prev = byRequestType.get(match.requestType);
		if (!prev || match.confidence > prev.confidence) {
			byRequestType.set(match.requestType, match);
		}
	}
	return [...byRequestType.values()]
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 8);
}

function readMetadata(value: string | undefined | null): {
	requiredFields?: string[];
	handoffMode?: string;
	handoffUrl?: string;
} {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as {
			requiredFields?: unknown;
			handoffMode?: unknown;
			handoffUrl?: unknown;
		};
		return {
			...(Array.isArray(parsed.requiredFields)
				? {
						requiredFields: parsed.requiredFields.filter(
							(v): v is string => typeof v === "string",
						),
					}
				: {}),
			...(typeof parsed.handoffMode === "string"
				? { handoffMode: parsed.handoffMode }
				: {}),
			...(typeof parsed.handoffUrl === "string"
				? { handoffUrl: parsed.handoffUrl }
				: {}),
		};
	} catch {
		return {};
	}
}

function readHandoffMode(
	item: CatalogRow,
): "fire_and_forget" | "await_callback" {
	const meta = readMetadata(item.metadataJson);
	const notes = readMetadata(item.partnerServiceNotes);
	const mode = meta.handoffMode ?? notes.handoffMode;
	return mode === "await_callback" ? "await_callback" : "fire_and_forget";
}

function readHandoffUrl(item: CatalogRow): string | null {
	const meta = readMetadata(item.metadataJson);
	const notes = readMetadata(item.partnerServiceNotes);
	return meta.handoffUrl ?? notes.handoffUrl ?? null;
}

function parseRouteType(value: string): ServiceCatalogRouteType | null {
	if (
		value === "manual" ||
		value === "funnel" ||
		value === "partner_service" ||
		value === "webhook"
	) {
		return value;
	}
	return null;
}

function parseJsonObject(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSlug(value: string): string {
	return normalizeText(value)
		.replace(/[^a-z0-9а-яё]+/gi, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/ё/g, "е")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}
