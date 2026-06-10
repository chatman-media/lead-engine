import type {
	FunnelStageDef,
	VerticalTemplate,
} from "@chatman-media/verticals";

/**
 * Валидация state-machine переходов лида. Источник истины — template.funnelStages:
 * stage.next[] описывает разрешённые исходящие переходы. Terminal stages
 * (kind: 'terminal') не имеют next — попытка перейти из них в любое
 * состояние = ошибка.
 *
 * Реализовано как чистая функция без зависимостей от БД — позволяет
 * проверять переход до того, как сделать UPDATE leads.state.
 */
export class FunnelTransitionError extends Error {
	constructor(
		public readonly fromState: string,
		public readonly toState: string,
		public readonly templateSlug: string,
		reason: string,
	) {
		super(
			`funnel transition rejected: ${fromState} → ${toState} ` +
				`(template=${templateSlug}, ${reason})`,
		);
		this.name = "FunnelTransitionError";
	}
}

function findStage(
	template: VerticalTemplate,
	slug: string,
): FunnelStageDef | undefined {
	return template.funnelStages.find((s) => s.slug === slug);
}

/**
 * Initial stage воронки — первый stage из funnelStages, обычно `intake`.
 * Если template имеет questionnaire, его stageSlug должен соответствовать
 * этому stage.
 */
export function getInitialStage(template: VerticalTemplate): FunnelStageDef {
	const first = template.funnelStages[0];
	if (!first) {
		throw new Error(
			`funnel-machine: template "${template.slug}" has no funnelStages`,
		);
	}
	return first;
}

/**
 * Валидирует переход. Бросает FunnelTransitionError если невалиден,
 * иначе ничего не возвращает (void = OK).
 *
 * Особые случаи:
 *   - переход в тот же state allowed (idempotent retry)
 *   - terminal → * никогда не allowed (закрытые лиды не переоткрываются;
 *     для реактивации создаётся новый Lead через operator-action)
 */
export function validateTransition(
	template: VerticalTemplate,
	fromState: string,
	toState: string,
): void {
	if (fromState === toState) return;

	const from = findStage(template, fromState);
	if (!from) {
		throw new FunnelTransitionError(
			fromState,
			toState,
			template.slug,
			`from-state not in template`,
		);
	}
	const to = findStage(template, toState);
	if (!to) {
		throw new FunnelTransitionError(
			fromState,
			toState,
			template.slug,
			`to-state not in template`,
		);
	}
	if (from.kind === "terminal") {
		throw new FunnelTransitionError(
			fromState,
			toState,
			template.slug,
			`terminal stage cannot transition`,
		);
	}
	if (!from.next || !from.next.includes(toState)) {
		throw new FunnelTransitionError(
			fromState,
			toState,
			template.slug,
			`not in from.next [${(from.next ?? []).join(", ")}]`,
		);
	}
}

/**
 * Все валидные следующие stages из текущего. Используется UI'ем для
 * рендера кнопок-переходов на lead-карточке.
 */
export function allowedTransitions(
	template: VerticalTemplate,
	fromState: string,
): string[] {
	const from = findStage(template, fromState);
	if (!from || from.kind === "terminal") return [];
	return [...(from.next ?? [])];
}

/**
 * Является ли stage финальным (terminal). Удобно UI'ю чтобы рендерить
 * карточку как "архивную".
 */
export function isTerminal(template: VerticalTemplate, state: string): boolean {
	return findStage(template, state)?.kind === "terminal";
}
