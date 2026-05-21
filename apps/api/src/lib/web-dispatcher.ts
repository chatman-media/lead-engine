import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
  type Db,
  OutboundQueueRepo,
  type OutboundQueueRow,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { JsonLogger, PlatformMetrics } from "@chatman-media/observability";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import type { WebChannelRegistry } from "./web-channel-registry.ts";

/**
 * Outbound dispatcher для web-канала. Mirror'ит `apps/worker/src/dispatcher.ts`,
 * но claim'ит ТОЛЬКО `kind='web'` rows (через `kinds:["web"]` filter в
 * `OutboundQueueRepo.claimPending`).
 *
 * Зачем здесь, а не в worker'е: `WebChannelAdapter.send()` пишет в
 * pinned WebSocket → connection живёт в HTTP-сервере apps/api. Worker
 * до него не достанется. Кросс-process delivery через Redis pub/sub —
 * over-engineering для текущего scope'а.
 *
 * SKIP LOCKED + status='processing' дают safety на случай если
 * apps/api запущен в нескольких репликах: каждая web row уйдёт ровно
 * одной реплике (а user-connection pinned'ится к ней через sticky
 * sessions на LB / cookie hash).
 */
export class WebOutboundDispatcher {
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly channels: WebChannelRegistry,
    private readonly opts: {
      pollMs: number;
      batchSize: number;
      metrics?: PlatformMetrics;
      log: JsonLogger;
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
        this.opts.log.error("web dispatcher tick error", {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async tick(): Promise<void> {
    // Без web-каналов tick — no-op, чтобы не тратить SELECT на tenants.
    if (this.channels.size() === 0) return;

    const activeTenants = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));

    // См. dispatcher.ts (worker): каждый repo-вызов оборачивается в
    // withTenant, иначе на non-BYPASSRLS role'и policy tenant_isolation
    // отрезала бы все UPDATE'ы. adapter.send (WS-frame) делается ВНЕ tx.
    const now = Math.floor(Date.now() / 1000);
    for (const t of activeTenants) {
      const claimed = await withTenant(this.db, t.id, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: t.id });
        return txRepo.claimPending({
          limit: this.opts.batchSize,
          nowEpoch: now,
          kinds: ["web"],
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
      // claimPending ОТФИЛЬТРОВАЛ по kind='web' — попадание сюда означает
      // что web-канал есть в БД, но в registry не загружен (race с
      // hot-discovery'ем нового tenant'а). markFailed → row будет видна
      // в admin'е как стрёмная.
      await this.markFailed(row, `web registry miss for channel_id=${row.channelId}`);
      this.opts.metrics?.outboundFailed.inc(1, {
        ...tenantLabel,
        reason: "web_registry_miss",
      });
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
    const startedAt = performance.now();
    try {
      const sent = await entry.adapter.send(envelope);
      const sentAt = Math.floor(Date.now() / 1000);
      await withTenant(this.db, row.tenantId, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: row.tenantId });
        await txRepo.markSent(row.id, sent.externalMessageId, sentAt);
      });
      const dispatchLag = sentAt - row.createdAt;
      this.opts.metrics?.outboundSent.inc(1, { ...tenantLabel, kind: "web" });
      this.opts.metrics?.outboundDispatchLatency.observe(
        Math.max(dispatchLag, (performance.now() - startedAt) / 1000),
        tenantLabel,
      );
    } catch (err) {
      // Включая WebDeliveryError ("no active connection") — пользователь
      // offline, доставка failed. Future: retry-policy + exp-backoff через
      // status='pending' + scheduled_at. Пока — terminal fail.
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(row, msg);
      this.opts.metrics?.outboundFailed.inc(1, {
        ...tenantLabel,
        reason: msg.startsWith("WebChannel:") ? "web_offline" : "send_error",
      });
    }
  }

  private async markFailed(row: OutboundQueueRow, error: string): Promise<void> {
    await withTenant(this.db, row.tenantId, async (tx) => {
      const txRepo = new OutboundQueueRepo({ db: tx, tenantId: row.tenantId });
      await txRepo.markFailed(row.id, error);
    });
  }
}
