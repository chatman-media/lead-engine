import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  generateReplyAndEnqueue,
  type MemoryExtractor,
  MessagesRepo,
  type NotificationService,
  OutboundQueueRepo,
  type PipelineSink,
  processInbound,
  type ReplyStrategy,
  runDeferredInboundPostProcessing,
  type StageClassifier,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { JsonLogger, PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { FieldExtractor } from "./field-extractor.ts";
import { runPostInboundAutomation } from "./post-inbound-automation.ts";
import type { ServiceCatalogRuntime } from "./service-catalog-runtime.ts";
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
  notifications?: NotificationService;
  fieldExtractor?: FieldExtractor;
  serviceCatalogRuntime?: ServiceCatalogRuntime;
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
          const tenant = {
            tenantId: entry.tenantId,
            slug: entry.tenantSlug,
            llmBillingMode: "byok" as const,
          };
          const channel = {
            channelId: entry.channelDbId,
            kind: "web" as const,
            externalId: entry.externalId,
          };
          // ── Phase 1: persist + cheap DB hooks (одна короткая tx) ──
          // См. webhook-telegram.ts — split на phases для освобождения
          // pool connection во время stage/memory/reply LLM calls.
          let result = await withTenant(db, entry.tenantId, async (tx) => {
            const repoCtx = { db: tx, tenantId: entry.tenantId };
            return processInbound(inbound, {
              tenant,
              channel,
              channelDbId: entry.channelDbId,
              contacts: new ContactsRepo(repoCtx),
              identities: new ChannelIdentitiesRepo(repoCtx),
              conversations: new ConversationsRepo(repoCtx),
              messages: new MessagesRepo(repoCtx),
              outbound: new OutboundQueueRepo(repoCtx),
              notifications: opts.notifications,
              reply: opts.replyStrategy ?? null,
              deferReply: true,
              deferPostProcessing: Boolean(opts.memoryExtractor || opts.stageClassifier),
              ...(template ? { template } : {}),
              ...(opts.sink ? { sink: opts.sink } : {}),
            });
          });
          if (result.postProcessingDeferred) {
            await runDeferredInboundPostProcessing({
              db,
              tenant,
              result,
              stageClassifier: opts.stageClassifier,
              memoryExtractor: opts.memoryExtractor,
              preferredVerticalTemplateId: template?.slug ?? null,
              ...(opts.sink ? { sink: opts.sink } : {}),
            });
          }
          if (result.persisted) {
            await runPostInboundAutomation({
              db,
              tenantId: entry.tenantId,
              contactId: result.contactId,
              conversationId: result.conversationId,
              inbound,
              fieldExtractor: opts.fieldExtractor,
              serviceCatalogRuntime: opts.serviceCatalogRuntime,
            });
          }
          // ── Phase 2: reply.generate ВНЕ tx + enqueue новой короткой tx ──
          if (result.replyDeferred && opts.replyStrategy) {
            const gen = await generateReplyAndEnqueue({
              db,
              tenant,
              channel,
              channelDbId: entry.channelDbId,
              inbound,
              result,
              replyStrategy: opts.replyStrategy,
              notifications: opts.notifications,
              ...(opts.sink ? { sink: opts.sink } : {}),
            });
            result = { ...result, outboundEnqueued: gen.outboundEnqueued };
          }
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
