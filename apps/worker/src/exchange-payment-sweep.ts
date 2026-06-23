/**
 * Payment-TTL sweep (п.22 ТЗ) для обменника. Минутное разрешение — в отличие
 * от daily checkin-sweep. Логика по exchange_orders в статусе 'awaiting_payment':
 *   1. rate_expires_at < now и ещё не напоминали (last_reminder_at IS NULL) →
 *      напомнить клиенту, что котировка/реквизиты истекли, предложить
 *      запросить актуальный курс/кошелёк. Ставим last_reminder_at = now.
 *   2. rate_expires_at + GRACE < now (после напоминания так и не оплатил) →
 *      переводим заявку в 'expired'.
 *
 * Канал клиента находится через channel_identities (как в checkin-sweep).
 * Идемпотентность напоминания: ключ `exch-remind:<orderId>:<rateExpiresAt>`.
 */

import { type Db, OutboundQueueRepo, withTenant } from "@chatman-media/conversation-engine";
import { channelIdentities, channels, exchangeOrders, tenants } from "@chatman-media/storage";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

const EXCLUDED_KINDS = ["web"];
/** Грейс после истечения TTL до автоматического expire (сек). */
const GRACE_SECONDS = 10 * 60;

export class ExchangePaymentSweeper {
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      intervalMs: number;
      reminderText?: string;
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
        console.error("[exchange-payment-sweep] error", err);
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
    for (const { id } of activeTenants) {
      await this.sweepTenant(id, now).catch((err) =>
        console.error(`[exchange-payment-sweep] tenant=${id}`, err),
      );
    }
  }

  private async sweepTenant(tenantId: number, now: number): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      const expired = await tx
        .select({
          id: exchangeOrders.id,
          contactId: exchangeOrders.contactId,
          telegramId: exchangeOrders.telegramId,
          conversationId: exchangeOrders.conversationId,
          rateExpiresAt: exchangeOrders.rateExpiresAt,
          lastReminderAt: exchangeOrders.lastReminderAt,
          assetFrom: exchangeOrders.assetFrom,
        })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.tenantId, tenantId),
            eq(exchangeOrders.status, "awaiting_payment"),
            isNotNull(exchangeOrders.rateExpiresAt),
            lt(exchangeOrders.rateExpiresAt, now),
          ),
        );
      if (expired.length === 0) return;

      // Каналы для контактов (как в checkin-sweep).
      const contactIds = [
        ...new Set(expired.map((o) => o.contactId).filter((x): x is number => x != null)),
      ];
      const identityByContact = new Map<
        number,
        { channelId: number; channelExternalId: string; externalUserId: string }
      >();
      if (contactIds.length > 0) {
        const identities = await tx
          .select({
            contactId: channelIdentities.contactId,
            channelId: channelIdentities.channelId,
            externalUserId: channelIdentities.externalUserId,
            channelExternalId: channels.externalId,
            channelKind: channels.kind,
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
              sql`${channels.kind} NOT IN (${sql.join(
                EXCLUDED_KINDS.map((k) => sql`${k}`),
                sql`, `,
              )})`,
            ),
          );
        for (const i of identities) {
          if (!identityByContact.has(i.contactId)) {
            identityByContact.set(i.contactId, {
              channelId: i.channelId,
              channelExternalId: i.channelExternalId,
              externalUserId: i.externalUserId,
            });
          }
        }
      }

      const repo = new OutboundQueueRepo({ db: tx, tenantId });
      let reminded = 0;
      let expiredCount = 0;

      for (const order of expired) {
        const overGrace = order.rateExpiresAt !== null && now > order.rateExpiresAt + GRACE_SECONDS;

        // Уже напоминали и грейс прошёл → expire.
        if (order.lastReminderAt !== null && overGrace) {
          await tx
            .update(exchangeOrders)
            .set({ status: "expired", updatedAt: now })
            .where(eq(exchangeOrders.id, order.id));
          expiredCount++;
          continue;
        }

        // Ещё не напоминали → напомнить (если есть канал).
        if (order.lastReminderAt === null) {
          const identity =
            order.contactId != null ? identityByContact.get(order.contactId) : undefined;
          if (identity) {
            const text =
              this.opts.reminderText ??
              "Напоминаем: время на оплату по заявке истекает. Если ещё планируете обмен — напишите, " +
                "и мы пришлём актуальный курс и реквизиты. ⏳";
            await repo.enqueue({
              channelId: identity.channelId,
              conversationId: order.conversationId,
              envelope: {
                channelId: identity.channelExternalId,
                externalUserId: identity.externalUserId,
                parts: [{ kind: "text", text }],
                idempotencyKey: `exch-remind:${order.id}:${order.rateExpiresAt}`,
              },
              nowEpoch: now,
            });
          }
          await tx
            .update(exchangeOrders)
            .set({ lastReminderAt: now, updatedAt: now })
            .where(eq(exchangeOrders.id, order.id));
          reminded++;
        }
      }

      if (reminded > 0 || expiredCount > 0) {
        console.log(
          `[exchange-payment-sweep] tenant=${tenantId} reminded=${reminded} expired=${expiredCount}`,
        );
      }
    });
  }
}
