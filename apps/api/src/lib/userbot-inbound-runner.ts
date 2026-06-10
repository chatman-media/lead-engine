import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  generateReplyAndEnqueue,
  type ITranscriber,
  type MemoryExtractor,
  MessagesRepo,
  type NotificationService,
  OutboundQueueRepo,
  type PipelineSink,
  processInbound,
  type ReplyStrategy,
  type StageClassifier,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { JsonLogger, PlatformMetrics } from "@chatman-media/observability";
import { channels } from "@chatman-media/storage";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { and, eq } from "drizzle-orm";
import { adminEventBus } from "./admin-event-bus.ts";
import { recordAudit } from "./audit.ts";
import type { FieldExtractor } from "./field-extractor.ts";
import type { PhotoProcessor } from "./photo-processor.ts";
import { runPostInboundAutomation } from "./post-inbound-automation.ts";
import type { ServiceCatalogRuntime } from "./service-catalog-runtime.ts";
import type { UserbotChannelEntry } from "./userbot-channel-registry.ts";

/**
 * Per-adapter loop для personal-account userbot'а — аналог
 * startWebInboundRunner, но поверх MTProto-receive(). Один loop живёт пока
 * запущен apps/api process (либо пока registry не закроет adapter → signal.abort).
 *
 * Дополнительно к inbound-обработке слушает adapter.healthEvents():
 *   - auth_key_duplicated → сессия отозвана (оператор завершил сессии в TG).
 *     Помечаем channels.status='error' + audit, чтобы UI предложил re-auth.
 *   - connection_failed → транзиентная сеть, логируем (adapter сам ретраит).
 */
export function startUserbotInboundRunner(opts: {
  entry: UserbotChannelEntry;
  db: Db;
  signal: AbortSignal;
  replyStrategy?: ReplyStrategy | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  memoryExtractor?: MemoryExtractor | null;
  stageClassifier?: StageClassifier | null;
  notifications?: NotificationService;
  photoProcessor?: PhotoProcessor;
  fieldExtractor?: FieldExtractor;
  serviceCatalogRuntime?: ServiceCatalogRuntime;
  resolveTranscriber?: ((tenantId: number) => ITranscriber | null) | null;
  sink?: PipelineSink;
  metrics?: PlatformMetrics;
  log: JsonLogger;
}): Promise<void> {
  const { entry, db, signal, log } = opts;
  const template = opts.resolveTemplate?.(entry.tenantSlug);

  // Health-watch — fire-and-forget, завершается когда adapter закрыт.
  void watchHealth(opts);

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
            kind: "telegram_userbot" as const,
            externalId: entry.externalId,
          };
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
              ...(template ? { template } : {}),
              ...(opts.memoryExtractor ? { memoryExtractor: opts.memoryExtractor } : {}),
              ...(opts.stageClassifier ? { stageClassifier: opts.stageClassifier, db: tx } : {}),
              ...(opts.sink ? { sink: opts.sink } : {}),
              ...(opts.resolveTranscriber
                ? (() => {
                    const t = opts.resolveTranscriber(entry.tenantId);
                    return t
                      ? {
                          transcriber: t,
                          downloadVoice: (mediaRef: import("@chatman-media/channel-core").MediaRef, externalUserId: string) =>
                            entry.adapter.downloadMedia(mediaRef, { externalUserId }),
                        }
                      : {};
                  })()
                : {}),
            });
          });
          if (result.replyDeferred && opts.replyStrategy) {
            const gen = await generateReplyAndEnqueue({
              db,
              tenant,
              channel,
              channelDbId: entry.channelDbId,
              inbound,
              result,
              replyStrategy: opts.replyStrategy,
              notifications: opts.notifications ?? null,
              ...(opts.sink ? { sink: opts.sink } : {}),
            });
            result = { ...result, outboundEnqueued: gen.outboundEnqueued };
          }
          if (result.persisted && opts.photoProcessor) {
            void opts.photoProcessor
              .process({
                tenantId: entry.tenantId,
                inbound,
                adapter: entry.adapter,
                contactId: result.contactId,
                db,
              })
              .catch(() => {});
          }
          if (result.persisted) {
            void runPostInboundAutomation({
              db,
              tenantId: entry.tenantId,
              contactId: result.contactId,
              conversationId: result.conversationId,
              inbound,
              fieldExtractor: opts.fieldExtractor,
              serviceCatalogRuntime: opts.serviceCatalogRuntime,
            });
          }
          if (result.persisted) {
            const inboundParts = inbound.parts as Array<{ kind: string; text?: string }>;
            const preview = inboundParts.find((p) => p.kind === "text");
            adminEventBus.emit({
              type: "new_message",
              tenantId: entry.tenantId,
              conversationId: result.conversationId,
              contactId: result.contactId,
              preview: preview?.text?.slice(0, 80) ?? null,
            });
          } else {
            opts.metrics?.inboundDeduped.inc(1, {
              tenant: String(entry.tenantId),
            });
          }
          const elapsedSec = (performance.now() - startedAt) / 1000;
          opts.metrics?.pipelineLatency.observe(elapsedSec, {
            tenant: String(entry.tenantId),
          });
        } catch (err) {
          log.error("userbot inbound processInbound failed", {
            tenantId: entry.tenantId,
            channelId: entry.channelDbId,
            externalUserId: inbound.externalUserId,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    } catch (err) {
      log.error("userbot inbound runner exited", {
        tenantId: entry.tenantId,
        channelId: entry.channelDbId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  })();
}

async function watchHealth(opts: {
  entry: UserbotChannelEntry;
  db: Db;
  log: JsonLogger;
}): Promise<void> {
  const { entry, db, log } = opts;
  try {
    for await (const ev of entry.adapter.healthEvents()) {
      if (ev.status === "auth_key_duplicated") {
        log.warn("userbot auth revoked — marking channel error", {
          tenantId: entry.tenantId,
          channelId: entry.channelDbId,
          reason: ev.reason,
        });
        try {
          await withTenant(db, entry.tenantId, async (tx) => {
            await tx
              .update(channels)
              .set({
                status: "error",
                updatedAt: Math.floor(Date.now() / 1000),
              })
              .where(
                and(eq(channels.id, entry.channelDbId), eq(channels.tenantId, entry.tenantId)),
              );
          });
          await recordAudit(db, {
            tenantId: entry.tenantId,
            adminId: undefined,
            action: "channel.error",
            targetKind: "channel",
            targetId: entry.channelDbId,
            details: {
              kind: "telegram_userbot",
              reason: "auth_key_duplicated",
            },
          });
        } catch {
          // best-effort
        }
      } else if (ev.status === "connection_failed") {
        log.warn("userbot connection failed (transient)", {
          tenantId: entry.tenantId,
          channelId: entry.channelDbId,
          reason: ev.reason,
        });
      }
    }
  } catch {
    // health-iterator завершается при close() — не шумим.
  }
}
