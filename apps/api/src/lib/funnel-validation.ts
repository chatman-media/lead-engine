// Чистая доменная логика воронок, вынесенная из routes/admin-funnel.ts:
// типы стадий, каталоги допустимых значений и валидация/нормализация
// конфигов. Без БД и Hono — тестируется юнитами (routes/** в codecov-ignore,
// поэтому раньше эта логика не измерялась).

import {
	type ActivePhase,
	deriveDefaultPhase,
	validateBackbone,
} from "@chatman-media/verticals";

export type SeedStage = {
	slug: string;
	displayName: string;
	kind: "intake" | "active" | "terminal_won" | "terminal_lost";
	stageType: string;
	/** Макро-фаза костяка — только для active; intake/terminal не задаются. */
	phase?: ActivePhase;
	position: number;
	color?: string;
	icon?: string;
	description?: string;
	staleTimeoutDays?: number;
	checkinIntervalDays?: number;
	supportMode?: boolean;
	nextStages: string[];
	autoAdvanceCondition?: string;
	configJson?: string;
	goal?: string;
	guidance?: string;
	partnerWebhookUrl?: string | null;
	partnerWebhookMode?: string;
	fields: Array<{
		slug: string;
		displayName: string;
		fieldType: string;
		required: boolean;
		aiExtractable: boolean;
		hint?: string;
		optionsJson?: string;
		validationJson?: string;
		position: number;
	}>;
};


/** Каталог допустимых значений — shared с AI workflow builder для валидации. */
export const STAGE_KINDS = [
	"intake",
	"active",
	"terminal_won",
	"terminal_lost",
] as const;
export const STAGE_TYPES = [
	"form_fill",
	"document_upload",
	"document_signature",
	"rate_confirmation",
	"external_approval",
	"payment",
	"awaiting_operator",
	"interaction",
	"assessment",
	"waiting",
	"milestone",
] as const;
export const FIELD_TYPES = [
	"text",
	"textarea",
	"number",
	"date",
	"select",
	"multiselect",
	"boolean",
	"phone",
	"email",
	"photo",
	"file",
	"video",
] as const;


type StageConfigJsonInput = string | Record<string, unknown> | undefined;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseAutoAdvanceConditionType(raw?: string): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { type?: unknown };
		return typeof parsed.type === "string" ? parsed.type : null;
	} catch {
		return null;
	}
}

function parseStageConfigJson(
	raw: StageConfigJsonInput,
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

export function stageWorkflowTransitions(configJson?: string): unknown[] {
	const config = parseStageConfigJson(configJson);
	const workflow = config.workflow;
	if (!isJsonRecord(workflow) || !Array.isArray(workflow.transitions)) {
		return [];
	}
	return workflow.transitions;
}

/**
 * Контракт мульти-запроса (ветвление по request_type): если intake имеет
 * select-поле request_type, каждое его значение <X> обязано иметь ветку,
 * достижимую из intake. Для линейных воронок — пусто.
 */
export function multiRequestBranchErrors(stages: SeedStage[]): string[] {
	const errors: string[] = [];
	const intake = stages.find((s) => s.kind === "intake");
	if (!intake) return errors;
	const requestType = intake.fields.find((f) => f.slug === "request_type");
	if (!requestType) return errors;
	let values: string[] = [];
	if (requestType.optionsJson) {
		try {
			values = (
				JSON.parse(requestType.optionsJson) as Array<{ value?: unknown }>
			)
				.map((option) => String(option.value ?? ""))
				.filter(Boolean);
		} catch {
			// Invalid optionsJson is reported as missing options below.
		}
	}
	if (values.length === 0) {
		errors.push(
			"Мультизапрос: у поля request_type на intake нет валидных опций.",
		);
		return errors;
	}
	const next = intake.nextStages ?? [];
	for (const value of values) {
		const hasBranch = next.some(
			(stage) => stage === `${value}_request` || stage.startsWith(`${value}_`),
		);
		if (!hasBranch) {
			errors.push(
				`Мультизапрос: для типа "${value}" нет ветки — добавь стадию "${value}_request" и укажи её в nextStages intake.`,
			);
		}
	}
	return errors;
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

/** validateBackbone + контракт мульти-запроса — общий gate для builder/rollback. */
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

export function normalizeSeedStageConfigJson(opts: {
	configJson?: StageConfigJsonInput;
	autoAdvanceCondition?: string;
	nextStages: readonly string[];
	fields: readonly Pick<SeedStage["fields"][number], "slug">[];
}): string {
	const config = parseStageConfigJson(opts.configJson);
	const workflow = isJsonRecord(config.workflow) ? { ...config.workflow } : {};
	if (
		!Array.isArray(workflow.transitions) &&
		parseAutoAdvanceConditionType(opts.autoAdvanceCondition) ===
			"all_required_fields_filled" &&
		opts.nextStages.length > 0
	) {
		const transition: Record<string, unknown> = {
			when: { type: "all_required_fields_filled" },
			priority: 10,
		};
		if (!opts.fields.some((field) => field.slug === "request_type")) {
			transition.to = opts.nextStages[0];
		}
		workflow.transitions = [transition];
		config.workflow = workflow;
	}
	return Object.keys(config).length > 0 ? JSON.stringify(config) : "{}";
}

/**
 * Фаза костяка для стадии при сидировании: явный тег → эвристика; null для
 * якорей (intake/terminal). Общая логика для applyFunnelStages и тестов костяка.
 */
export function resolveSeedPhase(
	stage: Pick<SeedStage, "kind" | "stageType" | "phase">,
	prevPhase: ActivePhase | null,
): ActivePhase | null {
	if (stage.kind !== "active") return null;
	return stage.phase ?? deriveDefaultPhase(stage.stageType, prevPhase);
}
