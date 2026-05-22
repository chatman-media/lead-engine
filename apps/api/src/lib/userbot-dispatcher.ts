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
import type { UserbotChannelRegistry } from "./userbot-channel-registry.ts";

/**
 * Outbound dispatcher для personal-account userbot'а. Mirror'ит
 * WebOutboundDispatcher, но claim'ит ТОЛЬКО `kind='telegram_userbot'`.
 *
 * Зачем здесь, а не в worker'е: MTProto-соединение pinned'ится к процессу
 * apps/api (тот же gramjs-client делает и receive, и send). Поэтому
 * `telegram_userbot` ИСКЛЮЧЁН из claimKinds worker'а (см. apps/worker/src/index.ts).
 */
export class UserbotOutboundDispatcher {
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly registry: UserbotChannelRegistry,
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
        this.opts.log.error("userbot dispatcher tick error", {
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
    if (this.registry.size() === 0) return;
    const activeTenants = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));
    const now = Math.floor(Date.now() / 1000);
    for (const t of activeTenants) {
      const claimed = await withTenant(this.db, t.id, async (tx) => {
        const txRepo = new OutboundQueueRepo({ db: tx, tenantId: t.id });
        return txRepo.claimPending({
          limit: this.opts.batchSize,
          nowEpoch: now,
          kinds: ["telegram_userbot"],
        });
      });
      for (const row of claimed) {
        await this.deliverOne(row);
      }
    }
  }

  private async deliverOne(row: OutboundQueueRow): Promise<void> {
    const tenantLabel = { tenant: String(row.tenantId) };
    const entry = this.registry.byChannelId(row.channelId);
    if (!entry) {
      await this.markFailed(row, `userbot registry miss for channel_id=${row.channelId}`);
      this.opts.metrics?.outboundFailed.inc(1, {
        ...tenantLabel,
        reason: "userbot_registry_miss",
      });
      return;
    }
    let envelope: OutboundEnvelope;
    try {
      envelope = JSON.parse(row.payloadJson) as OutboundEnvelope;
    } catch (err) {
      await this.markFailed(row, `invalid payload_json: ${err}`);
      this.opts.metrics?.outboundFailed.inc(1, {
        ...tenantLabel,
        reason: "bad_payload",
      });
      return;
    }
    const startedAt = performance.now();
    try {
      const sent = await entry.adapter.send(envelope);
      const sentAt = Math.floor(Date.now() / 1000);
      await withTenant(this.db, row.tenantId, async (tx) => {
        const txRepo = new OutboundQueueRepo({
          db: tx,
          tenantId: row.tenantId,
        });
        await txRepo.markSent(row.id, sent.externalMessageId, sentAt);
      });
      const dispatchLag = sentAt - row.createdAt;
      this.opts.metrics?.outboundSent.inc(1, {
        ...tenantLabel,
        kind: "telegram_userbot",
      });
      this.opts.metrics?.outboundDispatchLatency.observe(
        Math.max(dispatchLag, (performance.now() - startedAt) / 1000),
        tenantLabel,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.markFailed(row, msg);
      this.opts.metrics?.outboundFailed.inc(1, {
        ...tenantLabel,
        reason: "send_error",
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
