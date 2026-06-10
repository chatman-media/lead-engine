import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { skills } from "@chatman-media/storage";
import {
	type ActivePhase,
	defaultRegistry,
	deriveDefaultPhase,
	isActivePhase,
	validateBackbone,
} from "@chatman-media/verticals";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { SKILLS_CATALOGUE } from "../lib/skills-catalogue.ts";
import {
	applyFunnelStages,
	FIELD_TYPES,
	normalizeSeedStageConfigJson,
	parseAutoAdvanceConditionType,
	type SeedStage,
	STAGE_KINDS,
	STAGE_TYPES,
	seedSkillsCatalogue,
	stageWorkflowTransitions,
} from "./admin-funnel.ts";
import { buildWorkflowFunnelSystemPrompt } from "./funnel-builder-prompt.ts";

/**
 * AI Workflow Builder — оператор описывает свой бизнес в диалоге с AI,
 * AI задаёт уточняющие вопросы и в итоге генерирует воронку из
 * стандартных стадий/полей. Заменяет ручное конфигурирование funnel'а.
 *
 * POST /api/admin/workflows/ai-chat — многоходовой диалог
 * POST /api/admin/workflows/apply   — применить сгенерированную воронку
 */

export interface AdminWorkflowRoutesOpts {
	db: Db;
	/** Tenant chat LLM. Если отсутствует — ai-chat вернёт 503. */
	resolveChat?: (tenantId: number) => ChatClient;
}

type ChatTurn = { role: "user" | "assistant"; content: string };

export const SYSTEM_PROMPT = buildWorkflowFunnelSystemPrompt();

const MAX_TURNS = 60;

const VERTICAL_KEYWORDS: Record<string, readonly string[]> = {
	concierge_v1: [
		"concierge",
		"консьерж",
		"вилла",
		"villa",
		"guest",
		"гость",
		"гости",
		"трансфер",
		"уборк",
		"еда",
		"экскурс",
		"сервис",
	],
	exchange_v1: [
		"exchange",
		"обмен",
		"крипт",
		"crypto",
		"usdt",
		"btc",
		"eth",
		"rub",
		"thb",
		"бат",
		"курс",
		"налич",
		"cash",
	],
	modeling_v1: [
		"modeling",
		"модель",
		"models",
		"кастинг",
		"casting",
		"портфолио",
		"portfolio",
	],
	real_estate_v1: [
		"real estate",
		"недвиж",
		"property",
		"apartment",
		"condo",
		"квартира",
		"апартамент",
		"дом",
		"аренда",
		"купить",
		"риелтор",
	],
	recruitment_v1: [
		"recruitment",
		"рекрут",
		"hiring",
		"найм",
		"candidate",
		"кандидат",
		"ваканс",
		"job",
		"работа",
	],
	saas_v1: [
		"saas",
		"software",
		"сервис",
		"подписк",
		"demo",
		"демо",
		"b2b",
		"crm",
		"лиценз",
	],
	scooter_v1: [
		"scooter",
		"скутер",
		"байк",
		"bike",
		"мото",
		"аренда",
		"rental",
		"helmet",
		"шлем",
	],
	video_v1: [
		"video",
		"видео",
		"production",
		"продакшн",
		"съем",
		"съём",
		"монтаж",
		"ролик",
		"контент",
	],
	visa_v1: [
		"visa",
		"виза",
		"immigration",
		"иммиграц",
		"документ",
		"шенген",
		"uae",
		"thailand",
		"тайланд",
	],
};

export interface VerticalSuggestion {
	slug: string;
	displayName: string;
	confidence: number;
	reason: string;
	funnelSeedKey: string | null;
	hasStyles: boolean;
	hasKbDocuments: boolean;
}

interface FieldDraft {
	slug: string;
	displayName: string;
	fieldType: string;
	required?: boolean;
	aiExtractable?: boolean;
	hint?: string;
	options?: Array<string | { value: string; label: string }>;
	optionsJson?: string;
}
export interface StageDraft {
	slug: string;
	displayName: string;
	kind: string;
	stageType: string;
	phase?: string;
	color?: string;
	supportMode?: boolean;
	nextStages?: string[];
	autoAdvanceCondition?: string;
	configJson?: string | Record<string, unknown>;
	goal?: string;
	guidance?: string;
	fields?: FieldDraft[];
}

