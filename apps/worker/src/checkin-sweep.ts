/**
 * Check-in sweep: проактивно пингует лиды, у которых не было активности
 * дольше чем stage_definitions.checkin_interval_days.
 *
 * Логика:
 *   1. SELECT активных tenant'ов.
 *   2. Для каждого — найти leads с stageDefinitionId != null,
 *      где stage.checkinIntervalDays > 0 И
 *      COALESCE(leads.lastCheckinAt, leads.updatedAt) < now - (interval * 86400)
 *      И stage.kind IN ('intake', 'active')
 *      И в диалоге не было сообщений за интервал (conversations.lastMessageAt) —
 *      чтобы не пинговать «как дела» посреди живой переписки.
 *   3. Для каждого такого лида:
 *      a. Найти channel_identities контакта (кроме web-каналов).
 *      b. Найти conversation для этого контакта + source.
 *      c. Поставить outbound text-сообщение в очередь (идемпотентно).
 *      d. Обновить leads.last_checkin_at + инкрементить checkin_count.
 *
 * Жёсткий лимит: не больше opts.maxCheckinsPerStage пингов НА СТАДИЮ. Счётчик
 * (leads.checkin_count) логически обнуляется при переходе лида на новую стадию
 * — сравнением leads.last_checkin_stage_id с текущей стадией прямо в sweep, без
 * правок кода переходов. Так клиент не получает бесконечный поток «как дела», но
 * на каждом новом этапе (оплата, выдача) напоминания снова доступны.
 */

import { OutboundQueueRepo, withTenant } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  conversations,
  leads,
  stageDefinitions,
  tenants,
} from "@chatman-media/storage";
import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@chatman-media/conversation-engine";

// Telegram bot / userbot: conversation.source = 'bot' / 'userbot'.
// WhatsApp also uses 'bot' adapter. Web excluded — worker has no web adapter.
const KIND_TO_SOURCE: Record<string, string> = {
  telegram_bot: "bot",
  telegram_userbot: "userbot",
  whatsapp: "bot",
};

const EXCLUDED_KINDS = ["web"];

