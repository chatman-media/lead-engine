import type { Db } from "@chatman-media/conversation-engine";
import {
  leadEvents,
  leadFieldValues,
  leads,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, eq, inArray, sql } from "drizzle-orm";

export type WorkflowEventType =
  | "message_received"
  | "field_updated"
  | "operator_advanced"
  | "operator_sent_offer"
  | "webhook_callback";

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
  stage: Pick<WorkflowStageSnapshot, "nextStages" | "autoAdvanceCondition" | "configJson">;
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

export type WorkflowAdvanceResult =
  | {
      advanced: false;
      reason:
        | "no_lead"
        | "no_stage"
        | "terminal"
        | "no_required_fields"
        | "condition_not_met"
        | "no_transition"
        | "next_stage_not_found";
    }
  | {
      advanced: true;
      reason: TransitionSelection["reason"];
      condition: TransitionSelection["condition"];
      leadId: number;
      from: string;
      to: string;
      toDisplayName: string;
      awaitingOperator: boolean;
      awaitingPartner: boolean;
      terminal: boolean;
      requestType: string | null;
    };

interface WorkflowTransitionRule {
  to?: unknown;
  when?: unknown;
  priority?: unknown;
}

interface WorkflowWhen {
  type?: unknown;
}

/**
 * Shared branch-aware next-stage selector.
 *
 * If a stage collects `request_type`, the selected branch is `<request_type>_*`.
 * Without that field this preserves the old linear `nextStages[0]` behavior.
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
          (s) => s === `${requestType}_request` || s.startsWith(`${requestType}_`),
        )
      : undefined;
    if (!branch) return null;
    return { nextSlug: branch, requestType };
  }
  const first = nextStages[0];
  if (!first) return null;
  return { nextSlug: first, requestType: null };
}

export function evaluateTransition(ctx: TransitionContext): TransitionSelection | null {
  if (ctx.eventType !== "message_received" && ctx.eventType !== "field_updated") {
    return null;
  }

  const workflowRules = parseWorkflowTransitions(ctx.stage.configJson);
  const matchingWorkflowRule = workflowRules
    .filter((rule) => whenType(rule.when) === "all_required_fields_filled")
    .sort((a, b) => priorityOf(b) - priorityOf(a))[0];

  if (matchingWorkflowRule) {
    if (!ctx.allRequiredFieldsFilled) return null;
    const explicitTo =
      typeof matchingWorkflowRule.to === "string" && matchingWorkflowRule.to.trim()
        ? matchingWorkflowRule.to.trim()
        : null;
    const selected = explicitTo
      ? { nextSlug: explicitTo, requestType: ctx.hasRequestTypeField ? ctx.requestType : null }
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

export async function autoAdvanceLead(opts: {
  db: Db;
  tenantId: number;
  leadId: number;
  eventType: Extract<WorkflowEventType, "message_received" | "field_updated">;
  now: number;
  adminId?: number;
  extractedValues?: Record<string, unknown>;
}): Promise<WorkflowAdvanceResult> {
  const [lead] = await opts.db
    .select({
      id: leads.id,
      state: leads.state,
      stageDefinitionId: leads.stageDefinitionId,
      requestType: leads.requestType,
    })
    .from(leads)
    .where(and(eq(leads.id, opts.leadId), eq(leads.tenantId, opts.tenantId)))
    .limit(1);
  if (!lead) return { advanced: false, reason: "no_lead" };
  if (!lead.stageDefinitionId) return { advanced: false, reason: "no_stage" };

  const [stage] = await opts.db
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
    .where(and(eq(stageDefinitions.id, lead.stageDefinitionId), eq(stageDefinitions.tenantId, opts.tenantId)))
    .limit(1);
  if (!stage) return { advanced: false, reason: "no_stage" };
  if (stage.kind === "terminal_won" || stage.kind === "terminal_lost") {
    return { advanced: false, reason: "terminal" };
  }

  const requestTypeField = await findRequestTypeField(opts.db, opts.tenantId, stage.id);
  const requestType = await resolveRequestType({
    db: opts.db,
    leadId: lead.id,
    requestTypeFieldId: requestTypeField?.id ?? null,
    existingRequestType: lead.requestType,
    extractedValues: opts.extractedValues,
  });

  const requiredState = await requiredFieldsState(opts.db, stage.id, lead.id);
  if (requiredState.total === 0) return { advanced: false, reason: "no_required_fields" };

  const transition = evaluateTransition({
    stage,
    hasRequestTypeField: !!requestTypeField,
    requestType,
    allRequiredFieldsFilled: requiredState.filled >= requiredState.total,
    eventType: opts.eventType,
  });
  if (!transition) {
    return {
      advanced: false,
      reason: requiredState.filled >= requiredState.total ? "no_transition" : "condition_not_met",
    };
  }

  const [nextStage] = await opts.db
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
        eq(stageDefinitions.tenantId, opts.tenantId),
        eq(stageDefinitions.funnelId, stage.funnelId),
      ),
    )
    .limit(1);
  if (!nextStage) return { advanced: false, reason: "next_stage_not_found" };

  await opts.db
    .update(leads)
    .set({
      stageDefinitionId: nextStage.id,
      state: nextStage.slug,
      ...(transition.requestType ? { requestType: transition.requestType } : {}),
      updatedAt: opts.now,
    })
    .where(eq(leads.id, lead.id));

  await opts.db.insert(leadEvents).values({
    tenantId: opts.tenantId,
    leadId: lead.id,
    fromState: lead.state,
    toState: nextStage.slug,
    byAdminId: opts.adminId,
    notes: JSON.stringify({
      type: "workflow_transition",
      reason: transition.reason,
      condition: transition.condition,
      eventType: opts.eventType,
      requestType: transition.requestType,
    }),
    createdAt: opts.now,
  });

  return {
    advanced: true,
    reason: transition.reason,
    condition: transition.condition,
    leadId: lead.id,
    from: lead.state,
    to: nextStage.slug,
    toDisplayName: nextStage.displayName,
    awaitingOperator: nextStage.stageType === "awaiting_operator",
    awaitingPartner:
      Boolean(nextStage.partnerWebhookUrl) && nextStage.partnerWebhookMode === "await_callback",
    terminal: nextStage.nextStages.length === 0 || nextStage.kind.startsWith("terminal_"),
    requestType: transition.requestType,
  };
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

function parseWorkflowTransitions(configJson: string): WorkflowTransitionRule[] {
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

async function findRequestTypeField(db: Db, tenantId: number, stageId: number) {
  const [field] = await db
    .select({ id: stageFields.id })
    .from(stageFields)
    .where(and(eq(stageFields.tenantId, tenantId), eq(stageFields.stageId, stageId), eq(stageFields.slug, "request_type")))
    .limit(1);
  return field ?? null;
}

async function resolveRequestType(opts: {
  db: Db;
  leadId: number;
  requestTypeFieldId: number | null;
  existingRequestType: string | null;
  extractedValues?: Record<string, unknown>;
}): Promise<string | null> {
  const extracted = opts.extractedValues?.request_type;
  if (typeof extracted === "string" && extracted.trim()) return extracted.trim();
  if (!opts.requestTypeFieldId) return opts.existingRequestType;

  const [stored] = await opts.db
    .select({ valueJson: leadFieldValues.valueJson })
    .from(leadFieldValues)
    .where(
      and(
        eq(leadFieldValues.leadId, opts.leadId),
        eq(leadFieldValues.fieldId, opts.requestTypeFieldId),
      ),
    )
    .limit(1);
  if (!stored?.valueJson) return opts.existingRequestType;
  try {
    const value = JSON.parse(stored.valueJson) as unknown;
    return typeof value === "string" && value.trim() ? value.trim() : opts.existingRequestType;
  } catch {
    return opts.existingRequestType;
  }
}

async function requiredFieldsState(
  db: Db,
  stageId: number,
  leadId: number,
): Promise<{ total: number; filled: number }> {
  const required = await db
    .select({ id: stageFields.id })
    .from(stageFields)
    .where(and(eq(stageFields.stageId, stageId), eq(stageFields.required, true)));
  if (required.length === 0) return { total: 0, filled: 0 };

  const filled = await db
    .select({ id: leadFieldValues.fieldId })
    .from(leadFieldValues)
    .where(
      and(
        eq(leadFieldValues.leadId, leadId),
        inArray(
          leadFieldValues.fieldId,
          required.map((f) => f.id),
        ),
        sql`${leadFieldValues.valueJson} != 'null' AND ${leadFieldValues.valueJson} != '""' AND ${leadFieldValues.valueJson} != ''`,
      ),
    );
  return { total: required.length, filled: filled.length };
}
