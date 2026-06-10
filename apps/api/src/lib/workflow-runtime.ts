import {
	type Db,
	type NotificationService,
	withTenant,
} from "@chatman-media/conversation-engine";
import {
	customerRequests,
	leadEvents,
	leadFieldValues,
	leads,
	partnerDeals,
	stageDefinitions,
	stageFields,
} from "@chatman-media/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export type WorkflowEventType =
	| "message_received"
	| "field_updated"
	| "operator_advanced"
	| "operator_sent_offer"
	| "webhook_callback";

export type WorkflowEffect = {
	type: "notify_operator";
	tenantId: number;
	leadId: number;
	contactId: number;
	toStage: string;
};

export interface WorkflowStageSnapshot {
	id: number;
	funnelId: number;
	slug: string;
	displayName: string;
	kind: string;
	stageType: string;
	nextStages: string[];
	autoAdvanceCondition: string | null;
	configJson: string;
}

export interface TransitionContext {
	stage: Pick<
		WorkflowStageSnapshot,
		"nextStages" | "autoAdvanceCondition" | "configJson"
	>;
	hasRequestTypeField: boolean;
	requestType: string | null;
	allRequiredFieldsFilled: boolean;
	eventType: WorkflowEventType;
}

export interface TransitionSelection {
	nextSlug: string;
	requestType: string | null;
	reason: "workflow_transition" | "legacy_auto_advance";
	condition: "all_required_fields_filled";
}

export type WorkflowAutoAdvanceResult =
	| {
			advanced: false;
			reason:
				| "no_lead"
				| "no_stage"
				| "terminal_stage"
				| "no_next_stage"
				| "unsupported_condition"
				| "invalid_condition"
				| "no_required_fields"
				| "required_fields_missing"
				| "no_matching_branch"
				| "no_transition"
				| "next_stage_missing";
			effects: WorkflowEffect[];
	  }
	| {
			advanced: true;
			reason: TransitionSelection["reason"];
			condition: TransitionSelection["condition"];
			leadId: number;
			from: string;
			to: string;
			toDisplayName: string;
			toStageType: string;
			awaitingOperator: boolean;
			awaitingPartner: boolean;
			terminal: boolean;
			requestType: string | null;
			effects: WorkflowEffect[];
	  };

export type FieldUpdatedEvent = {
	tenantId: number;
	leadId: number;
	adminId?: number;
	extractedValues?: Record<string, unknown>;
	eventType?: Extract<WorkflowEventType, "message_received" | "field_updated">;
	now?: number;
};

interface WorkflowTransitionRule {
	to?: unknown;
	when?: unknown;
	priority?: unknown;
}

interface WorkflowWhen {
	type?: unknown;
}

export type WorkflowLeadSelector = { leadId: number } | { contactId: number };

export type WorkflowOperatorEvent = {
	tenantId: number;
	selector: WorkflowLeadSelector;
	adminId?: number;
	now: number;
};

export type WorkflowWebhookCallbackAction = "confirm" | "cancel";

export type WorkflowWebhookCallbackEvent = {
	tenantId: number;
	leadId: number;
	stageId: number;
	token: string;
	action: WorkflowWebhookCallbackAction;
	now: number;
};

export type WorkflowWebhookCallbackPageResult =
	| {
			kind: "ready";
			leadId: number;
			stageName: string;
			state: string;
	  }
	| { kind: "no_lead" }
	| { kind: "already_processed" }
	| { kind: "stage_mismatch" };

export type WorkflowOperatorTransitionResult =
	| { kind: "no_lead" }
	| { kind: "terminal"; stage: string }
	| {
			kind: "not_applicable";
			reason: "current_stage_type";
			leadId: number;
			contactId: number;
			from: string;
			fromDisplayName: string;
	  }
	| {
			kind: "advanced";
			leadId: number;
			contactId: number;
			from: string;
			fromDisplayName: string;
			fromStageId: number;
			to: string;
			toDisplayName: string;
			toStageId: number;
			toStageType: string;
			terminal: boolean;
			awaitingPartner: boolean;
			partnerWebhookUrl: string | null;
			partnerWebhookMode: string;
			effects: WorkflowEffect[];
	  };

