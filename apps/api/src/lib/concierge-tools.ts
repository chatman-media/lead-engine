// Concierge agentic tools для reply-пайплайна (resolveTools в llm-bootstrap).
//
// Сейчас один tool — list_my_requests: гость спрашивает «что с моим заказом /
// статус / мои запросы», бот вызывает tool и получает открытые запросы гостя
// (тип услуги + текущая стадия). Даёт гостю самообслуживаемый трекинг статуса
// без операторской стороны. Гейтится на multi-request воронку (tenantSupportsMultiRequest).

import { type Db, withTenant } from "@chatman-media/conversation-engine";
import type { AnyRagTool } from "@chatman-media/kb";
import { conversations, funnels, leads, stageDefinitions, stageFields } from "@chatman-media/storage";
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

/**
 * Multi-request capability: активная воронка ветвится по типу запроса — её
 * первая (intake) стадия имеет поле `request_type`. Зеркалит детект multiRequest
 * в field-extractor (selectNextStage), поэтому самообслуживаемый трекинг и
 * рантайм-ветвление включаются вместе. Заменяет template-специфичный
 * isConciergeTenant: способность универсальна, не привязана к concierge_v1 —
 * любую multi-request воронку (в т.ч. AI-собранную) гейт пускает одинаково.
 */
export async function tenantSupportsMultiRequest(db: Db, tenantId: number): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const [activeFunnel] = await tx
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
      .limit(1);
    if (!activeFunnel) return false;
    const [firstStage] = await tx
      .select({ id: stageDefinitions.id })
      .from(stageDefinitions)
      .where(eq(stageDefinitions.funnelId, activeFunnel.id))
      .orderBy(asc(stageDefinitions.position))
      .limit(1);
    if (!firstStage) return false;
    const [rtField] = await tx
      .select({ id: stageFields.id })
      .from(stageFields)
      .where(and(eq(stageFields.stageId, firstStage.id), eq(stageFields.slug, "request_type")))
      .limit(1);
    return !!rtField;
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
