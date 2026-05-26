import type { VerticalTemplate } from "@chatman-media/verticals";
import type { LeadRow, LeadsRepo } from "./dal/leads.ts";
import { getInitialStage, validateTransition } from "./funnel-machine.ts";
import type { NotificationService } from "./notifications.ts";

/**
 * Find-or-create Lead на (tenant, contact). При создании stage берётся
 * из template.funnelStages[0] (обычно 'intake_pending'). Vertical-hook
 * onLeadStageChange при создании НЕ вызывается — у нас нет fromState;
 * хук рассчитан на смены состояния, а не на initial-create.
 */
export async function ensureLead(opts: {
  contactId: number;
  template: VerticalTemplate;
  leads: LeadsRepo;
  nowEpoch: number;
}): Promise<{ lead: LeadRow; created: boolean }> {
  const existing = await opts.leads.findByContactId(opts.contactId);
  if (existing) return { lead: existing, created: false };
  const created = await opts.leads.create({
    contactId: opts.contactId,
    state: getInitialStage(opts.template).slug,
    nowEpoch: opts.nowEpoch,
  });
  return { lead: created, created: true };
}

/**
 * Контекст для vertical-hooks — мини-DI прокидывается в каждый хук.
 * Зачем нужен сам объект (вместо просто полей): vertical-template'у
 * нужен escape-hatch чтобы пробросить дополнительные deps через cast'у.
 */
export interface LeadHookContext {
  tenantId: number;
  contactId: number;
  leadId: number;
  template: VerticalTemplate;
}

/**
 * Переход lead.state с валидацией по template.funnelStages и вызовом
 * хуков. Атомарность: UPDATE leads.state делается ДО вызова хука —
 * если хук бросит, мы НЕ откатываем состояние, потому что хук может
 * быть side-effect'ом (например, послать DM кандидату). Хуки должны
 * быть идемпотентны.
 */
export async function transitionLeadState(opts: {
  lead: LeadRow;
  toState: string;
  template: VerticalTemplate;
  leads: LeadsRepo;
  notifications?: NotificationService;
  nowEpoch: number;
  hookContext?: Partial<LeadHookContext>;
}): Promise<LeadRow> {
  validateTransition(opts.template, opts.lead.state, opts.toState);
  if (opts.lead.state === opts.toState) {
    // no-op idempotent path — пропускаем UPDATE и хук.
    return opts.lead;
  }
  // Снимаем fromState ДО updateState — repo может мутировать lead-объект
  // по ссылке (fake-репы в тестах так и делают).
  const fromState = opts.lead.state;
  await opts.leads.updateState(opts.lead.id, opts.toState, opts.nowEpoch);
  const updated: LeadRow = { ...opts.lead, state: opts.toState, updatedAt: opts.nowEpoch };

  if (opts.notifications) {
    await opts.notifications.notify({
      tenantId: opts.lead.tenantId,
      eventType: "stage_changed",
      leadId: opts.lead.id,
      contactId: opts.lead.userId,
      assignedAdminId: opts.lead.assignedAdminId ?? undefined,
      data: {
        fromStage: fromState,
        toStage: opts.toState,
      },
    });
  }

  const hook = opts.template.hooks?.onLeadStageChange;
  if (hook) {
    const ctx: LeadHookContext = {
      tenantId: opts.lead.tenantId,
      contactId: opts.lead.userId,
      leadId: opts.lead.id,
      template: opts.template,
      ...opts.hookContext,
    };
    await hook(ctx, fromState, opts.toState);
  }

  return updated;
}
