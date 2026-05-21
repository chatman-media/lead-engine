import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  type MemoryExtractor,
  MessagesRepo,
  OutboundQueueRepo,
  type PipelineSink,
  processInbound,
  type ReplyStrategy,
  type StageClassifier,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { JsonLogger, PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { WebChannelEntry } from "./web-channel-registry.ts";

/**
 * Per-adapter async-iterator loop, дёргающий processInbound на каждое
 * сообщение от WS-клиента. Аналог webhook-telegram, но persistent —
 * один loop живёт пока запущен apps/api process'.
 *
 * Зачем отдельный runner вместо «inline в onMessage handler'е»:
 * WebChannelAdapter.receive() уже умеет async-iterator с backpressure'ом
 * и graceful-shutdown через AbortSignal. Нам нужно только подсоединить
 * pipeline. Это даёт consistent metrics с telegram/whatsapp (одни и те
 * же inbound-counters эмитятся sink'ом из processInbound).
 */
export function startWebInboundRunner(opts: {
  entry: WebChannelEntry;
  db: Db;
  signal: AbortSignal;
  replyStrategy?: ReplyStrategy | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  memoryExtractor?: MemoryExtractor | null;
  stageClassifier?: StageClassifier | null;
  sink?: PipelineSink;
  metrics?: PlatformMetrics;
  log: JsonLogger;
}): Promise<void> {
  const { entry, db, signal, log } = opts;
  const template = opts.resolveTemplate?.(entry.tenantSlug);

  return (async () => {
    try {
      for await (const inbound of entry.adapter.receive(signal)) {
        const startedAt = performance.now();
        try {
          // См. webhook-telegram.ts — pipeline-call оборачивается в
          // withTenant для атомарности + RLS на non-bypass role'и.
          const result = await withTenant(db, entry.tenantId, async (tx) => {
            const repoCtx = { db: tx, tenantId: entry.tenantId };
            return processInbound(inbound, {
              tenant: {
                tenantId: entry.tenantId,
                slug: entry.tenantSlug,
                llmBillingMode: "byok",
              },
              channel: {
                channelId: entry.channelDbId,
                kind: "web",
                externalId: entry.externalId,
              },
              channelDbId: entry.channelDbId,
              contacts: new ContactsRepo(repoCtx),
              identities: new ChannelIdentitiesRepo(repoCtx),
              conversations: new ConversationsRepo(repoCtx),
              messages: new MessagesRepo(repoCtx),
              outbound: new OutboundQueueRepo(repoCtx),
              reply: opts.replyStrategy ?? null,
              ...(template ? { template } : {}),
              ...(opts.memoryExtractor ? { memoryExtractor: opts.memoryExtractor } : {}),
              ...(opts.stageClassifier
                ? { stageClassifier: opts.stageClassifier, db: tx }
                : {}),
              ...(opts.sink ? { sink: opts.sink } : {}),
            });
          });
          if (!result.persisted) {
            opts.metrics?.inboundDeduped.inc(1, { tenant: String(entry.tenantId) });
          }
          const elapsedSec = (performance.now() - startedAt) / 1000;
          opts.metrics?.pipelineLatency.observe(elapsedSec, {
            tenant: String(entry.tenantId),
          });
        } catch (err) {
          // Один failed inbound не должен ронять весь loop — пайплайн
          // ловит DB-ошибки наружу, мы их логируем и идём дальше.
          log.error("web inbound processInbound failed", {
            tenantId: entry.tenantId,
            channelId: entry.channelDbId,
            externalUserId: inbound.externalUserId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    } catch (err) {
      // signal.abort при graceful shutdown — receive() возвращает
      // done:true и for-await завершается без throw. Сюда попадаем только
      // на неожиданных ошибках (например, БД-disconnect в pipeline'е).
      log.error("web inbound runner exited", {
        tenantId: entry.tenantId,
        channelId: entry.channelDbId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  })();
}
