import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { skills } from "@chatman-media/storage";
import {
	ACTIVE_PHASES,
	type ActivePhase,
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
	type SeedStage,
	STAGE_KINDS,
	STAGE_TYPES,
	seedSkillsCatalogue,
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

export const SYSTEM_PROMPT = `Ты — помощник по настройке воронки продаж/квалификации в SaaS-платформе lead-engine.
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
  "phase": один из ${JSON.stringify(ACTIVE_PHASES)} — макро-фаза для active-стадий (для intake/terminal НЕ указывай),
  "color": "#hex (опционально)",
  "supportMode": true|false (true = бот замолкает, работает оператор; опц.),
  "nextStages": ["slug", ...] — в какие стадии можно перейти (терминальные = []),
  "autoAdvanceCondition": "{\\"type\\":\\"all_required_fields_filled\\"}" (опц., для авто-перехода),
  "configJson": "{\\"workflow\\":{\\"transitions\\":[{\\"to\\":\\"next_stage_slug\\",\\"when\\":{\\"type\\":\\"all_required_fields_filled\\"},\\"priority\\":10}]}}" (опц.; для branching request_type transition можно без "to"),
  "goal": "что должна достичь active-стадия (кратко; для intake/terminal не нужно)",
  "guidance": "как боту вести себя на этой стадии (опц., 1-2 фразы)",
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
- Костяк воронки: capture (intake) → qualify → offer → [clear] → [fulfill] → won/lost.
  qualify = понять нужду и оценить сделку; offer = предложить условия и получить «да»;
  clear = гейты (KYC, документы, одобрения третьих сторон) — добавляй только если они реально есть;
  fulfill = исполнить/доставить и провести оплату — только если есть.
- Проставляй "phase" каждой active-стадии. Обязательны qualify и offer. Фазы идут по порядку, без возврата назад.
- terminal_won ставь после последней реальной фазы (нет fulfill/clear → сразу после offer).
- slug'и уникальны; nextStages ссылаются только на существующие slug'и.
- Поля, которые бот может вытащить из диалога (имя, сумма, тип), помечай aiExtractable: true.
- Для active-стадий заполняй "goal" (что сделать на стадии) и по возможности "guidance" (как вести диалог) под этот бизнес.
- В guidance явно зашивай следующий вопрос/CTA, exit criteria, handoff/SLA если они есть: стадия должна закрываться в следующий шаг, а не быть вечным чатом.
- Если стадия завершается заполнением обязательных fields — ставь autoAdvanceCondition all_required_fields_filled и workflow transition в configJson.workflow.transitions. Для request_type branching transition оставляй без "to", чтобы runtime выбрал ветку по request_type.
- Если на стадии условия/цену/решение даёт ЧЕЛОВЕК-оператор (не бот, не автоформула) — ставь stageType "awaiting_operator": бот придержит гостя и подождёт оператора, не выдумывая детали.
- Линейные воронки держи короткими (4–8 стадий) — не усложняй.

МУЛЬТИ-ЗАПРОС (один клиент ↔ несколько типов услуг):
- Если бизнес оказывает НЕСКОЛЬКО разных услуг, которые один клиент может запрашивать
  параллельно и повторно (консьерж, сервис-деск, мультисервис) — СПРОСИ об этом и, если да,
  построй ВЕТВЯЩУЮСЯ воронку:
  - intake-стадия с полем {"slug":"request_type","fieldType":"select","aiExtractable":true},
    options — латинские snake_case ключи услуг с локализованными подписями:
    [{"value":"transfer","label":"Трансфер"},{"value":"food","label":"Еда"}].
  - На КАЖДЫЙ ключ <X> — короткая ветка: <X>_request (phase qualify) → <X>_offer (phase offer)
    → <X>_fulfill (phase fulfill). slug ветки ОБЯЗАН начинаться с "<X>_" (тот же ключ), иначе
    маршрутизация по типу не сработает.
  - Все <X>_fulfill → одна общая terminal_won (напр. "completed"); intake и ветки → общая
    terminal_lost ("cancelled"). intake.nextStages = все <X>_request + терминал отказа.
  - Порядок: сперва все *_request (qualify), затем *_offer (offer), затем *_fulfill (fulfill),
    потом терминалы — иначе нарушишь монотонность фаз. Длина 1+3×N+2 — норма, лимит 4–8 не про них.

ПРИМЕРЫ (как из описания собрать качественную воронку — ориентируйся на них):

Пример 1 — линейная воронка.
Оператор: «Онлайн-школа английского. Люди пишут в Telegram, записываем на пробный урок, потом продаём пакет занятий».
Хороший ответ:
{"reply":"Собрал воронку: заявка → квалификация → пробный урок → оплата пакета. Терминалы: оплатил / отказ.","readyToGenerate":true,"stages":[
{"slug":"new_lead","displayName":"Новая заявка","kind":"intake","stageType":"form_fill","nextStages":["qualify","lost"],"fields":[{"slug":"name","displayName":"Имя","fieldType":"text","required":true,"aiExtractable":true},{"slug":"goal_level","displayName":"Цель и уровень","fieldType":"textarea","required":false,"aiExtractable":true}]},
{"slug":"qualify","displayName":"Квалификация","kind":"active","stageType":"form_fill","phase":"qualify","nextStages":["trial","lost"],"goal":"Понять цель обучения, уровень и бюджет ученика.","guidance":"Спроси про цель, текущий уровень и удобное время, по одному вопросу. Не дави, веди к пробному уроку.","fields":[{"slug":"budget","displayName":"Бюджет","fieldType":"text","required":false,"aiExtractable":true}]},
{"slug":"trial","displayName":"Пробный урок","kind":"active","stageType":"interaction","phase":"offer","nextStages":["payment","lost"],"goal":"Согласовать и провести пробный урок.","guidance":"Подбери удобные дату и время пробного, подтверди запись и напомни перед уроком.","fields":[{"slug":"trial_at","displayName":"Время пробного","fieldType":"text","required":true,"aiExtractable":true}]},
{"slug":"payment","displayName":"Оплата пакета","kind":"active","stageType":"payment","phase":"fulfill","nextStages":["won","lost"],"goal":"Продать пакет занятий и получить оплату.","guidance":"Предложи пакет под цель ученика, отработай возражения по цене, доведи до оплаты.","fields":[{"slug":"package","displayName":"Выбранный пакет","fieldType":"text","required":false,"aiExtractable":true}]},
{"slug":"won","displayName":"Оплатил","kind":"terminal_won","stageType":"milestone","nextStages":[],"fields":[]},
{"slug":"lost","displayName":"Отказ","kind":"terminal_lost","stageType":"milestone","nextStages":[],"fields":[]}
]}

Пример 2 — ветвящаяся воронка (мульти-запрос).
Оператор: «Сервис для туристов: помогаем с трансфером и с арендой байка. Один и тот же гость может заказать и то, и другое».
Хороший ответ:
{"reply":"Сделал ветвящуюся воронку: общий приём → ветки «трансфер» и «аренда байка» (qualify→offer→fulfill) → общий «выполнено» / «отменено».","readyToGenerate":true,"stages":[
{"slug":"request_received","displayName":"Запрос принят","kind":"intake","stageType":"form_fill","nextStages":["transfer_request","bike_request","cancelled"],"fields":[{"slug":"request_type","displayName":"Тип запроса","fieldType":"select","required":true,"aiExtractable":true,"hint":"Выбирает ветку воронки","options":[{"value":"transfer","label":"Трансфер"},{"value":"bike","label":"Аренда байка"}]}]},
{"slug":"transfer_request","displayName":"Трансфер: детали","kind":"active","stageType":"form_fill","phase":"qualify","nextStages":["transfer_offer","cancelled"],"goal":"Собрать маршрут и время трансфера.","guidance":"Уточни откуда, куда, когда и сколько человек. Цену пока не называй.","fields":[{"slug":"route","displayName":"Маршрут","fieldType":"text","required":true,"aiExtractable":true}]},
{"slug":"bike_request","displayName":"Байк: детали","kind":"active","stageType":"form_fill","phase":"qualify","nextStages":["bike_offer","cancelled"],"goal":"Собрать параметры аренды байка.","guidance":"Уточни модель/класс, срок аренды и дату начала.","fields":[{"slug":"days","displayName":"Срок аренды","fieldType":"text","required":true,"aiExtractable":true}]},
{"slug":"transfer_offer","displayName":"Трансфер: предложение","kind":"active","stageType":"awaiting_operator","phase":"offer","nextStages":["transfer_fulfill","cancelled"],"goal":"Передать цену трансфера и получить подтверждение.","guidance":"Цену даёт оператор — придержи гостя и дождись её, не выдумывай.","fields":[{"slug":"confirmed","displayName":"Гость подтвердил","fieldType":"boolean","required":true,"aiExtractable":true}]},
{"slug":"bike_offer","displayName":"Байк: предложение","kind":"active","stageType":"awaiting_operator","phase":"offer","nextStages":["bike_fulfill","cancelled"],"goal":"Передать цену аренды и получить подтверждение.","guidance":"Цену даёт оператор — дождись её и подтверди условия с гостем.","fields":[{"slug":"confirmed","displayName":"Гость подтвердил","fieldType":"boolean","required":true,"aiExtractable":true}]},
{"slug":"transfer_fulfill","displayName":"Трансфер: подача","kind":"active","stageType":"milestone","phase":"fulfill","nextStages":["completed","cancelled"],"goal":"Назначить водителя и подать авто.","guidance":"Сообщи гостю, что водитель назначен, держи в курсе подачи.","fields":[]},
{"slug":"bike_fulfill","displayName":"Байк: выдача","kind":"active","stageType":"milestone","phase":"fulfill","nextStages":["completed","cancelled"],"goal":"Выдать байк гостю.","guidance":"Согласуй место и время выдачи, подтверди передачу.","fields":[]},
{"slug":"completed","displayName":"Выполнено","kind":"terminal_won","stageType":"milestone","nextStages":[],"fields":[]},
{"slug":"cancelled","displayName":"Отменено","kind":"terminal_lost","stageType":"milestone","nextStages":[],"fields":[]}
]}`;

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
function normalizeOptions(fieldType: string, f: FieldDraft): string | undefined {
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseConditionType(raw?: string): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { type?: unknown };
		return typeof parsed.type === "string" ? parsed.type : null;
	} catch {
		return null;
	}
}