function normalizeSearchText(s: string): string {
	return s
		.toLowerCase()
		.replace(/ё/g, "е")
		.replace(/[^a-zа-я0-9_+\s.-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function collectVerticalMatches(description: string, slug: string): string[] {
	const text = normalizeSearchText(description);
	if (!text) return [];
	const keywords = VERTICAL_KEYWORDS[slug] ?? [];
	const matches = new Set<string>();
	for (const keyword of keywords) {
		const normalizedKeyword = normalizeSearchText(keyword);
		if (normalizedKeyword && text.includes(normalizedKeyword)) {
			matches.add(keyword);
		}
	}
	const normalizedSlug = slug.replace(/_v\d+$/, "").replace(/_/g, " ");
	if (text.includes(normalizedSlug)) matches.add(normalizedSlug);
	return [...matches];
}

export function suggestVerticalFromDescription(
	description: string,
	opts: { limit?: number } = {},
): VerticalSuggestion[] {
	const limit = Math.max(1, opts.limit ?? 3);
	return defaultRegistry
		.list()
		.map((slug) => {
			const template = defaultRegistry.tryLoad(slug);
			if (!template) return null;
			const matches = collectVerticalMatches(description, slug);
			if (matches.length === 0) return null;
			const confidence = Math.min(0.95, 0.35 + matches.length * 0.12);
			return {
				slug: template.slug,
				displayName: template.displayName,
				confidence: Number(confidence.toFixed(2)),
				reason: `Совпали признаки: ${matches.slice(0, 4).join(", ")}`,
				funnelSeedKey: template.funnelSeedKey ?? null,
				hasStyles: (template.styles?.length ?? 0) > 0,
				hasKbDocuments:
					(template.kbDocuments?.length ?? 0) > 0 ||
					(template.kbSeedFiles?.length ?? 0) > 0,
			} satisfies VerticalSuggestion;
		})
		.filter((item): item is VerticalSuggestion => Boolean(item))
		.sort(
			(a, b) =>
				b.confidence - a.confidence ||
				a.displayName.localeCompare(b.displayName, "ru"),
		)
		.slice(0, limit);
}

function sanitizeSlug(s: string): string {
	return String(s)
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 48);
}

/**
 * select/multiselect → optionsJson [{value,label}]. Пробрасывает уже готовый
 * optionsJson (re-apply на /apply — иначе значения опций, важные для
 * маршрутизации request_type, терялись бы); options принимает строки или
 * объекты {value,label}. value всегда латинский snake_case (slug ветки).
 */
function normalizeOptions(
	fieldType: string,
	f: FieldDraft,
): string | undefined {
	if (fieldType !== "select" && fieldType !== "multiselect") return undefined;
	if (typeof f.optionsJson === "string" && f.optionsJson.trim())
		return f.optionsJson;
	if (!Array.isArray(f.options)) return undefined;
	return JSON.stringify(
		f.options.map((o) =>
			o && typeof o === "object"
				? {
						value: sanitizeSlug(String(o.value)) || String(o.value),
						label: String(o.label ?? o.value),
					}
				: { value: sanitizeSlug(String(o)) || String(o), label: String(o) },
		),
	);
}

function shouldInferAutoAdvanceCondition(opts: {
	kind: SeedStage["kind"];
	stageType: string;
	supportMode: boolean;
	nextStages: string[];
	fields: SeedStage["fields"];
	hasExplicitCondition: boolean;
}): boolean {
	if (opts.hasExplicitCondition) return false;
	if (opts.kind === "terminal_won" || opts.kind === "terminal_lost")
		return false;
	if (opts.stageType === "awaiting_operator" || opts.supportMode) return false;
	if (opts.nextStages.length === 0) return false;
	return opts.fields.some((field) => field.required);
}

/**
 * Нормализует и валидирует драфт стадий от LLM в SeedStage[].
 * Отбрасывает невалидные значения, проставляет позиции, чинит nextStages.
 */
export function normalizeStages(draft: StageDraft[]): SeedStage[] {
	const validKind = new Set<string>(STAGE_KINDS);
	const validStageType = new Set<string>(STAGE_TYPES);
	const validFieldType = new Set<string>(FIELD_TYPES);

	const stages: SeedStage[] = [];
	let prevPhase: ActivePhase | null = null;
	for (let i = 0; i < draft.length; i++) {
		const d = draft[i];
		if (!d || typeof d.slug !== "string" || typeof d.displayName !== "string")
			continue;
		const slug = sanitizeSlug(d.slug);
		if (!slug) continue;
		const kind = validKind.has(d.kind)
			? (d.kind as SeedStage["kind"])
			: "active";
		const stageType = validStageType.has(d.stageType)
			? d.stageType
			: "form_fill";
		const phase: ActivePhase | undefined =
			kind === "active"
				? isActivePhase(d.phase)
					? d.phase
					: deriveDefaultPhase(stageType, prevPhase)
				: undefined;
		if (phase) prevPhase = phase;

		const fields: SeedStage["fields"] = [];
		const draftFields = d.fields ?? [];
		for (let j = 0; j < draftFields.length; j++) {
			const f = draftFields[j];
			if (!f || typeof f.slug !== "string" || typeof f.displayName !== "string")
				continue;
			const fslug = sanitizeSlug(f.slug);
			if (!fslug) continue;
			const fieldType = validFieldType.has(f.fieldType) ? f.fieldType : "text";
			const optionsJson = normalizeOptions(fieldType, f);
			fields.push({
				slug: fslug,
				displayName: f.displayName,
				fieldType,
				required: f.required === true,
				aiExtractable: f.aiExtractable === true,
				...(typeof f.hint === "string" ? { hint: f.hint } : {}),
				...(optionsJson ? { optionsJson } : {}),
				position: j,
			});
		}

		const nextStages = Array.isArray(d.nextStages)
			? d.nextStages.map(sanitizeSlug).filter(Boolean)
			: [];
		const supportMode = d.supportMode === true;
		const hasExplicitCondition =
			typeof d.autoAdvanceCondition === "string" &&
			d.autoAdvanceCondition.trim().length > 0;
		const autoAdvanceCondition = hasExplicitCondition
			? d.autoAdvanceCondition
			: shouldInferAutoAdvanceCondition({
						kind,
						stageType,
						supportMode,
						nextStages,
						fields,
						hasExplicitCondition,
					})
				? JSON.stringify({ type: "all_required_fields_filled" })
				: undefined;
		const configJson = normalizeSeedStageConfigJson({
			configJson: d.configJson,
			nextStages,
			autoAdvanceCondition,
			fields,
		});

		stages.push({
			slug,
			displayName: d.displayName,
			kind,
			stageType,
			...(phase ? { phase } : {}),
			position: i,
			...(typeof d.color === "string" ? { color: d.color } : {}),
			...(supportMode ? { supportMode: true } : {}),
			nextStages,
			...(autoAdvanceCondition ? { autoAdvanceCondition } : {}),
			...(configJson !== "{}" ? { configJson } : {}),
			...(typeof d.goal === "string" && d.goal.trim()
				? { goal: d.goal.slice(0, 500) }
				: {}),
			...(typeof d.guidance === "string" && d.guidance.trim()
				? { guidance: d.guidance.slice(0, 1000) }
				: {}),
			fields,
		});
	}

	// Чиним nextStages: оставляем только ссылки на существующие slug'и.
	const known = new Set(stages.map((s) => s.slug));
	for (const s of stages) {
		s.nextStages = s.nextStages.filter((n) => known.has(n) && n !== s.slug);
	}
	return stages;
}

/**
 * Контракт мульти-запроса (ветвление по request_type): если intake имеет
 * select-поле request_type, каждое его значение <X> обязано иметь ветку,
 * достижимую из intake (стадия <X>_request / любой <X>_*) — иначе рантайм
 * (field-extractor.selectNextStage) не сможет увести лид в нужную ветку.
 * Для линейных воронок (нет поля request_type) — пусто.
 */
export function multiRequestBranchErrors(stages: SeedStage[]): string[] {
	const errors: string[] = [];
	const intake = stages.find((s) => s.kind === "intake");
	if (!intake) return errors;
	const rt = intake.fields.find((f) => f.slug === "request_type");
	if (!rt) return errors; // линейная воронка — не мульти-запрос
	let values: string[] = [];
	if (rt.optionsJson) {
		try {
			values = (JSON.parse(rt.optionsJson) as Array<{ value?: unknown }>)
				.map((o) => String(o.value ?? ""))
				.filter(Boolean);
		} catch {
			// невалидный optionsJson — отдадим «нет опций» ниже
		}
	}
	if (values.length === 0) {
		errors.push(
			"Мультизапрос: у поля request_type на intake нет валидных опций.",
		);
		return errors;
	}
	const next = intake.nextStages ?? [];
	for (const v of values) {
		const hasBranch = next.some(
			(n) => n === `${v}_request` || n.startsWith(`${v}_`),
		);
		if (!hasBranch)
			errors.push(
				`Мультизапрос: для типа "${v}" нет ветки — добавь стадию "${v}_request" и укажи её в nextStages intake.`,
			);
	}
	return errors;
}

/** validateBackbone + контракт мульти-запроса — общий gate для AI-builder. */
export function validateFunnel(stages: SeedStage[]): {
	errors: string[];
	warnings: string[];
} {
	const base = validateBackbone(stages);
	return {
		errors: [...base.errors, ...multiRequestBranchErrors(stages)],
		warnings: [...base.warnings, ...workflowBehaviorWarnings(stages)],
	};
}

export function workflowBehaviorWarnings(stages: SeedStage[]): string[] {
	const warnings: string[] = [];
	for (const stage of stages) {
		if (stage.kind !== "active") continue;
		if (!stage.goal?.trim()) {
			warnings.push(`Стадия "${stage.slug}": нет goal — добавь цель стадии.`);
		}
		if (!stage.guidance?.trim()) {
			warnings.push(
				`Стадия "${stage.slug}": нет guidance — добавь правила диалога и следующий вопрос/CTA.`,
			);
		}
		if (stage.nextStages.length === 0) {
			warnings.push(
				`Стадия "${stage.slug}": нет nextStages — стадия не знает следующий шаг.`,
			);
		}
		const hasExecutableExit =
			stageWorkflowTransitions(stage.configJson).length > 0 ||
			parseAutoAdvanceConditionType(stage.autoAdvanceCondition) ===
				"all_required_fields_filled" ||
			stage.stageType === "awaiting_operator" ||
			stage.supportMode === true;
		if (!hasExecutableExit && stage.nextStages.length > 0) {
			warnings.push(
				`Стадия "${stage.slug}": нет transition/exit rule — добавь autoAdvanceCondition или configJson.workflow.transitions.`,
			);
		}
	}
	return [...new Set(warnings)];
}

function validationReply(reply: string, errors: string[]): string {
	const intro =
		reply.trim() ||
		"Воронка почти готова, но её нужно поправить перед применением.";
	const bullets = errors.map((error) => `- ${error}`).join("\n");
	return `${intro}\n\nОшибки воронки:\n${bullets}`;
}

/** true, если модель явно пыталась вернуть JSON воронки, а не текст-реплику. */
function looksLikeFunnelJson(raw: string): boolean {
	return /"(?:readyToGenerate|stages)"\s*:/.test(raw);
}

export function makeAdminWorkflowRoutes(opts: AdminWorkflowRoutesOpts): Hono {
	const app = new Hono();

	/**
	 * POST /api/admin/workflows/ai-chat
	 * Body: { messages: Array<{role:"user"|"assistant", content:string}> }
	 * Returns: { reply, readyToGenerate, stages? }
	 */
	app.post("/api/admin/workflows/ai-chat", async (c) => {
		if (!opts.resolveChat) {
			return c.json({ error: "LLM not configured for this tenant" }, 503);
		}
		const tenantId = c.var.tenantId;

		let body: { messages?: unknown };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return c.json({ error: "messages array required" }, 400);
		}
		const turns: ChatTurn[] = [];
		for (const m of body.messages as Array<{
			role?: unknown;
			content?: unknown;
		}>) {
			if (
				(m.role === "user" || m.role === "assistant") &&
				typeof m.content === "string"
			) {
				turns.push({ role: m.role, content: m.content.slice(0, 4000) });
			}
		}
		if (turns.length === 0) return c.json({ error: "no valid messages" }, 400);
		if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
		const verticalSuggestions = suggestVerticalFromDescription(
			turns
				.filter((turn) => turn.role === "user")
				.map((turn) => turn.content)
				.join("\n"),
		);

		let client: ChatClient;
		try {
			client = opts.resolveChat(tenantId);
		} catch {
			return c.json({ error: "LLM not configured for this tenant" }, 503);
		}

		const llmMessages: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			...turns.map(
				(t) => ({ role: t.role, content: t.content }) as ChatMessage,
			),
		];

		let raw: string;
		try {
			raw = await client.complete(llmMessages, {
				numPredict: 4000,
				temperature: 0.4,
			});
		} catch (err) {
			return c.json(
				{
					error: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
				},
				502,
			);
		}

		const stripFence = (s: string) => s.replace(/```(?:json)?\n?/g, "").trim();
		type Parsed = {
			reply?: unknown;
			readyToGenerate?: unknown;
			stages?: unknown;
		};
		const tryParse = (s: string): Parsed | null => {
			try {
				const v = JSON.parse(stripFence(s));
				return v && typeof v === "object" ? (v as Parsed) : null;
			} catch {
				return null;
			}
		};

		let parsed = tryParse(raw);

		// Битый JSON (модель пыталась собрать воронку, но синтаксис сломан) —
		// один retry с просьбой переотдать строго валидный JSON.
		if (!parsed && looksLikeFunnelJson(raw)) {
			try {
				const retryRaw = await client.complete(
					[
						...llmMessages,
						{ role: "assistant", content: raw },
						{
							role: "user",
							content:
								"Твой прошлый ответ — невалидный JSON. Верни ТОЛЬКО корректный " +
								"JSON-объект по схеме: без markdown-обёрток и без текста вне JSON.",
						},
					],
					{ numPredict: 4000, temperature: 0.2 },
				);
				parsed = tryParse(retryRaw);
			} catch {
				// LLM упал на retry — уходим в дружелюбный fallback ниже.
			}
		}

		if (!parsed) {
			// Стоп-течь: не показываем сырой (битый) JSON пользователю. Если это была
			// JSON-попытка — просим переформулировать; иначе это текст-реплика модели.
			return c.json({
				reply: looksLikeFunnelJson(raw)
					? "Не получилось собрать воронку из ответа — переформулируйте запрос или попробуйте ещё раз."
					: raw.trim(),
				readyToGenerate: false,
				verticalSuggestions,
			});
		}
		// Слабые модели (напр. gpt-4.1-nano) иногда вкладывают весь JSON воронки
		// строкой в поле `reply`. Разворачиваем вложенность до реального объекта.
		let unwrapGuard = 0;
		while (
			parsed.readyToGenerate !== true &&
			typeof parsed.reply === "string" &&
			unwrapGuard < 3
		) {
			const inner = tryParse(parsed.reply);
			if (
				inner &&
				(typeof inner.readyToGenerate === "boolean" ||
					Array.isArray(inner.stages))
			) {
				parsed = inner;
				unwrapGuard += 1;
			} else break;
		}

		const reply = typeof parsed.reply === "string" ? parsed.reply : "";
		const ready = parsed.readyToGenerate === true;
		if (ready && Array.isArray(parsed.stages)) {
			const stages = normalizeStages(parsed.stages as StageDraft[]);
			if (stages.length === 0) {
				return c.json({
					reply: reply || "Не удалось собрать воронку, уточните детали.",
					readyToGenerate: false,
					verticalSuggestions,
				});
			}
			// Preview-форма для UI: компактная.
			const preview = stages.map((s) => ({
				slug: s.slug,
				displayName: s.displayName,
				kind: s.kind,
				stageType: s.stageType,
				supportMode: s.supportMode ?? false,
				nextStages: s.nextStages,
				fields: s.fields.map((f) => ({
					slug: f.slug,
					displayName: f.displayName,
					fieldType: f.fieldType,
					required: f.required,
					aiExtractable: f.aiExtractable,
				})),
			}));
			const backbone = validateFunnel(stages);
			if (backbone.errors.length > 0) {
				return c.json({
					reply: validationReply(reply, backbone.errors),
					readyToGenerate: false,
					stages,
					preview,
					backbone,
					verticalSuggestions,
				});
			}
			return c.json({
				reply,
				readyToGenerate: true,
				stages,
				preview,
				backbone,
				verticalSuggestions,
			});
		}

		return c.json({
			reply: reply || raw.trim(),
			readyToGenerate: false,
			verticalSuggestions,
		});
	});

	/**
	 * POST /api/admin/workflows/suggest-vertical
	 * Body: { description } — deterministic hint for installing a ready template.
	 */
	app.post("/api/admin/workflows/suggest-vertical", async (c) => {
		let body: { description?: unknown };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const description =
			typeof body.description === "string" ? body.description.trim() : "";
		if (!description) return c.json({ error: "description required" }, 400);
		return c.json({
			suggestions: suggestVerticalFromDescription(description),
		});
	});

	/**
	 * POST /api/admin/workflows/apply
	 * Body: { stages: SeedStage[] }  — нормализованные стадии из ai-chat
	 * Заменяет активную воронку тенанта.
	 */
	app.post("/api/admin/workflows/apply", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;

		let body: { stages?: unknown };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!Array.isArray(body.stages) || body.stages.length === 0) {
			return c.json({ error: "stages array required" }, 400);
		}

		// Повторно нормализуем на сервере — клиенту не доверяем.
		const stages = normalizeStages(body.stages as StageDraft[]);
		if (stages.length === 0) return c.json({ error: "no valid stages" }, 400);

		const backbone = validateFunnel(stages);
		if (backbone.errors.length > 0) {
			return c.json(
				{
					error: "Воронка не соответствует костяку",
					violations: backbone.errors,
				},
				400,
			);
		}

		const result = await applyFunnelStages(
			opts.db,
			tenantId,
			stages,
			"ai_workflow",
			{
				snapshot: {
					source: "ai_apply",
					adminId,
					note: "before AI workflow apply",
				},
			},
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "funnel.ai_apply",
			targetKind: "funnel",
			targetId: String(result.funnelId),
			details: {
				stagesCreated: result.stagesCreated,
				warnings: backbone.warnings,
			},
		});

		return c.json({
			ok: true,
			stageCount: result.stagesCreated,
			warnings: backbone.warnings,
		});
	});

	/**
	 * POST /api/admin/workflows/recommend-skills
	 * Body: { description } — AI выбирает уместные техники убеждения из каталога
	 * (SKILLS_CATALOGUE) под бизнес, ставит каталог тенанту и включает только
	 * рекомендованные (остальные выключает). Phase 2 slice D.
	 */
	app.post("/api/admin/workflows/recommend-skills", async (c) => {
		if (!opts.resolveChat) {
			return c.json({ error: "LLM not configured for this tenant" }, 503);
		}
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;

		let body: { description?: unknown };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.description !== "string" || !body.description.trim()) {
			return c.json({ error: "description required" }, 400);
		}
		const description = body.description.slice(0, 4000);

		const catalogue = SKILLS_CATALOGUE.map(
			(s) => `- ${s.slug}: ${s.description}`,
		).join("\n");
		const prompt = `Ты подбираешь техники убеждения (skills) для AI-бота под конкретный бизнес.
Каталог техник (slug — описание):
${catalogue}

Бизнес: ${description}

Верни ТОЛЬКО JSON: {"slugs": ["slug", ...]} — 5-10 наиболее уместных техник ИМЕННО для этого бизнеса. Только slug'и из каталога, без выдумок.`;

		let client: ChatClient;
		try {
			client = opts.resolveChat(tenantId);
		} catch {
			return c.json({ error: "LLM not configured for this tenant" }, 503);
		}

		let raw: string;
		try {
			raw = await client.complete([{ role: "user", content: prompt }], {
				numPredict: 400,
				temperature: 0.3,
			});
		} catch (err) {
			return c.json(
				{
					error: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
				},
				502,
			);
		}

		const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
		let parsed: { slugs?: unknown };
		try {
			parsed = JSON.parse(jsonStr) as typeof parsed;
		} catch {
			return c.json({ error: "LLM returned non-JSON response", raw }, 502);
		}

		const known = new Set(SKILLS_CATALOGUE.map((s) => s.slug));
		const recommended = Array.isArray(parsed.slugs)
			? [
					...new Set(
						parsed.slugs.filter(
							(s): s is string => typeof s === "string" && known.has(s),
						),
					),
				]
			: [];
		if (recommended.length === 0) {
			return c.json({ error: "no valid skills recommended", raw }, 502);
		}

		// Ставим весь каталог (идемпотентно), затем включаем только рекомендованные.
		await seedSkillsCatalogue(opts.db, tenantId);
		const now = Math.floor(Date.now() / 1000);
		await withTenant(opts.db, tenantId, async (tx) => {
			await tx
				.update(skills)
				.set({ isEnabled: false, updatedAt: now })
				.where(eq(skills.tenantId, tenantId));
			await tx
				.update(skills)
				.set({ isEnabled: true, updatedAt: now })
				.where(
					and(eq(skills.tenantId, tenantId), inArray(skills.slug, recommended)),
				);
		});

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "skills.ai_recommend",
			targetKind: "skills",
			targetId: "catalogue",
			details: { enabled: recommended },
		});

		return c.json({
			ok: true,
			enabled: recommended,
			count: recommended.length,
		});
	});

	return app;
}
