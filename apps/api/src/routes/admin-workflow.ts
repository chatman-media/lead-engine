import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { skills } from "@chatman-media/storage";
import {
	ACTIVE_PHASES,
	type ActivePhase,
	deriveDefaultPhase,
	isActivePhase,
} from "@chatman-media/verticals";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { SKILLS_CATALOGUE } from "../lib/skills-catalogue.ts";
import { buildFunnelBuilderSystemPrompt } from "../prompts/admin-workflow.ts";
import {
	applyFunnelStages,
	FIELD_TYPES,
	normalizeSeedStageConfigJson,
	type SeedStage,
	STAGE_KINDS,
	STAGE_TYPES,
	seedSkillsCatalogue,
	validateFunnel,
} from "./admin-funnel.ts";

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

export const SYSTEM_PROMPT = buildFunnelBuilderSystemPrompt({
	stageKinds: STAGE_KINDS,
	stageTypes: STAGE_TYPES,
	activePhases: ACTIVE_PHASES,
	fieldTypes: FIELD_TYPES,
});

const MAX_TURNS = 60;

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
			return c.json({
				reply,
				readyToGenerate: true,
				stages,
				preview,
				backbone,
			});
		}

		return c.json({ reply: reply || raw.trim(), readyToGenerate: false });
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
					note: "Before applying AI-generated funnel",
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