export class CheckinSweeper {
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      intervalMs: number;
      /** Text sent as the check-in message. Override for locale/branding. */
      messageText?: string;
      /** Макс. пингов на стадию (см. doc). Default 2; 0 — не пинговать. */
      maxCheckinsPerStage?: number;
    },
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });

    while (!this.stopped) {
      try {
        await this.sweep();
      } catch (err) {
        console.error("[checkin-sweep] error", err);
      }
      await new Promise((r) => setTimeout(r, this.opts.intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async sweep(): Promise<void> {
    const activeTenants = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));

    const now = Math.floor(Date.now() / 1000);

    for (const { id: tenantId } of activeTenants) {
      await this.sweepTenant(tenantId, now);
    }
  }

  private async sweepTenant(tenantId: number, now: number): Promise<void> {
    const max = this.opts.maxCheckinsPerStage ?? 2;
    if (max <= 0) return; // пинги отключены
    await withTenant(this.db, tenantId, async (tx) => {
      // Find leads overdue for a check-in.
      // COALESCE(last_checkin_at, updated_at) is the "last contact" timestamp.
      const overdueLeads = await tx
        .select({
          id: leads.id,
          userId: leads.userId,
          stageId: leads.stageDefinitionId,
          checkinCount: leads.checkinCount,
          lastCheckinStageId: leads.lastCheckinStageId,
        })
        .from(leads)
        .innerJoin(
          stageDefinitions,
          and(
            eq(leads.stageDefinitionId, stageDefinitions.id),
            eq(stageDefinitions.tenantId, tenantId),
            isNotNull(stageDefinitions.checkinIntervalDays),
            or(
              eq(stageDefinitions.kind, "intake"),
              eq(stageDefinitions.kind, "active"),
            ),
          ),
        )
        .where(
          and(
            eq(leads.tenantId, tenantId),
            isNotNull(leads.stageDefinitionId),
            lt(
              sql`COALESCE(${leads.lastCheckinAt}, ${leads.updatedAt})`,
              sql`${now} - (${stageDefinitions.checkinIntervalDays} * 86400)`,
            ),
            // Не пинговать лида, у которого в диалоге была активность за интервал:
            // checkin keyed off leads.updatedAt, а оно не меняется при простой
            // переписке — иначе бот шлёт контекст-слепое «Добрый день, как дела»
            // прямо посреди живого разговора (напр. пока клиент платит).
            sql`NOT EXISTS (
              SELECT 1 FROM ${conversations}
              WHERE ${conversations.tenantId} = ${tenantId}
                AND ${conversations.userId} = ${leads.userId}
                AND ${conversations.lastMessageAt} >= ${now} - (${stageDefinitions.checkinIntervalDays} * 86400)
            )`,
            // Жёсткий лимит: не больше max пингов на стадию. На новой стадии
            // (last_checkin_stage_id != текущая, в т.ч. NULL) счётчик логически
            // обнуляется → доступна свежая квота.
            sql`(${leads.lastCheckinStageId} IS DISTINCT FROM ${leads.stageDefinitionId}
                 OR ${leads.checkinCount} < ${max})`,
          ),
        );

      if (overdueLeads.length === 0) return;

      const contactIds = overdueLeads.map((l) => l.userId);

      // Find active non-web channel identities for these contacts.
      const identities = await tx
        .select({
          contactId: channelIdentities.contactId,
          channelId: channelIdentities.channelId,
          externalUserId: channelIdentities.externalUserId,
          channelKind: channels.kind,
          channelExternalId: channels.externalId,
        })
        .from(channelIdentities)
        .innerJoin(
          channels,
          and(
            eq(channelIdentities.channelId, channels.id),
            eq(channels.tenantId, tenantId),
            eq(channels.status, "active"),
          ),
        )
        .where(
          and(
            inArray(channelIdentities.contactId, contactIds),
            // Exclude web — worker has no web adapter
            sql`${channels.kind} NOT IN (${sql.join(EXCLUDED_KINDS.map((k) => sql`${k}`), sql`, `)})`,
          ),
        );

      // Build a map contactId → first identity
      const identityByContact = new Map<
        number,
        (typeof identities)[number]
      >();
      for (const id of identities) {
        if (!identityByContact.has(id.contactId)) {
          identityByContact.set(id.contactId, id);
        }
      }

      // Find matching conversations for these contacts
      const contactsWithIdentity = [...identityByContact.keys()];
      if (contactsWithIdentity.length === 0) return;

      const convRows = await tx
        .select({
          id: conversations.id,
          userId: conversations.userId,
          source: conversations.source,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            inArray(conversations.userId, contactsWithIdentity),
          ),
        );

      // Build a map contactId → conversationId (by source match)
      const convByContact = new Map<number, number>();
      for (const conv of convRows) {
        const identity = identityByContact.get(conv.userId);
        if (!identity) continue;
        const expectedSource = KIND_TO_SOURCE[identity.channelKind];
        if (expectedSource && conv.source === expectedSource) {
          convByContact.set(conv.userId, conv.id);
        }
      }

      const text =
        this.opts.messageText ??
        "Добрый день! Хотели уточнить, как у вас дела и есть ли вопросы по вашей заявке?";

      let sent = 0;
      for (const lead of overdueLeads) {
        const identity = identityByContact.get(lead.userId);
        if (!identity) continue; // no reachable channel for this contact

        const convId = convByContact.get(lead.userId) ?? null;
        const dayBucket = Math.floor(now / 86400);
        const idempotencyKey = `checkin:${lead.id}:${dayBucket}`;

        const repo = new OutboundQueueRepo({ db: tx, tenantId });
        await repo.enqueue({
          channelId: identity.channelId,
          conversationId: convId,
          envelope: {
            channelId: identity.channelExternalId,
            externalUserId: identity.externalUserId,
            parts: [{ kind: "text", text }],
            idempotencyKey,
          },
          nowEpoch: now,
        });

        const sameStage = lead.lastCheckinStageId === lead.stageId;
        await tx
          .update(leads)
          .set({
            lastCheckinAt: now,
            checkinCount: sameStage ? lead.checkinCount + 1 : 1,
            lastCheckinStageId: lead.stageId,
          })
          .where(eq(leads.id, lead.id));

        sent++;
      }

      if (sent > 0) {
        console.log(
          `[checkin-sweep] tenant=${tenantId} queued ${sent} check-in(s)`,
        );
      }
    });
  }
}