function parseStageConfigJson(
	raw: StageDraft["configJson"] | SeedStage["configJson"],
): Record<string, unknown> {
	if (typeof raw === "string" && raw.trim()) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return isJsonRecord(parsed) ? { ...parsed } : {};
		} catch {
			return {};
		}
	}
	return isJsonRecord(raw) ? { ...raw } : {};
}

function workflowTransitions(configJson?: string): unknown[] {
	const config = parseStageConfigJson(configJson);
	const workflow = config.workflow;
	if (!isJsonRecord(workflow) || !Array.isArray(workflow.transitions)) {
		return [];
	}
	return workflow.transitions;
}

function normalizeStageConfigJson(opts: {
	raw: StageDraft["configJson"];
	nextStages: string[];
	autoAdvanceCondition?: string;
	hasRequestTypeField: boolean;
}): string | undefined {
	const config = parseStageConfigJson(opts.raw);
	const workflow = isJsonRecord(config.workflow) ? { ...config.workflow } : {};
	if (
		!Array.isArray(workflow.transitions) &&
		parseConditionType(opts.autoAdvanceCondition) === "all_required_fields_filled" &&
		opts.nextStages.length > 0
	) {
		const transition: Record<string, unknown> = {
			when: { type: "all_required_fields_filled" },
			priority: 10,
		};
		if (!opts.hasRequestTypeField) transition.to = opts.nextStages[0];
		workflow.transitions = [transition];
		config.workflow = workflow;
	}
	return Object.keys(config).length > 0 ? JSON.stringify(config) : undefined;
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
	if (opts.kind === "terminal_won" || opts.kind === "terminal_lost") return false;
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
		const hasRequestTypeField = fields.some((field) => field.slug === "request_type");
		const configJson = normalizeStageConfigJson({
			raw: d.configJson,
			nextStages,
			autoAdvanceCondition,
			hasRequestTypeField,
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
			...(configJson ? { configJson } : {}),
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
		errors.push("Мультизапрос: у поля request_type на intake нет валидных опций.");
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
			workflowTransitions(stage.configJson).length > 0 ||
			parseConditionType(stage.autoAdvanceCondition) ===
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
		type Parsed = { reply?: unknown; readyToGenerate?: unknown; stages?: unknown };
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
			if (inner && (typeof inner.readyToGenerate === "boolean" || Array.isArray(inner.stages))) {
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
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "funnel.ai_apply",
			targetKind: "funnel",
			targetId: String(result.funnelId),
			details: { stagesCreated: result.stagesCreated, warnings: backbone.warnings },
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
