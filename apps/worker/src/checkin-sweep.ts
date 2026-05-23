/**
 * Check-in sweep: проактивно пингует лиды, у которых не было активности
 * дольше чем stage_definitions.checkin_interval_days.
 *
 * Логика:
 *   1. SELECT активных tenant'ов.
 *   2. Для каждого — найти leads с stageDefinitionId != null,
 *      где stage.checkinIntervalDays > 0 И
 *      COALESCE(leads.lastCheckinAt, leads.updatedAt) < now - (interval * 86400)
 *      И stage.kind IN ('intake', 'active').
 *   3. Для каждого такого лида:
 *      a. Найти channel_identities контакта (кроме web-каналов).
 *      b. Найти conversation для этого контакта + source.
 *      c. Поставить outbound text-сообщение в очередь (идемпотентно).
 *      d. Обновить leads.last_checkin_at = now.
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
    await withTenant(this.db, tenantId, async (tx) => {
      // Find leads overdue for a check-in.
      // COALESCE(last_checkin_at, updated_at) is the "last contact" timestamp.
      const overdueLeads = await tx
        .select({
          id: leads.id,
          userId: leads.userId,
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

        await tx
          .update(leads)
          .set({ lastCheckinAt: now })
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