export type WorkflowWebhookCallbackResult =
	| WorkflowOperatorTransitionResult
	| {
			kind: "already_processed" | "stage_mismatch";
			leadId: number;
			stage: string;
			effects: WorkflowEffect[];
	  }
	| {
			kind: "cancelled";
			leadId: number;
			stage: string;
			effects: WorkflowEffect[];
	  };

/**
 * Выбор следующей стадии при auto-advance.
 *
 * Branch-aware (concierge): если у стадии есть поле `request_type` и >1 ветки,
 * уводим в ветку `<request_type>_*` (напр. `transfer` -> `transfer_request`) и
 * возвращаем `requestType` для записи в `leads.request_type`. Если валидной
 * ветки нет (напр. `other` / не распознано) - возвращаем `null` = "не
 * продвигать", лид остаётся на intake для оператора/уточнения.
 *
 * Линейные воронки не затронуты: у их стадий нет поля `request_type`, поэтому
 * `hasRequestTypeField=false` -> прежнее поведение `nextStages[0]`.
 */
export function selectNextStage(opts: {
	nextStages: readonly string[];
	hasRequestTypeField: boolean;
	requestType: string | null;
}): { nextSlug: string; requestType: string | null } | null {
	const { nextStages, hasRequestTypeField, requestType } = opts;
	if (hasRequestTypeField && nextStages.length > 1) {
		const branch = requestType
			? nextStages.find(
					(s) =>
						s === `${requestType}_request` || s.startsWith(`${requestType}_`),
				)
			: undefined;
		if (!branch) return null;
		return { nextSlug: branch, requestType };
	}
	const first = nextStages[0];
	if (!first) return null;
	return { nextSlug: first, requestType: null };
}

export function evaluateTransition(
	ctx: TransitionContext,
): TransitionSelection | null {
	if (
		ctx.eventType !== "message_received" &&
		ctx.eventType !== "field_updated"
	) {
		return null;
	}

	const workflowRule = parseWorkflowTransitions(ctx.stage.configJson)
		.filter((rule) => whenType(rule.when) === "all_required_fields_filled")
		.sort((a, b) => priorityOf(b) - priorityOf(a))[0];

	if (workflowRule) {
		if (!ctx.allRequiredFieldsFilled) return null;
		const explicitTo =
			typeof workflowRule.to === "string" && workflowRule.to.trim()
				? workflowRule.to.trim()
				: null;
		const selected = explicitTo
			? {
					nextSlug: explicitTo,
					requestType: ctx.hasRequestTypeField ? ctx.requestType : null,
				}
			: selectNextStage({
					nextStages: ctx.stage.nextStages,
					hasRequestTypeField: ctx.hasRequestTypeField,
					requestType: ctx.requestType,
				});
		if (!selected) return null;
		return {
			...selected,
			reason: "workflow_transition",
			condition: "all_required_fields_filled",
		};
	}

	const legacyCondition = parseConditionType(ctx.stage.autoAdvanceCondition);
	if (legacyCondition !== "all_required_fields_filled") return null;
	if (!ctx.allRequiredFieldsFilled) return null;

	const selected = selectNextStage({
		nextStages: ctx.stage.nextStages,
		hasRequestTypeField: ctx.hasRequestTypeField,
		requestType: ctx.requestType,
	});
	if (!selected) return null;
	return {
		...selected,
		reason: "legacy_auto_advance",
		condition: "all_required_fields_filled",
	};
}

export class WorkflowRuntime {
	constructor(
		private readonly deps: {
			db: Db;
			notificationService?: NotificationService | null;
		},
	) {}

	async handleFieldUpdated(
		event: FieldUpdatedEvent,
	): Promise<WorkflowAutoAdvanceResult> {
		const now = event.now ?? Math.floor(Date.now() / 1000);
		const result = await withTenant(this.deps.db, event.tenantId, (tx) =>
			handleFieldUpdatedInTx(tx, { ...event, now }),
		);
		dispatchWorkflowEffects(
			result.effects,
			this.deps.notificationService ?? null,
		);
		return result;
	}
}

