/**
 * Operations-watcher (#144). Периодически проверяет операционное здоровье
 * обменника по DB-наблюдаемым сигналам и поднимает алерты владельцу (доставку
 * — severity-роутинг Telegram+email — навешивает #145 через OpsAlertSink):
 *
 *   1. rate_feed_stale — auto-курсы давно не обновлялись (фид встал / сыпется).
 *      Покрывает и «feed down»: симптом виден по max(updated_at).
 *   2. order_stuck — заявка зависла в 'paid'/'payout' (клиент оплатил, выдачи нет).
 *   3. channel_down — канал в статусе 'error' (бот молча не отвечает лидам).
 *      Закрывает дыру health-watcher'а: он метит status, но никого не зовёт.
 *   4. volume_spike — оборот за час выше порога (слитая ликвидность / атака).
 *      По умолчанию отключён (порог 0), чтобы не шуметь.
 *
 * Дрейф base_rate vs ЖИВОЙ рынок и алерт о резком скачке курса делаются в
 * apps/api рядом с рыночным фидом (там уже фетчится рынок) — см. rate-feed.ts.
 *
 * Анти-шторм: in-memory cooldown на (tenant, dedupKey). Переживает сам sweep,
 * но не рестарт процесса (после рестарта возможен один повторный алерт — это не
 * шторм). Persisted-дедуп — возможный follow-up.
 */

import {
  type Db,
  type OpsAlert,
  type OpsAlertSink,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  channels,
  exchangeOrders,
  exchangeRates,
  exchangeSettings,
  tenants,
} from "@chatman-media/storage";
import { and, eq, gte, inArray, lt, max, sql } from "drizzle-orm";

// OpsAlert / OpsAlertSink / OpsAlertKind / OpsSeverity живут в conversation-engine
// (их использует и роутер доставки #145). Ре-экспорт — чтобы импорт из этого
// модуля продолжал работать.
export type {
  OpsAlert,
  OpsAlertKind,
  OpsAlertSink,
  OpsSeverity,
} from "@chatman-media/conversation-engine";

export interface OpsWatchThresholds {
  /** Курс auto-строк не обновлялся дольше N минут → фид встал. */
  feedStaleMin: number;
  /** Заявка в paid/payout дольше N минут → зависла. */
  stuckOrderMin: number;
  /** Оборот за час выше N THB → всплеск. 0 — отключить. */
  volumeSpikeThb: number;
  /** Не повторять алерт одного типа чаще N минут. */
  alertCooldownMin: number;
}

export interface OpsWatchOpts {
  intervalMs: number;
  sink: OpsAlertSink;
  thresholds: OpsWatchThresholds;
}

/**
 * Эффективный порог «курсы устарели» (сек) для тенанта: явный feed_stale_sec,
 * иначе авто = max(envStaleSec, 3 × rate_refresh_sec) — чтобы медленный per-tenant
 * интервал не давал ложных rate_feed_stale.
 */
export function effectiveStaleSec(
  envStaleSec: number,
  settings: { rateRefreshSec?: number | null; feedStaleSec?: number | null } | undefined,
): number {
  if (settings?.feedStaleSec != null) return settings.feedStaleSec;
  return Math.max(envStaleSec, 3 * (settings?.rateRefreshSec ?? 0));
}

const STUCK_STATUSES = ["paid", "payout"] as const;
const VOLUME_STATUSES = ["paid", "payout", "completed"] as const;

