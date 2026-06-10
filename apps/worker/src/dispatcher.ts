import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
  type Db,
  type NotificationService,
  normalizeMetricLabel,
  OutboundQueueRepo,
  type OutboundQueueRow,
  ProviderRelayOrchestrator,
  ProviderRelayRepo,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { PlatformMetrics } from "@chatman-media/observability";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { WorkerChannelRegistry } from "./channel-registry.ts";

/**
 * Outbound dispatcher: long-running loop, который:
 *   1. SELECT активных tenant_id из БД
 *   2. Для каждого — claim'ает до batchSize pending → processing (атомарно
 *      через UPDATE … FOR UPDATE SKIP LOCKED → status='processing'). Multi-
 *      worker safe: каждая row пойдёт ровно одному worker'у.
 *   3. Для каждой строки — резолвит ChannelAdapter и зовёт adapter.send.
 *   4. На успех → markSent с external_message_id; на ошибку → markFailed.
 *   5. Раз в `stuckCheckPeriod` tick'ов вызывает releaseStuckProcessing —
 *      возвращает зависшие processing rows (worker умер не вызвав mark*)
 *      обратно в pending для retry'я.
 */
export class OutboundDispatcher {
  private stopped = false;
  private ticksSinceStuckCheck = 0;

  constructor(
    private readonly db: Db,
    private readonly channels: WorkerChannelRegistry,
    private readonly opts: {
      pollMs: number;
      batchSize: number;
      /** Сколько секунд держать processing до auto-recovery. Default 300 (5 мин). */
      stuckProcessingSec?: number;
      /** Каждый N-й tick запускать releaseStuckProcessing. Default 60 (=1 минута при pollMs=1000). */
      stuckCheckPeriodTicks?: number;
      /** Опциональный PlatformMetrics для счётчиков outbound_sent/failed/latency. */
      metrics?: PlatformMetrics;
      /** Optional operator notification sink for provider dispatch failures. */
      notifications?: NotificationService | null;
      /**
       * Whitelist channels.kind для claim'а. По умолчанию worker
       * обрабатывает push-channels (telegram_*, whatsapp). Web-канал
       * исключается, потому что у него адаптер живёт в apps/api с
       * pinned WebSocket-connection'ом — worker не сможет deliver и
       * mark'нет fail с reason="no_adapter".
       */
      claimKinds?: string[];
    },
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });

    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[dispatcher] tick error", err);
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * NB: каждый repo-вызов оборачивается в `withTenant(db, tenantId, ...)`,
   * который BEGIN-ит транзакцию и делает `SET LOCAL app.tenant_id = <id>`
   * — иначе на non-BYPASSRLS Postgres role'и (production setup, см.
   * миграцию 0004) policy `tenant_isolation` отрезала бы все UPDATE'ы
   * и SELECT'ы → dispatcher молча drain'ил бы 0 rows. `tenants` table
   * НЕ покрыт RLS-policy (см. comment в 0004), поэтому SELECT active
   * tenants работает без SET LOCAL.
   *
   * Важно: `adapter.send(envelope)` (HTTP / MTProto / WS) делается
   * ВНЕ транзакции — иначе мы держали бы Postgres-connection во время
   * slow external call'а и быстро упирались в pool exhaustion.
   */
  private async tick(): Promise<void> {
    const activeTenantIds = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));

    const now = Math.floor(Date.now() / 1000);
    const stuckCheckPeriod = this.opts.stuckCheckPeriodTicks ?? 60;
    const shouldCheckStuck = this.ticksSinceStuckCheck >= stuckCheckPeriod;
    if (shouldCheckStuck) this.ticksSinceStuckCheck = 0;
    else this.ticksSinceStuckCheck += 1;

    for (const t of activeTenantIds) {
      if (shouldCheckStuck) {
        const released = await withTenant(this.db, t.id, async (tx) => {
          const txRepo = new OutboundQueueRepo({ db: tx, tenantId: t.id });
          return txRepo.releaseStuckProcessing({
            nowEpoch: now,
            stuckSec: this.opts.stuckProcessingSec ?? 300,
          });
        });
        if (released > 0) {
          console.log(
            `[dispatcher] released ${released} stuck processing rows for tenant=${t.id}`,
          );
        }
      }

      const claimed = await withTenant(this.db, t.id, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: t.id });
        return txRepo.claimPending({
          limit: this.opts.batchSize,
          nowEpoch: now,
          ...(this.opts.claimKinds && this.opts.claimKinds.length > 0
            ? { kinds: this.opts.claimKinds }
            : {}),
        });
      });
      for (const row of claimed) {
        await this.deliverOne(row);
      }
    }
  }

  private async deliverOne(row: OutboundQueueRow): Promise<void> {
    const tenantLabel = { tenant: String(row.tenantId) };
    const entry = this.channels.byChannelId(row.channelId);
    if (!entry) {
      await this.markFailed(row, `no active adapter for channel_id=${row.channelId}`);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "no_adapter" });
      return;
    }
    let envelope: OutboundEnvelope;
    try {
      envelope = JSON.parse(row.payloadJson) as OutboundEnvelope;
    } catch (err) {
      await this.markFailed(row, `invalid payload_json: ${err}`);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "bad_payload" });
      return;
    }
    const now = this.nowEpoch();
    const policyError = this.validateWhatsAppPolicy(entry.kind, envelope, now);
    if (policyError) {
      await this.markFailed(row, policyError);
      await this.recordProviderDispatchFailed(row, entry.kind, envelope, policyError, now);
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "send_policy" });
      return;
    }
    const startedAt = performance.now();
    try {
      // Внешний send ВНЕ tx — иначе HTTP/MTProto latency держала бы
      // pool connection (см. doc-comment к tick()).
      const sent = await entry.adapter.send(envelope);
      const sentAt = this.nowEpoch();
      await withTenant(this.db, row.tenantId, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: row.tenantId });
        await txRepo.markSent(row.id, sent.externalMessageId, sentAt);
      });
      const dispatchLag = sentAt - row.createdAt;
      this.opts.metrics?.outboundSent.inc(1, { ...tenantLabel, kind: entry.kind });
      this.opts.metrics?.outboundDispatchLatency.observe(
        Math.max(dispatchLag, (performance.now() - startedAt) / 1000),
        tenantLabel,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(row, msg);
      await this.recordProviderDispatchFailed(row, entry.kind, envelope, msg, this.nowEpoch());
      this.opts.metrics?.outboundFailed.inc(1, { ...tenantLabel, reason: "send_error" });
    }
  }

  private validateWhatsAppPolicy(
    kind: string,
    envelope: OutboundEnvelope,
    nowEpoch: number,
  ): string | null {
    if (kind !== "whatsapp") return null;
    const meta = envelope.transport?.whatsapp;
    if (!meta) return null;
    const template = meta.template;
    if (template) {
      return template.approved
        ? null
        : `whatsapp template "${template.name}" is not marked approved`;
    }
    if (meta.requiresTemplate) {
      return "whatsapp outbound requires an approved template";
    }
    if (
      typeof meta.freeFormWindowUntil === "number" &&
      meta.freeFormWindowUntil < nowEpoch
    ) {
      return "whatsapp free-form window expired; approved template required";
    }
    return null;
  }

  private async recordProviderDispatchFailed(
    row: OutboundQueueRow,
    kind: string,
    envelope: OutboundEnvelope,
    error: string,
    nowEpoch: number,
  ): Promise<void> {
    if (kind !== "whatsapp" && !envelope.transport?.whatsapp) return;
    this.opts.metrics?.providerFailures.inc(1, {
      tenant: String(row.tenantId),
      channel_kind: normalizeMetricLabel(kind),
      reason: providerDispatchFailureReason(error),
    });
    let providerRequestId = envelope.transport?.whatsapp?.providerRequestId ?? null;
    try {
      await withTenant(this.db, row.tenantId, async (tx) => {
        if (!providerRequestId) {
          const request = await new ProviderRelayRepo({
            db: tx,
            tenantId: row.tenantId,
          }).providerRequestByOutboundQueueId(row.id);
          providerRequestId = request?.id ?? null;
        }
        if (!providerRequestId) return;
        await new ProviderRelayOrchestrator({
          db: tx,
          tenantId: row.tenantId,
        }).recordDispatchFailed({
          providerRequestId,
          error,
          outboundQueueId: row.id,
          nowEpoch,
        });
      });
    } catch (err) {
      console.error("[dispatcher] provider dispatch failure record failed", err);
    }

    try {
      if (!providerRequestId) return;
      await this.opts.notifications?.notify({
        tenantId: row.tenantId,
        eventType: "provider_request_send_failed",
        data: {
          title: "WhatsApp provider outreach failed",
          action: "Review provider request",
          providerRequestId,
          outboundQueueId: row.id,
          channelId: row.channelId,
          reason: error,
        },
      });
    } catch (err) {
      console.error("[dispatcher] provider dispatch failure notification failed", err);
    }
  }

  private nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
  }

  private async markFailed(row: OutboundQueueRow, error: string): Promise<void> {
    await withTenant(this.db, row.tenantId, async (tx) => {
      const txRepo = new OutboundQueueRepo({ db: tx, tenantId: row.tenantId });
      await txRepo.markFailed(row.id, error);
    });
  }
}

function providerDispatchFailureReason(error: string): string {
  const value = error.toLowerCase();
  if (value.includes("template")) return "template";
  if (value.includes("free-form")) return "free_form_window";
  if (value.includes("adapter")) return "no_adapter";
  if (value.includes("payload")) return "bad_payload";
  return "send_error";
}
