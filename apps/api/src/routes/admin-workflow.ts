import type { Db } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import {
	applyFunnelStages,
	FIELD_TYPES,
	type SeedStage,
	STAGE_KINDS,
	STAGE_TYPES,
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

const SYSTEM_PROMPT = `Ты — помощник по настройке воронки продаж/квалификации в SaaS-платформе lead-engine.
Оператор описывает свой бизнес, а ты проектируешь воронку (funnel) из стадий и полей.

ВЕДИ ДИАЛОГ: задавай по одному уточняющему вопросу за раз, пока не соберёшь достаточно
информации для полной воронки. Узнай: чем занимается бизнес, как приходят клиенты, какие
данные нужно собрать, какие этапы проходит сделка, что считается успехом/провалом.
Не задавай больше вопросов, чем нужно — как только картина ясна, генерируй воронку.

ФОРМАТ ОТВЕТА: всегда возвращай ТОЛЬКО JSON-объект (без markdown, без префиксов):

Пока собираешь информацию:
{"reply": "твой вопрос оператору", "readyToGenerate": false}

Когда готов сгенерировать воронку:
{"reply": "краткое описание воронки для оператора", "readyToGenerate": true, "stages": [...]}

СХЕМА stages (массив стадий по порядку):
{
  "slug": "snake_case, только a-z 0-9 _",
  "displayName": "Название на языке оператора",
  "kind": один из ${JSON.stringify(STAGE_KINDS)},
  "stageType": один из ${JSON.stringify(STAGE_TYPES)},
  "color": "#hex (опционально)",
  "supportMode": true|false (true = бот замолкает, работает оператор; опц.),
  "nextStages": ["slug", ...] — в какие стадии можно перейти (терминальные = []),
  "autoAdvanceCondition": "{\\"type\\":\\"all_required_fields_filled\\"}" (опц., для авто-перехода),
  "fields": [
    {
      "slug": "snake_case",
      "displayName": "Название поля",
      "fieldType": один из ${JSON.stringify(FIELD_TYPES)},
      "required": true|false,
      "aiExtractable": true|false (true = бот извлекает из переписки сам),
      "hint": "подсказка для извлечения (опц.)",
      "options": ["вариант1", "вариант2"] (ТОЛЬКО для select/multiselect)
    }
  ]
}

ПРАВИЛА:
- Ровно одна стадия с kind "intake" (первый контакт), хотя бы одна "terminal_won" и одна "terminal_lost".
- slug'и уникальны; nextStages ссылаются только на существующие slug'и.
- Поля, которые бот может вытащить из диалога (имя, сумма, тип), помечай aiExtractable: true.
- Используй короткие воронки (4–8 стадий) — не усложняй.`;

const MAX_TURNS = 60;

interface FieldDraft {
	slug: string;
	displayName: string;
	fieldType: string;
	required?: boolean;
	aiExtractable?: boolean;
	hint?: string;
	options?: string[];
}
interface StageDraft {
	slug: string;
	displayName: string;
	kind: string;
	stageType: string;
	color?: string;
	supportMode?: boolean;
	nextStages?: string[];
	autoAdvanceCondition?: string;
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
 * Нормализует и валидирует драфт стадий от LLM в SeedStage[].
 * Отбрасывает невалидные значения, проставляет позиции, чинит nextStages.
 */
function normalizeStages(draft: StageDraft[]): SeedStage[] {
	const validKind = new Set<string>(STAGE_KINDS);
	const validStageType = new Set<string>(STAGE_TYPES);
	const validFieldType = new Set<string>(FIELD_TYPES);

	const stages: SeedStage[] = [];
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

		const fields: SeedStage["fields"] = [];
		const draftFields = d.fields ?? [];
		for (let j = 0; j < draftFields.length; j++) {
			const f = draftFields[j];
			if (!f || typeof f.slug !== "string" || typeof f.displayName !== "string")
				continue;
			const fslug = sanitizeSlug(f.slug);
			if (!fslug) continue;
			const fieldType = validFieldType.has(f.fieldType) ? f.fieldType : "text";
			const optionsJson =
				(fieldType === "select" || fieldType === "multiselect") &&
				Array.isArray(f.options)
					? JSON.stringify(
							f.options.map((o) => ({
								value: sanitizeSlug(String(o)) || String(o),
								label: String(o),
							})),
						)
					: undefined;
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

		stages.push({
			slug,
			displayName: d.displayName,
			kind,
			stageType,
			position: i,
			...(typeof d.color === "string" ? { color: d.color } : {}),
			...(d.supportMode === true ? { supportMode: true } : {}),
			nextStages: Array.isArray(d.nextStages)
				? d.nextStages.map(sanitizeSlug).filter(Boolean)
				: [],
			...(typeof d.autoAdvanceCondition === "string"
				? { autoAdvanceCondition: d.autoAdvanceCondition }
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
				numPredict: 2000,
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

		const jsonStr = raw.replace(/```(?:json)?\n?/g, "").trim();
		let parsed: {
			reply?: unknown;
			readyToGenerate?: unknown;
			stages?: unknown;
		};
		try {
			parsed = JSON.parse(jsonStr) as typeof parsed;
		} catch {
			// LLM не вернул JSON — отдаём текст как реплику, продолжаем диалог.
			return c.json({ reply: raw.trim(), readyToGenerate: false });
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
			return c.json({ reply, readyToGenerate: true, stages, preview });
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

		const result = await applyFunnelStages(
			opts.db,
			tenantId,
			stages,
			"ai_workflow",
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "funnel.ai_apply",
			targetKind: "funnel",
			targetId: String(result.funnelId),
			details: { stagesCreated: result.stagesCreated },
		});

		return c.json({ ok: true, stageCount: result.stagesCreated });
	});

	return app;
}