export class OperationsWatchSweeper {
  private stopped = false;
  /** key `${tenantId}:${dedupKey}` → epoch последнего алерта. */
  private readonly lastAlertedAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly opts: OpsWatchOpts,
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });
    while (!this.stopped) {
      try {
        await this.sweep();
      } catch (err) {
        console.error("[ops-watch] error", err);
      }
      await new Promise((r) => setTimeout(r, this.opts.intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** true, если по этому (tenant, dedupKey) пора снова алертить; помечает время. */
  private shouldEmit(tenantId: number, dedupKey: string, now: number): boolean {
    const key = `${tenantId}:${dedupKey}`;
    const cooldownSec = this.opts.thresholds.alertCooldownMin * 60;
    const last = this.lastAlertedAt.get(key);
    if (last !== undefined && now - last < cooldownSec) return false;
    this.lastAlertedAt.set(key, now);
    return true;
  }

  private async emit(alert: OpsAlert, now: number): Promise<void> {
    if (!this.shouldEmit(alert.tenantId, alert.dedupKey, now)) return;
    try {
      await this.opts.sink.emit(alert);
    } catch (err) {
      console.error(
        `[ops-watch] sink emit failed kind=${alert.kind} tenant=${alert.tenantId}`,
        err,
      );
    }
  }

  async sweep(): Promise<void> {
    const activeTenants = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));
    const now = Math.floor(Date.now() / 1000);
    for (const { id } of activeTenants) {
      await this.sweepTenant(id, now).catch((err) =>
        console.error(`[ops-watch] tenant=${id}`, err),
      );
    }
  }

  async sweepTenant(tenantId: number, now: number): Promise<void> {
    const t = this.opts.thresholds;
    await withTenant(this.db, tenantId, async (tx) => {
      // Per-tenant порог «устарело»: явный feed_stale_sec, иначе авто (3 × refresh).
      const [settings] = await tx
        .select({
          rateRefreshSec: exchangeSettings.rateRefreshSec,
          feedStaleSec: exchangeSettings.feedStaleSec,
        })
        .from(exchangeSettings)
        .where(eq(exchangeSettings.tenantId, tenantId))
        .limit(1);
      const staleSec = effectiveStaleSec(t.feedStaleMin * 60, settings);

      // 1. Feed staleness (только auto-курсы — у ручных updated_at не двигается).
      const [{ maxUpdated } = { maxUpdated: null }] = await tx
        .select({ maxUpdated: max(exchangeRates.updatedAt) })
        .from(exchangeRates)
        .where(
          and(
            eq(exchangeRates.tenantId, tenantId),
            eq(exchangeRates.autoUpdate, true),
            eq(exchangeRates.isActive, true),
          ),
        );
      if (maxUpdated !== null && maxUpdated !== undefined) {
        const ageSec = now - Number(maxUpdated);
        if (ageSec > staleSec) {
          const mins = Math.floor(ageSec / 60);
          await this.emit(
            {
              tenantId,
              kind: "rate_feed_stale",
              severity: "warning",
              title: "Курсы не обновляются",
              detail: `Авто-курсы не обновлялись ${mins} мин (порог ${Math.round(staleSec / 60)}). Рыночный фид мог встать — бот может котировать устаревший курс.`,
              dedupKey: "rate_feed_stale",
            },
            now,
          );
        }
      }

      // 2. Stuck orders (оплачено, но выдача зависла).
      const stuck = await tx
        .select({
          id: exchangeOrders.id,
          status: exchangeOrders.status,
          updatedAt: exchangeOrders.updatedAt,
          amountToThb: exchangeOrders.amountToThb,
        })
        .from(exchangeOrders)
        .where(
          and(
            eq(exchangeOrders.tenantId, tenantId),
            inArray(exchangeOrders.status, [...STUCK_STATUSES]),
            lt(exchangeOrders.updatedAt, now - t.stuckOrderMin * 60),
          ),
        );
      for (const o of stuck) {
        const mins = Math.floor((now - Number(o.updatedAt)) / 60);
        await this.emit(
          {
            tenantId,
            kind: "order_stuck",
            severity: "critical",
            title: "Заявка зависла",
            detail: `Заявка #${o.id} в статусе '${o.status}' уже ${mins} мин (${o.amountToThb} THB). Клиент мог оплатить — проверьте выдачу.`,
            dedupKey: `order_stuck:${o.id}`,
          },
          now,
        );
      }

      // 3. Volume spike (оборот за последний час).
      if (t.volumeSpikeThb > 0) {
        const [{ total } = { total: 0 }] = await tx
          .select({ total: sql<number>`coalesce(sum(${exchangeOrders.amountToThb}), 0)` })
          .from(exchangeOrders)
          .where(
            and(
              eq(exchangeOrders.tenantId, tenantId),
              inArray(exchangeOrders.status, [...VOLUME_STATUSES]),
              gte(exchangeOrders.createdAt, now - 3600),
            ),
          );
        if (Number(total) > t.volumeSpikeThb) {
          await this.emit(
            {
              tenantId,
              kind: "volume_spike",
              severity: "warning",
              title: "Всплеск оборота",
              detail: `Оборот за час ${Math.round(Number(total))} THB > порога ${t.volumeSpikeThb}. Проверьте ликвидность и поток заявок.`,
              dedupKey: "volume_spike",
            },
            now,
          );
        }
      }

      // 4. Channel down (бот молча не отвечает).
      const down = await tx
        .select({ id: channels.id, kind: channels.kind })
        .from(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.status, "error")));
      for (const ch of down) {
        await this.emit(
          {
            tenantId,
            kind: "channel_down",
            severity: "critical",
            title: "Канал не работает",
            detail: `Канал ${ch.kind} (#${ch.id}) в статусе 'error' — бот не принимает/не шлёт сообщения. Нужна переавторизация.`,
            dedupKey: `channel_down:${ch.id}`,
          },
          now,
        );
      }
    });
  }
}