export async function autoAdvanceLead(opts: {
	db: Db;
	tenantId: number;
	leadId: number;
	eventType: Extract<WorkflowEventType, "message_received" | "field_updated">;
	now: number;
	adminId?: number;
	extractedValues?: Record<string, unknown>;
}): Promise<WorkflowAutoAdvanceResult> {
	return handleFieldUpdatedInTx(opts.db, {
		tenantId: opts.tenantId,
		leadId: opts.leadId,
		eventType: opts.eventType,
		now: opts.now,
		adminId: opts.adminId,
		extractedValues: opts.extractedValues,
	});
}

export async function handleFieldUpdatedInTx(
	tx: Db,
	event: FieldUpdatedEvent & { now: number },
): Promise<WorkflowAutoAdvanceResult> {
	const eventType = event.eventType ?? "field_updated";
	const [lead] = await tx
		.select({
			id: leads.id,
			state: leads.state,
			stageDefinitionId: leads.stageDefinitionId,
			contactId: leads.userId,
			requestType: leads.requestType,
		})
		.from(leads)
		.where(and(eq(leads.id, event.leadId), eq(leads.tenantId, event.tenantId)))
		.limit(1);
	if (!lead) return noAdvance("no_lead");
	if (!lead.stageDefinitionId) return noAdvance("no_stage");

	const [stage] = await tx
		.select({
			id: stageDefinitions.id,
			funnelId: stageDefinitions.funnelId,
			slug: stageDefinitions.slug,
			displayName: stageDefinitions.displayName,
			kind: stageDefinitions.kind,
			stageType: stageDefinitions.stageType,
			nextStages: stageDefinitions.nextStages,
			autoAdvanceCondition: stageDefinitions.autoAdvanceCondition,
			configJson: stageDefinitions.configJson,
		})
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.id, lead.stageDefinitionId),
				eq(stageDefinitions.tenantId, event.tenantId),
			),
		)
		.limit(1);
	if (!stage) return noAdvance("no_stage");
	if (stage.kind === "terminal_won" || stage.kind === "terminal_lost") {
		return noAdvance("terminal_stage");
	}

	const fields = await tx
		.select({
			id: stageFields.id,
			slug: stageFields.slug,
			required: stageFields.required,
		})
		.from(stageFields)
		.where(
			and(
				eq(stageFields.stageId, stage.id),
				eq(stageFields.tenantId, event.tenantId),
			),
		);
	const requiredFields = fields.filter((field) => field.required);
	if (requiredFields.length === 0) return noAdvance("no_required_fields");

	const filledRequired = await tx
		.select({ id: leadFieldValues.fieldId })
		.from(leadFieldValues)
		.where(
			and(
				eq(leadFieldValues.leadId, lead.id),
				inArray(
					leadFieldValues.fieldId,
					requiredFields.map((field) => field.id),
				),
				sql`${leadFieldValues.valueJson} != 'null' AND ${leadFieldValues.valueJson} != '""' AND ${leadFieldValues.valueJson} != ''`,
			),
		);
	const allRequiredFieldsFilled =
		filledRequired.length >= requiredFields.length;

	const requestTypeField = fields.find(
		(field) => field.slug === "request_type",
	);
	const requestType = await resolveRequestType({
		tx,
		leadId: lead.id,
		requestTypeFieldId: requestTypeField?.id ?? null,
		extractedValues: event.extractedValues,
		fallbackRequestType: lead.requestType,
	});

	const transition = evaluateTransition({
		stage,
		hasRequestTypeField: !!requestTypeField,
		requestType,
		allRequiredFieldsFilled,
		eventType,
	});
	if (!transition) {
		if (!allRequiredFieldsFilled) return noAdvance("required_fields_missing");
		if (
			stage.nextStages.length === 0 &&
			parseWorkflowTransitions(stage.configJson).length === 0
		) {
			return noAdvance("no_next_stage");
		}
		return noAdvance("no_transition");
	}

	const [nextStage] = await tx
		.select({
			id: stageDefinitions.id,
			slug: stageDefinitions.slug,
			displayName: stageDefinitions.displayName,
			stageType: stageDefinitions.stageType,
			kind: stageDefinitions.kind,
			nextStages: stageDefinitions.nextStages,
			partnerWebhookUrl: stageDefinitions.partnerWebhookUrl,
			partnerWebhookMode: stageDefinitions.partnerWebhookMode,
		})
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.slug, transition.nextSlug),
				eq(stageDefinitions.tenantId, event.tenantId),
				eq(stageDefinitions.funnelId, stage.funnelId),
			),
		)
		.limit(1);
	if (!nextStage) return noAdvance("next_stage_missing");

	await tx
		.update(leads)
		.set({
			stageDefinitionId: nextStage.id,
			state: nextStage.slug,
			...(transition.requestType
				? { requestType: transition.requestType }
				: {}),
			updatedAt: event.now,
		})
		.where(eq(leads.id, lead.id));

	const effectiveRequestType = transition.requestType ?? lead.requestType;
	if (effectiveRequestType) {
		await syncCustomerRequestForLeadInTx(tx, {
			tenantId: event.tenantId,
			contactId: lead.contactId,
			leadId: lead.id,
			funnelId: stage.funnelId,
			stageDefinitionId: nextStage.id,
			stageKind: nextStage.kind,
			requestType: effectiveRequestType,
			now: event.now,
		});
	}

	await tx.insert(leadEvents).values({
		tenantId: event.tenantId,
		leadId: lead.id,
		fromState: lead.state,
		toState: nextStage.slug,
		byAdminId: event.adminId,
		notes: JSON.stringify({
			type: "workflow_transition",
			reason: transition.reason,
			condition: transition.condition,
			eventType,
			requestType: transition.requestType,
		}),
		createdAt: event.now,
	});

	const awaitingOperator = nextStage.stageType === "awaiting_operator";
	const effects: WorkflowEffect[] = awaitingOperator
		? [
				{
					type: "notify_operator",
					tenantId: event.tenantId,
					leadId: lead.id,
					contactId: lead.contactId,
					toStage: nextStage.displayName,
				},
			]
		: [];

	return {
		advanced: true,
		reason: transition.reason,
		condition: transition.condition,
		leadId: lead.id,
		from: lead.state,
		to: nextStage.slug,
		toDisplayName: nextStage.displayName,
		toStageType: nextStage.stageType,
		awaitingOperator,
		awaitingPartner:
			Boolean(nextStage.partnerWebhookUrl) &&
			nextStage.partnerWebhookMode === "await_callback",
		terminal:
			nextStage.nextStages.length === 0 ||
			nextStage.kind.startsWith("terminal_"),
		requestType: transition.requestType,
		effects,
	};
}

