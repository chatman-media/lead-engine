// Concierge agentic tools для reply-пайплайна (resolveTools в llm-bootstrap).
//
// Сейчас один tool — list_my_requests: гость спрашивает «что с моим заказом /
// статус / мои запросы», бот вызывает tool и получает открытые запросы гостя
// (тип услуги + текущая стадия). Даёт гостю самообслуживаемый трекинг статуса
// без операторской стороны. Гейтится на concierge-тенанта (isConciergeTenant).

import type { OutboundEnvelope, ReplyMarkup } from "@chatman-media/channel-core";
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import {
  conversations,
  funnels,
  leadEvents,
  leads,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";

const REQUEST_TYPE_LABEL: Record<string, string> = {
  exchange: "Обмен валюты",
  transfer: "Трансфер",
  food: "Еда",
  housekeeping: "Уборка",
  tour: "Экскурсия",
  other: "Другое",
};

/** concierge-тенант = активная воронка привязана к шаблону concierge_v1. */
export async function isConciergeTenant(db: Db, tenantId: number): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const [f] = await tx
      .select({ vt: funnels.verticalTemplateId })
      .from(funnels)
      .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
      .limit(1);
    return f?.vt === "concierge_v1";
  });
}

export interface ConciergeRequest {
  type: string;
  stage: string;
}

/** Чистая выборка открытых запросов гостя — переиспользуется tool'ом и тестами. */
export async function listOpenRequests(opts: {
  db: Db;
  tenantId: number;
  contactId: number;
}): Promise<ConciergeRequest[]> {
  return withTenant(opts.db, opts.tenantId, async (tx) => {
    const rows = await tx
      .select({
        requestType: leads.requestType,
        state: leads.state,
        stageName: stageDefinitions.displayName,
      })
      .from(leads)
      .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
      .where(
        and(
          eq(leads.tenantId, opts.tenantId),
          eq(leads.userId, opts.contactId),
          notInArray(stageDefinitions.kind, ["terminal_won", "terminal_lost"]),
        ),
      )
      .orderBy(desc(leads.updatedAt));
    return rows.map((r) => ({
      type: r.requestType ? (REQUEST_TYPE_LABEL[r.requestType] ?? r.requestType) : "запрос",
      stage: r.stageName ?? r.state,
    }));
  });
}

/**
 * Tool: открытые запросы текущего гостя. conversation-bound — contactId
 * резолвится из conversationId внутри execute (lazy, только при вызове tool'а).
 */
export function makeConciergeRequestsTool(opts: {
  db: Db;
  tenantId: number;
  conversationId: number;
}): AnyRagTool {
  return {
    name: "list_my_requests",
    description:
      "Возвращает открытые запросы текущего гостя — тип услуги и текущую стадию. " +
      "Вызывай, когда гость спрашивает про статус своих заказов/запросов " +
      "(«что с моим заказом», «статус», «мои запросы», «как там трансфер»).",
    parameters: z.object({}),
    execute: async () => {
      const [conv] = await withTenant(opts.db, opts.tenantId, (tx) =>
        tx
          .select({ userId: conversations.userId })
          .from(conversations)
          .where(eq(conversations.id, opts.conversationId))
          .limit(1),
      );
      if (!conv?.userId) return { requests: [] };
      const requests = await listOpenRequests({
        db: opts.db,
        tenantId: opts.tenantId,
        contactId: conv.userId,
      });
      return { requests };
    },
  };
}

// ── Клик-витрина (Telegram inline buttons) ───────────────────────────────────

/**
 * Кнопки витрины «Чем помочь?» — берутся из поля request_type intake-стадии
 * активной воронки (единый источник истины: тот же optionsJson, что задаёт
 * ветки). callbackData = "req:<value>". "other" исключаем (свободный ввод).
 * Возвращает null, если воронка не concierge-подобная (нет поля request_type).
 */
export async function buildVitrinaButtons(
  db: Db,
  tenantId: number,
): Promise<ReplyMarkup | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [funnel] = await tx
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
      .limit(1);
    if (!funnel) return null;
    const [intake] = await tx
      .select({ id: stageDefinitions.id })
      .from(stageDefinitions)
      .where(eq(stageDefinitions.funnelId, funnel.id))
      .orderBy(asc(stageDefinitions.position))
      .limit(1);
    if (!intake) return null;
    const [field] = await tx
      .select({ optionsJson: stageFields.optionsJson })
      .from(stageFields)
      .where(and(eq(stageFields.stageId, intake.id), eq(stageFields.slug, "request_type")))
      .limit(1);
    if (!field?.optionsJson) return null;
    let options: Array<{ value: string; label: string }>;
    try {
      options = JSON.parse(field.optionsJson);
    } catch {
      return null;
    }
    const inlineButtons = options
      .filter((o) => o.value && o.value !== "other")
      .map((o) => [{ label: o.label, callbackData: `req:${o.value}` }]);
    return inlineButtons.length > 0 ? { inlineButtons } : null;
  });
}

export interface CallbackContext {
  tenantId: number;
  contactId: number;
  conversationId: number;
  channelId: number;
  externalUserId: string;
  data: string;
  nowEpoch: number;
  db: Db;
}

/**
 * Хэндлер inbound callback_query для concierge: «req:<type>» — гость нажал
 * кнопку витрины. Заводим лид сразу в ветке <type>_request и возвращаем
 * подтверждение-реплику (его enqueue'ит process-inbound). Не-«req:»/не-concierge
 * → null (поведение skip сохраняется). Только эта функция гейтит на concierge.
 */
export function makeConciergeCallbackHandler(): (
  ctx: CallbackContext,
) => Promise<{ reply: OutboundEnvelope } | null> {
  // ctx.db уже tenant-scoped tx (RLS выставлена вызывающим process-inbound) —
  // запросы идут напрямую, без вложенного withTenant.
  return async (ctx) => {
    if (!ctx.data.startsWith("req:")) return null;
    const type = ctx.data.slice(4).trim();
    if (!type) return null;

    // Гейт на concierge: активная воронка привязана к concierge_v1.
    const [funnel] = await ctx.db
      .select({ vt: funnels.verticalTemplateId })
      .from(funnels)
      .where(and(eq(funnels.tenantId, ctx.tenantId), eq(funnels.isActive, true)))
      .limit(1);
    if (funnel?.vt !== "concierge_v1") return null;

    const [branch] = await ctx.db
      .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
      .from(stageDefinitions)
      .where(
        and(
          eq(stageDefinitions.tenantId, ctx.tenantId),
          eq(stageDefinitions.slug, `${type}_request`),
        ),
      )
      .limit(1);
    if (!branch) return null;

    const [lead] = await ctx.db
      .insert(leads)
      .values({
        tenantId: ctx.tenantId,
        userId: ctx.contactId,
        state: branch.slug,
        stageDefinitionId: branch.id,
        requestType: type,
        createdAt: ctx.nowEpoch,
        updatedAt: ctx.nowEpoch,
      })
      .returning({ id: leads.id });
    if (!lead) return null;
    await ctx.db.insert(leadEvents).values({
      tenantId: ctx.tenantId,
      leadId: lead.id,
      fromState: "request_received",
      toState: branch.slug,
      createdAt: ctx.nowEpoch,
    });

    const label = REQUEST_TYPE_LABEL[type] ?? type;
    return {
      reply: {
        channelId: String(ctx.channelId),
        externalUserId: ctx.externalUserId,
        parts: [{ kind: "text", text: `Принял: ${label}. Расскажите детали.` }],
      },
    };
  };
}
