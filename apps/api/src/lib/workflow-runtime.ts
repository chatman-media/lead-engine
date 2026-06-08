import { type Db, type NotificationService, withTenant } from "@chatman-media/conversation-engine";
import { leadEvents, leadFieldValues, leads, stageDefinitions, stageFields } from "@chatman-media/storage";
import { and, eq, inArray, sql } from "drizzle-orm";

export type WorkflowEffect = {
  type: "notify_operator";
  tenantId: number;
  leadId: number;
  contactId: number;
  toStage: string;
};

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
        | "next_stage_missing";
      effects: WorkflowEffect[];
    }
  | {
      advanced: true;
      leadId: number;
      from: string;
      to: string;
      toDisplayName: string;
      toStageType: string;
      requestType: string | null;
      effects: WorkflowEffect[];
    };

export type FieldUpdatedEvent = {
  tenantId: number;
  leadId: number;
  adminId?: number;
  extractedValues?: Record<string, unknown>;
  now?: number;
};

/**
 * Выбор следующей стадии при auto-advance.
 *
 * Branch-aware (concierge): если у стадии есть поле `request_type` и >1 ветки,
 * уводим в ветку `<request_type>_*` (напр. `transfer` → `transfer_request`) и
 * возвращаем `requestType` для записи в `leads.request_type`. Если валидной
 * ветки нет (напр. `other` / не распознано) — возвращаем `null` = «не
 * продвигать», лид остаётся на intake для оператора/уточнения.
 *
 * Линейные воронки (5 вертикалей) не затронуты: у их стадий нет поля
 * `request_type`, поэтому `hasRequestTypeField=false` → прежнее поведение
 * `nextStages[0]`, `requestType=null` (колонка не трогается).
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

export class WorkflowRuntime {
  constructor(
    private readonly deps: {
      db: Db;
      notificationService?: NotificationService | null;
    },
  ) {}

  async handleFieldUpdated(event: FieldUpdatedEvent): Promise<WorkflowAutoAdvanceResult> {
    const now = event.now ?? Math.floor(Date.now() / 1000);
    const result = await withTenant(this.deps.db, event.tenantId, (tx) =>
      handleFieldUpdatedInTx(tx, { ...event, now }),
    );
    dispatchWorkflowEffects(result.effects, this.deps.notificationService ?? null);
    return result;
  }
}

export async function handleFieldUpdatedInTx(
  tx: Db,
  event: FieldUpdatedEvent & { now: number },
): Promise<WorkflowAutoAdvanceResult> {
  const [lead] = await tx
    .select({
      id: leads.id,
      state: leads.state,
      stageDefinitionId: leads.stageDefinitionId,
      contactId: leads.userId,
      requestType: leads.requestType,
    })
    .from(leads)
    .where(and(eq(leads.id, event.leadId), eq(leads.tenantId, event.tenantId)));
  if (!lead) return noAdvance("no_lead");
  if (!lead.stageDefinitionId) return noAdvance("no_stage");

  const [stage] = await tx
    .select({
      id: stageDefinitions.id,
      funnelId: stageDefinitions.funnelId,
      kind: stageDefinitions.kind,
      nextStages: stageDefinitions.nextStages,
      autoAdvanceCondition: stageDefinitions.autoAdvanceCondition,
    })
    .from(stageDefinitions)
    .where(
      and(
        eq(stageDefinitions.id, lead.stageDefinitionId),
        eq(stageDefinitions.tenantId, event.tenantId),
      ),
    );
  if (!stage) return noAdvance("no_stage");
  if (stage.kind === "terminal_won" || stage.kind === "terminal_lost") {
    return noAdvance("terminal_stage");
  }
  if (stage.nextStages.length === 0) return noAdvance("no_next_stage");

  const condition = parseAutoAdvanceCondition(stage.autoAdvanceCondition);
  if (condition === "invalid") return noAdvance("invalid_condition");
  if (condition?.type !== "all_required_fields_filled") {
    return noAdvance("unsupported_condition");
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
  if (filledRequired.length < requiredFields.length) {
    return noAdvance("required_fields_missing");
  }

  const requestTypeField = fields.find((field) => field.slug === "request_type");
  const requestType = await resolveRequestType({
    tx,
    leadId: lead.id,
    requestTypeFieldId: requestTypeField?.id ?? null,
    extractedValues: event.extractedValues,
    fallbackRequestType: lead.requestType,
  });

  const selected = selectNextStage({
    nextStages: stage.nextStages,
    hasRequestTypeField: !!requestTypeField,
    requestType,
  });
  if (!selected) return noAdvance("no_matching_branch");

  const [nextStage] = await tx
    .select({
      id: stageDefinitions.id,
      slug: stageDefinitions.slug,
      displayName: stageDefinitions.displayName,
      stageType: stageDefinitions.stageType,
    })
    .from(stageDefinitions)
    .where(
      and(
        eq(stageDefinitions.slug, selected.nextSlug),
        eq(stageDefinitions.tenantId, event.tenantId),
        eq(stageDefinitions.funnelId, stage.funnelId),
      ),
    );
  if (!nextStage) return noAdvance("next_stage_missing");

  await tx
    .update(leads)
    .set({
      stageDefinitionId: nextStage.id,
      state: nextStage.slug,
      ...(selected.requestType ? { requestType: selected.requestType } : {}),
      updatedAt: event.now,
    })
    .where(eq(leads.id, lead.id));

  await tx.insert(leadEvents).values({
    tenantId: event.tenantId,
    leadId: lead.id,
    fromState: lead.state,
    toState: nextStage.slug,
    byAdminId: event.adminId,
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
    advanced: true,
    leadId: lead.id,
    from: lead.state,
    to: nextStage.slug,
    toDisplayName: nextStage.displayName,
    toStageType: nextStage.stageType,
    requestType: selected.requestType,
    effects,
  };
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

function parseAutoAdvanceCondition(raw: string | null): { type: string } | null | "invalid" {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" ? { type: parsed.type } : null;
  } catch {
    return "invalid";
  }
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
      );
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