export async function handleOperatorAdvancedInTx(
	tx: Db,
	event: WorkflowOperatorEvent,
): Promise<WorkflowOperatorTransitionResult> {
	return advanceLeadToNextStageInTx(tx, {
		...event,
		workflowEvent: "operator_advanced",
	});
}

export async function handleOperatorSentOfferInTx(
	tx: Db,
	event: WorkflowOperatorEvent,
): Promise<WorkflowOperatorTransitionResult> {
	return advanceLeadToNextStageInTx(tx, {
		...event,
		requiredCurrentStageType: "awaiting_operator",
		workflowEvent: "operator_sent_offer",
	});
}

export async function loadWebhookCallbackPageInTx(
	tx: Db,
	event: Pick<
		WorkflowWebhookCallbackEvent,
		"tenantId" | "leadId" | "stageId" | "token"
	>,
): Promise<WorkflowWebhookCallbackPageResult> {
	const callbackLead = await loadActiveCallbackLead(tx, event);
	if (callbackLead.kind !== "ready") return callbackLead;

	const [stage] = await tx
		.select({ displayName: stageDefinitions.displayName })
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.id, event.stageId),
				eq(stageDefinitions.tenantId, event.tenantId),
			),
		)
		.limit(1);

	return {
		kind: "ready",
		leadId: callbackLead.lead.id,
		state: callbackLead.lead.state,
		stageName: stage?.displayName ?? callbackLead.lead.state,
	};
}

