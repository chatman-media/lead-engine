/**
 * Дрип-диспетчер кампаний: периодический тик, который «капает» лидов из
 * активных кампаний в outbound_queue с заданной скоростью.
 *
 * Для каждой активной кампании: если с прошлой выдачи прошло ≥ drip_interval_sec,
 * берём до drip_per_tick лидов в статусе pending, шлём им приветствие кампании и
 * помечаем enqueued. Когда pending-лидов не осталось — кампания completed.
 *
 * Ограничение каналов (C5): telegram-БОТ не может писать первым тому, кто сам не
 * писал боту. Поэтому для telegram_bot охватываем только контакты с уже
 * существующей беседой; иначе лид помечается skipped (контакт не инициировал).
 * userbot/web/whatsapp таких ограничений тут не накладывают.
 */
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  contacts,
  conversations,
  leads,
  outboundQueue,
  outreachCampaignLeads,
  outreachCampaigns,
  tenants,
} from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";

export interface DripDispatcherOpts {
  nowSec: number;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

/** Один тик по всем активным тенантам. */
export async function dripDispatchTick(db: Db, opts: DripDispatcherOpts): Promise<void> {
  const activeTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id } of activeTenants) {
    try {
      await dispatchTenant(db, id, opts.nowSec);
    } catch (err) {
      opts.log?.warn?.(
        `drip-dispatcher tenant=${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Выдаёт причитающуюся порцию лидов для всех due-кампаний тенанта. */
export async function dispatchTenant(db: Db, tenantId: number, nowSec: number): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const campaigns = await tx
      .select({
        id: outreachCampaigns.id,
        greetingText: outreachCampaigns.greetingText,
        dripPerTick: outreachCampaigns.dripPerTick,
        dripIntervalSec: outreachCampaigns.dripIntervalSec,
        lastDrippedAt: outreachCampaigns.lastDrippedAt,
      })
      .from(outreachCampaigns)
      .where(
        and(eq(outreachCampaigns.tenantId, tenantId), eq(outreachCampaigns.status, "active")),
      );

    for (const c of campaigns) {
      // Не чаще, чем раз в drip_interval_sec.
      if (c.lastDrippedAt != null && nowSec - c.lastDrippedAt < c.dripIntervalSec) continue;

      const pending = await tx
        .select({
          campaignLeadId: outreachCampaignLeads.id,
          contactId: leads.userId,
          contactName: contacts.displayName,
        })
        .from(outreachCampaignLeads)
        .innerJoin(leads, eq(leads.id, outreachCampaignLeads.leadId))
        .innerJoin(contacts, eq(contacts.id, leads.userId))
        .where(
          and(
            eq(outreachCampaignLeads.campaignId, c.id),
            eq(outreachCampaignLeads.tenantId, tenantId),
            eq(outreachCampaignLeads.status, "pending"),
          ),
        )
        .orderBy(outreachCampaignLeads.id)
        .limit(Math.max(1, c.dripPerTick));

      if (pending.length === 0) {
        // Кампания исчерпана — завершаем.
        await tx
          .update(outreachCampaigns)
          .set({ status: "completed", updatedAt: nowSec })
          .where(eq(outreachCampaigns.id, c.id));
        continue;
      }

      for (const item of pending) {
        // Резолвим активный канал контакта.
        const [identity] = await tx
          .select({
            channelDbId: channels.id,
            kind: channels.kind,
            externalUserId: channelIdentities.externalUserId,
          })
          .from(channelIdentities)
          .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
          .where(
            and(
              eq(channelIdentities.contactId, item.contactId),
              eq(channels.tenantId, tenantId),
              eq(channels.status, "active"),
            ),
          )
          .limit(1);

        if (!identity) {
          await markLead(tx, item.campaignLeadId, "skipped", nowSec, "нет активного канала у контакта");
          continue;
        }

        // C5: telegram-бот не может писать холодным контактам.
        if (identity.kind === "telegram_bot") {
          const [conv] = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(eq(conversations.tenantId, tenantId), eq(conversations.userId, item.contactId)),
            )
            .limit(1);
          if (!conv) {
            await markLead(
              tx,
              item.campaignLeadId,
              "skipped",
              nowSec,
              "telegram-бот: контакт не писал боту первым",
            );
            continue;
          }
        }

        const text = renderGreeting(c.greetingText, item.contactName);
        await tx.insert(outboundQueue).values({
          tenantId,
          channelId: identity.channelDbId,
          payloadJson: JSON.stringify({
            channelId: String(identity.channelDbId),
            externalUserId: identity.externalUserId,
            parts: [{ kind: "text", text }],
          }),
          idempotencyKey: `campaign-${c.id}-cl-${item.campaignLeadId}`,
          scheduledAt: nowSec,
          createdAt: nowSec,
        });
        await markLead(tx, item.campaignLeadId, "enqueued", nowSec);
      }

      await tx
        .update(outreachCampaigns)
        .set({ lastDrippedAt: nowSec, updatedAt: nowSec })
        .where(eq(outreachCampaigns.id, c.id));
    }
  });
}

/** Подставляет имя контакта в {name}. */
export function renderGreeting(template: string, contactName: string | null): string {
  return template.replace(/\{name\}/g, (contactName ?? "").trim());
}

async function markLead(
  tx: Db,
  campaignLeadId: number,
  status: string,
  nowSec: number,
  errorReason?: string,
): Promise<void> {
  await tx
    .update(outreachCampaignLeads)
    .set({
      status,
      ...(status === "enqueued" ? { enqueuedAt: nowSec } : {}),
      ...(errorReason ? { errorReason } : {}),
      updatedAt: nowSec,
    })
    .where(eq(outreachCampaignLeads.id, campaignLeadId));
}
