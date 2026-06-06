import type { Db, NotificationService } from "@chatman-media/conversation-engine";
import { withTenant } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  contacts,
  conversations,
  leadEvents,
  leads,
  messages,
  outboundQueue,
  stageDefinitions,
} from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";

export type AdvanceResult =
  | { kind: "no_lead" }
  | { kind: "terminal"; stage: string }
  | {
      kind: "advanced";
      leadId: number;
      conversationId: number | null;
      from: string;
      to: string;
      toDisplayName: string;
      awaitingOperator: boolean;
      terminal: boolean;
    };

/**
 * Operator-in-the-loop продвижение лида на следующую стадию воронки
 * (next_stages[0]). Общая логика для:
 *   - POST /conversations/:id/advance (из диалога)
 *   - POST /leads/:id/advance (со страницы лида)
 *
 * Делает: lead.state+stageDefinitionId → next, leadEvents, сообщение в чат
 * (role=assistant — «бот» ведёт клиента дальше), доставку клиенту для
 * real-канала (self_play — только в чат), и НЕ глушит AI (mode не трогаем).
 * Если новая стадия = awaiting_operator — пингует оператора (notify).
 *
 * `selector` — найти лид по leadId ИЛИ по contactId (из conversation).
 */
export async function advanceLead(opts: {
  db: Db;
  tenantId: number;
  adminId?: number;
  note?: string;
  selector: { leadId: number } | { contactId: number };
  notifications?: NotificationService | null;
}): Promise<AdvanceResult> {
  const { db, tenantId, adminId, note } = opts;
  const now = Math.floor(Date.now() / 1000);

  const result = await withTenant(db, tenantId, async (tx): Promise<AdvanceResult> => {
    // 1. lead
    const whereLead =
      "leadId" in opts.selector
        ? and(eq(leads.tenantId, tenantId), eq(leads.id, opts.selector.leadId))
        : and(eq(leads.tenantId, tenantId), eq(leads.userId, opts.selector.contactId));
    const [lead] = await tx
      .select({
        id: leads.id,
        userId: leads.userId,
        state: leads.state,
        stageDefinitionId: leads.stageDefinitionId,
      })
      .from(leads)
      .where(whereLead)
      .orderBy(desc(leads.id))
      .limit(1);
    if (!lead || !lead.stageDefinitionId) return { kind: "no_lead" };

    // 2. current stage → next
    const [cur] = await tx
      .select({
        slug: stageDefinitions.slug,
        displayName: stageDefinitions.displayName,
        nextStages: stageDefinitions.nextStages,
      })
      .from(stageDefinitions)
      .where(and(eq(stageDefinitions.id, lead.stageDefinitionId), eq(stageDefinitions.tenantId, tenantId)));
    if (!cur) return { kind: "no_lead" };
    const nextSlug = cur.nextStages[0];
    if (!nextSlug) return { kind: "terminal", stage: cur.slug };

    const [next] = await tx
      .select({
        id: stageDefinitions.id,
        slug: stageDefinitions.slug,
        displayName: stageDefinitions.displayName,
        stageType: stageDefinitions.stageType,
        nextStages: stageDefinitions.nextStages,
      })
      .from(stageDefinitions)
      .where(and(eq(stageDefinitions.slug, nextSlug), eq(stageDefinitions.tenantId, tenantId)));
    if (!next) return { kind: "terminal", stage: cur.slug };

    // 3. advance lead
    await tx
      .update(leads)
      .set({ stageDefinitionId: next.id, state: next.slug, updatedAt: now })
      .where(eq(leads.id, lead.id));
    await tx.insert(leadEvents).values({
      tenantId,
      leadId: lead.id,
      fromState: lead.state,
      toState: next.slug,
      byAdminId: adminId,
      createdAt: now,
    });

    // 4. conversation (для сообщения в чат) — берём диалог контакта.
    const [conv] = await tx
      .select({ id: conversations.id, source: conversations.source })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.userId, lead.userId)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);

    const msgText = note || `✅ ${cur.displayName} — готово. Переходим к этапу: ${next.displayName}.`;
    if (conv) {
      const [msg] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId: conv.id,
          role: "assistant",
          text: msgText,
          metaJson: JSON.stringify({ adminId, sentVia: "operator-advance", toStage: next.slug }),
          createdAt: now,
        })
        .returning({ id: messages.id });
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, lastMessageText: msgText.slice(0, 200), unreadCount: 0 })
        .where(eq(conversations.id, conv.id));

      // доставка клиенту только для реальных каналов (не self_play)
      if (conv.source !== "self_play") {
        const [identity] = await tx
          .select({ channelDbId: channels.id, externalUserId: channelIdentities.externalUserId })
          .from(channelIdentities)
          .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
          .where(and(eq(channelIdentities.contactId, lead.userId), eq(channels.status, "active")))
          .limit(1);
        if (identity) {
          await tx.insert(outboundQueue).values({
            tenantId,
            channelId: identity.channelDbId,
            conversationId: conv.id,
            payloadJson: JSON.stringify({
              channelId: String(identity.channelDbId),
              externalUserId: identity.externalUserId,
              parts: [{ kind: "text", text: msgText }],
            }),
            idempotencyKey: `op-advance-${msg!.id}`,
            scheduledAt: now,
            createdAt: now,
          });
        }
      }
    }

    return {
      kind: "advanced",
      leadId: lead.id,
      conversationId: conv?.id ?? null,
      from: cur.slug,
      to: next.slug,
      toDisplayName: next.displayName,
      awaitingOperator: next.stageType === "awaiting_operator",
      terminal: next.nextStages.length === 0,
    };
  });

  // 5. Пинг оператору, если въехали в operator-гейт (вне tx — не держим коннект).
  if (result.kind === "advanced" && result.awaitingOperator && opts.notifications) {
    try {
      const [contact] = await db
        .select({ displayName: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.id, (await resolveContactId(db, tenantId, result.leadId)) ?? -1))
        .limit(1);
      await opts.notifications.notify({
        tenantId,
        eventType: "operator_confirm_needed",
        leadId: result.leadId,
        ...(result.conversationId ? { conversationId: result.conversationId } : {}),
        data: {
          stage: result.toDisplayName,
          displayName: contact?.displayName ?? "Клиент",
        },
      });
    } catch {
      /* пинг не критичен — продвижение уже выполнено */
    }
  }

  return result;
}

async function resolveContactId(db: Db, tenantId: number, leadId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: leads.userId })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, leadId)))
    .limit(1);
  return row?.userId ?? null;
}