export async function handleWebhookCallbackInTx(
	tx: Db,
	event: WorkflowWebhookCallbackEvent,
): Promise<WorkflowWebhookCallbackResult> {
	const callbackLead = await loadActiveCallbackLead(tx, event);
	if (callbackLead.kind !== "ready") {
		if (callbackLead.kind === "no_lead") return { kind: "no_lead" };
		return {
			kind: callbackLead.kind,
			leadId: event.leadId,
			stage: "",
			effects: [],
		};
	}

	const { lead } = callbackLead;

	await tx
		.update(leads)
		.set({
			awaitingToken: null,
			...(event.action === "cancel"
				? { rejectedReason: "Партнёр отклонил заявку." }
				: {}),
			updatedAt: event.now,
		})
		.where(
			and(
				eq(leads.tenantId, event.tenantId),
				eq(leads.id, event.leadId),
				eq(leads.awaitingToken, event.token),
			),
		);

	if (event.action === "cancel") {
		await tx
			.update(partnerDeals)
			.set({ status: "rejected", cancelledAt: event.now, updatedAt: event.now })
			.where(
				and(
					eq(partnerDeals.tenantId, event.tenantId),
					eq(partnerDeals.leadId, event.leadId),
					eq(partnerDeals.stageDefinitionId, event.stageId),
				),
			);

		await tx.insert(leadEvents).values({
			tenantId: event.tenantId,
			leadId: lead.id,
			fromState: lead.state,
			toState: lead.state,
			notes: JSON.stringify({
				workflowEvent: "webhook_callback",
				callbackAction: "cancel",
				stageId: event.stageId,
			}),
			createdAt: event.now,
		});

		return {
			kind: "cancelled",
			leadId: lead.id,
			stage: lead.state,
			effects: [],
		};
	}

	await tx
		.update(partnerDeals)
		.set({ status: "accepted", acceptedAt: event.now, updatedAt: event.now })
		.where(
			and(
				eq(partnerDeals.tenantId, event.tenantId),
				eq(partnerDeals.leadId, event.leadId),
				eq(partnerDeals.stageDefinitionId, event.stageId),
			),
		);

	return advanceLeadToNextStageInTx(tx, {
		tenantId: event.tenantId,
		selector: { leadId: event.leadId },
		now: event.now,
		workflowEvent: "webhook_callback",
		workflowNotes: { callbackAction: "confirm", stageId: event.stageId },
	});
}

export function dispatchWorkflowEffects(
	effects: readonly WorkflowEffect[],
	notificationService?: NotificationService | null,
): void {
	if (!notificationService) return;
	for (const effect of effects) {
		if (effect.type === "notify_operator") {
			void notificationService
				.notify({
					tenantId: effect.tenantId,
					eventType: "stage_changed",
					leadId: effect.leadId,
					contactId: effect.contactId,
					data: { toStage: effect.toStage, awaitingOperator: true },
				})
				.catch(() => {});
		}
	}
}

function noAdvance(
	reason: Extract<WorkflowAutoAdvanceResult, { advanced: false }>["reason"],
): Extract<WorkflowAutoAdvanceResult, { advanced: false }> {
	return { advanced: false, reason, effects: [] };
}

export async function syncCustomerRequestForLeadInTx(
	tx: Db,
	opts: {
		tenantId: number;
		contactId: number;
		leadId: number;
		funnelId: number | null;
		stageDefinitionId: number | null;
		stageKind: string | null;
		requestType: string;
		now: number;
	},
): Promise<void> {
	const status =
		opts.stageKind === "terminal_won"
			? "won"
			: opts.stageKind === "terminal_lost"
				? "lost"
				: "open";
	const patch = {
		contactId: opts.contactId,
		funnelId: opts.funnelId,
		stageDefinitionId: opts.stageDefinitionId,
		requestType: opts.requestType,
		status,
		updatedAt: opts.now,
		closedAt: status === "open" ? null : opts.now,
	};
	const [updated] = await tx
		.update(customerRequests)
		.set(patch)
		.where(
			and(
				eq(customerRequests.tenantId, opts.tenantId),
				eq(customerRequests.leadId, opts.leadId),
			),
		)
		.returning({ id: customerRequests.id });
	if (updated) return;
	await tx.insert(customerRequests).values({
		tenantId: opts.tenantId,
		contactId: opts.contactId,
		leadId: opts.leadId,
		funnelId: opts.funnelId,
		stageDefinitionId: opts.stageDefinitionId,
		requestType: opts.requestType,
		status,
		title: opts.requestType,
		createdAt: opts.now,
		updatedAt: opts.now,
		closedAt: status === "open" ? null : opts.now,
	});
}

