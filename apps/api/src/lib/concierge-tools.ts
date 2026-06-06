// Concierge agentic tools для reply-пайплайна (resolveTools в llm-bootstrap).
//
// Сейчас один tool — list_my_requests: гость спрашивает «что с моим заказом /
// статус / мои запросы», бот вызывает tool и получает открытые запросы гостя
// (тип услуги + текущая стадия). Даёт гостю самообслуживаемый трекинг статуса
// без операторской стороны. Гейтится на concierge-тенанта (isConciergeTenant).

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import { conversations, funnels, leads, stageDefinitions } from "@chatman-media/storage";
import { and, desc, eq, notInArray } from "drizzle-orm";
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