async function advanceLeadToNextStageInTx(
	tx: Db,
	event: WorkflowOperatorEvent & {
		workflowEvent:
			| "operator_advanced"
			| "operator_sent_offer"
			| "webhook_callback";
		requiredCurrentStageType?: string;
		workflowNotes?: Record<string, unknown>;
	},
): Promise<WorkflowOperatorTransitionResult> {
	const whereLead =
		"leadId" in event.selector
			? and(
					eq(leads.tenantId, event.tenantId),
					eq(leads.id, event.selector.leadId),
				)
			: and(
					eq(leads.tenantId, event.tenantId),
					eq(leads.userId, event.selector.contactId),
				);
	const [lead] = await tx
		.select({
			id: leads.id,
			contactId: leads.userId,
			state: leads.state,
			stageDefinitionId: leads.stageDefinitionId,
			requestType: leads.requestType,
		})
		.from(leads)
		.where(whereLead)
		.orderBy(desc(leads.id))
		.limit(1);
	if (!lead?.stageDefinitionId) return { kind: "no_lead" };

	const [currentStage] = await tx
		.select({
			id: stageDefinitions.id,
			slug: stageDefinitions.slug,
			funnelId: stageDefinitions.funnelId,
			displayName: stageDefinitions.displayName,
			kind: stageDefinitions.kind,
			stageType: stageDefinitions.stageType,
			nextStages: stageDefinitions.nextStages,
		})
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.id, lead.stageDefinitionId),
				eq(stageDefinitions.tenantId, event.tenantId),
			),
		);
	if (!currentStage) return { kind: "no_lead" };

	if (
		event.requiredCurrentStageType &&
		currentStage.stageType !== event.requiredCurrentStageType
	) {
		return {
			kind: "not_applicable",
			reason: "current_stage_type",
			leadId: lead.id,
			contactId: lead.contactId,
			from: currentStage.slug,
			fromDisplayName: currentStage.displayName,
		};
	}

	const nextSlug = currentStage.nextStages[0];
	if (!nextSlug) return { kind: "terminal", stage: currentStage.slug };

	const [nextStage] = await tx
		.select({
			id: stageDefinitions.id,
			slug: stageDefinitions.slug,
			displayName: stageDefinitions.displayName,
			kind: stageDefinitions.kind,
			stageType: stageDefinitions.stageType,
			nextStages: stageDefinitions.nextStages,
			partnerWebhookUrl: stageDefinitions.partnerWebhookUrl,
			partnerWebhookMode: stageDefinitions.partnerWebhookMode,
		})
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.slug, nextSlug),
				eq(stageDefinitions.tenantId, event.tenantId),
				eq(stageDefinitions.funnelId, currentStage.funnelId),
			),
		);
	if (!nextStage) return { kind: "terminal", stage: currentStage.slug };

	await tx
		.update(leads)
		.set({
			stageDefinitionId: nextStage.id,
			state: nextStage.slug,
			updatedAt: event.now,
		})
		.where(and(eq(leads.tenantId, event.tenantId), eq(leads.id, lead.id)));

	if (lead.requestType) {
		await syncCustomerRequestForLeadInTx(tx, {
			tenantId: event.tenantId,
			contactId: lead.contactId,
			leadId: lead.id,
			funnelId: currentStage.funnelId,
			stageDefinitionId: nextStage.id,
			stageKind: nextStage.kind,
			requestType: lead.requestType,
			now: event.now,
		});
	}

	await tx.insert(leadEvents).values({
		tenantId: event.tenantId,
		leadId: lead.id,
		fromState: lead.state,
		toState: nextStage.slug,
		byAdminId: event.adminId,
		notes: JSON.stringify({
			workflowEvent: event.workflowEvent,
			...(event.workflowNotes ?? {}),
		}),
		createdAt: event.now,
	});

	const effects: WorkflowEffect[] =
		nextStage.stageType === "awaiting_operator"
			? [
					{
						type: "notify_operator",
						tenantId: event.tenantId,
						leadId: lead.id,
						contactId: lead.contactId,
						toStage: nextStage.displayName,
					},
				]
			: [];

	return {
		kind: "advanced",
		leadId: lead.id,
		contactId: lead.contactId,
		from: currentStage.slug,
		fromDisplayName: currentStage.displayName,
		fromStageId: currentStage.id,
		to: nextStage.slug,
		toDisplayName: nextStage.displayName,
		toStageId: nextStage.id,
		toStageType: nextStage.stageType,
		terminal: nextStage.nextStages.length === 0,
		awaitingPartner:
			Boolean(nextStage.partnerWebhookUrl) &&
			nextStage.partnerWebhookMode === "await_callback",
		partnerWebhookUrl: nextStage.partnerWebhookUrl,
		partnerWebhookMode: nextStage.partnerWebhookMode,
		effects,
	};
}

async function loadActiveCallbackLead(
	tx: Db,
	event: Pick<
		WorkflowWebhookCallbackEvent,
		"tenantId" | "leadId" | "stageId" | "token"
	>,
): Promise<
	| {
			kind: "ready";
			lead: {
				id: number;
				state: string;
				stageDefinitionId: number | null;
				awaitingToken: string | null;
			};
	  }
	| { kind: "no_lead" }
	| { kind: "already_processed" }
	| { kind: "stage_mismatch" }
> {
	const [lead] = await tx
		.select({
			id: leads.id,
			state: leads.state,
			stageDefinitionId: leads.stageDefinitionId,
			awaitingToken: leads.awaitingToken,
		})
		.from(leads)
		.where(and(eq(leads.tenantId, event.tenantId), eq(leads.id, event.leadId)))
		.limit(1);

	if (!lead) return { kind: "no_lead" };
	if (lead.awaitingToken !== event.token) return { kind: "already_processed" };
	if (lead.stageDefinitionId !== event.stageId)
		return { kind: "stage_mismatch" };
	return { kind: "ready", lead };
}

function parseConditionType(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { type?: unknown };
		return typeof parsed.type === "string" ? parsed.type : null;
	} catch {
		return null;
	}
}

function parseWorkflowTransitions(
	configJson: string,
): WorkflowTransitionRule[] {
	try {
		const parsed = JSON.parse(configJson) as {
			workflow?: { transitions?: unknown };
		};
		return Array.isArray(parsed.workflow?.transitions)
			? (parsed.workflow.transitions as WorkflowTransitionRule[])
			: [];
	} catch {
		return [];
	}
}

function whenType(raw: unknown): string | null {
	const when = raw as WorkflowWhen | null;
	return typeof when?.type === "string" ? when.type : null;
}

function priorityOf(rule: WorkflowTransitionRule): number {
	return typeof rule.priority === "number" && Number.isFinite(rule.priority)
		? rule.priority
		: 0;
}

async function resolveRequestType(opts: {
	tx: Db;
	leadId: number;
	requestTypeFieldId: number | null;
	extractedValues?: Record<string, unknown>;
	fallbackRequestType: string | null;
}): Promise<string | null> {
	const extracted = normalizeRequestType(opts.extractedValues?.request_type);
	if (extracted) return extracted;

	if (opts.requestTypeFieldId) {
		const [stored] = await opts.tx
			.select({ valueJson: leadFieldValues.valueJson })
			.from(leadFieldValues)
			.where(
				and(
					eq(leadFieldValues.leadId, opts.leadId),
					eq(leadFieldValues.fieldId, opts.requestTypeFieldId),
				),
			)
			.limit(1);
		if (stored?.valueJson) {
			try {
				const storedValue = JSON.parse(stored.valueJson) as unknown;
				const normalized = normalizeRequestType(storedValue);
				if (normalized) return normalized;
			} catch {
				// ignore malformed stored value
			}
		}
	}

	return normalizeRequestType(opts.fallbackRequestType);
}

function normalizeRequestType(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
