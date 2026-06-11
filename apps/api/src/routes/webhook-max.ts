import type { MediaRef } from "@chatman-media/channel-core";
import type { MaxAdapter, MaxUpdate } from "@chatman-media/channel-max";
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
  runDeferredInboundPostProcessing,
  type StageClassifier,
  transcribeInboundVoice,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { type Context, Hono } from "hono";
import type { ChannelEntry, ChannelRegistry } from "../channel-registry.ts";
import { adminEventBus } from "../lib/admin-event-bus.ts";
import type { FieldExtractor } from "../lib/field-extractor.ts";
import type { PhotoProcessor } from "../lib/photo-processor.ts";
import { resolvePlan } from "../lib/plans.ts";
import { runPostInboundAutomation } from "../lib/post-inbound-automation.ts";
import type { InboundRateLimiter } from "../lib/rate-limiter.ts";
import type { ServiceCatalogRuntime } from "../lib/service-catalog-runtime.ts";

function matchMaxEntry(
  entries: ChannelEntry[],
  secretHeader: string,
  botId: string,
): ChannelEntry | null {
  if (botId) return entries.find((entry) => entry.externalId === botId) ?? null;
  if (secretHeader) {
    const bySecret = entries.find((entry) => entry.maxWebhookSecret === secretHeader);
    if (bySecret) return bySecret;
  }
  if (entries.length === 1) return entries[0] ?? null;
  return null;
}

/**
 * MAX Bot API webhook handler.
 *
 * POST /webhook/max/:slug
 *   - validates `X-Max-Bot-Api-Secret` if configured
 *   - `message_created` → processInbound pipeline
 *
 * MAX sends one Update per webhook call. We respond 200 JSON.
 */
export function makeMaxWebhookRoutes(opts: {
  db: Db;
  channels: ChannelRegistry;
  webhookSecret?: string;
  replyStrategy?: ReplyStrategy | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  memoryExtractor?: MemoryExtractor | null;
  stageClassifier?: StageClassifier | null;
  sink?: PipelineSink;
  metrics?: PlatformMetrics;
  rateLimiter?: InboundRateLimiter;
  notificationService?: NotificationService;
  photoProcessor?: PhotoProcessor;
  fieldExtractor?: FieldExtractor;
  serviceCatalogRuntime?: ServiceCatalogRuntime;
  resolveTranscriber?: ((tenantId: number) => ITranscriber | null) | null;
}): Hono {
  const app = new Hono();

  const handleWebhook = async (c: Context) => {
    const startedAt = performance.now();
    const rawBody = await c.req.text();
    const slug = c.req.param("slug") ?? "";
    const botId = c.req.param("botId") ?? "";
    const entries = opts.channels.getMaxByTenant(slug);
    if (entries.length === 0) {
      opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "404" });
      return c.json({ error: "no active max channel for tenant" }, 404);
    }

    const secretHeader = c.req.header("X-Max-Bot-Api-Secret") ?? "";
    const entry = matchMaxEntry(entries, secretHeader, botId);
    if (!entry) {
      opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "404" });
      return c.json({ error: "no matching max channel for webhook secret" }, 404);
    }

    const expectedSecret = entry.maxWebhookSecret ?? opts.webhookSecret;
    if (expectedSecret && secretHeader !== expectedSecret) {
      opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "401" });
      return c.json({ error: "invalid secret" }, 401);
    }

    let payload: MaxUpdate;
    try {
      payload = JSON.parse(rawBody) as MaxUpdate;
    } catch {
      opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "400" });
      return c.json({ error: "invalid json" }, 400);
    }

    if (opts.rateLimiter) {
      const planLimits = resolvePlan(entry.tenantPlan);
      const decision = opts.rateLimiter.check(entry.tenantId, {
        perMinute: planLimits.rateLimitPerMinute,
        perHour: planLimits.rateLimitPerHour,
      });
      if (!decision.allowed) {
        opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "429" });
        c.header("Retry-After", String(decision.retryAfterSec ?? 60));
        return c.json(
          {
            error: "rate_limit_exceeded",
            reason: decision.reason,
            retryAfterSec: decision.retryAfterSec,
          },
          429,
        );
      }
    }

    if (payload.update_type !== "message_created") {
      opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "200" });
      return c.json({ ok: true, processed: 0 });
    }

    const adapter = entry.adapter as MaxAdapter;
    adapter.pushUpdate(payload);

    const iter = adapter.receive()[Symbol.asyncIterator]();
    let processedCount = 0;
    while (processedCount < 50) {
      const racy = Promise.race([
        iter.next(),
        new Promise<IteratorResult<never>>((r) =>
          setTimeout(() => r({ value: undefined as never, done: true }), 50),
        ),
      ]);
      const next = await racy;
      if (next.done) break;
      const inbound = next.value;
      const template = opts.resolveTemplate?.(entry.tenantSlug);
      const tenant = {
        tenantId: entry.tenantId,
        slug: entry.tenantSlug,
        llmBillingMode: "byok" as const,
      };
      const channel = {
        channelId: entry.channelDbId,
        kind: entry.kind,
        externalId: entry.externalId,
      };

      await transcribeInboundVoice(inbound, {
        tenantId: entry.tenantId,
        resolveTranscriber: opts.resolveTranscriber
          ? () => opts.resolveTranscriber?.(entry.tenantId) ?? null
          : null,
        downloadVoice: (mediaRef: MediaRef) => entry.adapter.downloadMedia(mediaRef),
        ...(opts.sink ? { sink: opts.sink } : {}),
      });

      let result = await withTenant(opts.db, entry.tenantId, async (tx) => {
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
          notifications: opts.notificationService,
          reply: opts.replyStrategy ?? null,
          deferReply: true,
          deferPostProcessing: Boolean(opts.memoryExtractor || opts.stageClassifier),
          ...(template ? { template } : {}),
          ...(opts.sink ? { sink: opts.sink } : {}),
        });
      });

      if (result.postProcessingDeferred) {
        await runDeferredInboundPostProcessing({
          db: opts.db,
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
          db: opts.db,
          tenantId: entry.tenantId,
          contactId: result.contactId,
          conversationId: result.conversationId,
          inbound,
          fieldExtractor: opts.fieldExtractor,
          serviceCatalogRuntime: opts.serviceCatalogRuntime,
        });
      }

      if (result.replyDeferred && opts.replyStrategy) {
        const gen = await generateReplyAndEnqueue({
          db: opts.db,
          tenant,
          channel,
          channelDbId: entry.channelDbId,
          inbound,
          result,
          replyStrategy: opts.replyStrategy,
          notifications: opts.notificationService,
          ...(opts.sink ? { sink: opts.sink } : {}),
        });
        result = { ...result, outboundEnqueued: gen.outboundEnqueued };
      }
      if (result.persisted && opts.photoProcessor) {
        void opts.photoProcessor
          .process({
            tenantId: entry.tenantId,
            inbound,
            adapter,
            contactId: result.contactId,
            db: opts.db,
          })
          .catch(() => {});
      }
      if (result.persisted) {
        const preview = inbound.parts.find((p) => p.kind === "text") as
          | { kind: "text"; text: string }
          | undefined;
        adminEventBus.emit({
          type: "new_message",
          tenantId: entry.tenantId,
          conversationId: result.conversationId,
          contactId: result.contactId,
          preview: preview?.text.slice(0, 180) ?? null,
          role: "user",
        });
      } else {
        opts.metrics?.inboundDeduped.inc(1, { tenant: String(entry.tenantId) });
      }
      processedCount += 1;
    }

    const elapsedSec = (performance.now() - startedAt) / 1000;
    opts.metrics?.webhookLatency.observe(elapsedSec, { channel: "max" });
    opts.metrics?.webhookRequests.inc(1, { channel: "max", status: "200" });

    return c.json({ ok: true, processed: processedCount });
  };

  app.post("/webhook/max/:slug", handleWebhook);
  app.post("/webhook/max/:slug/:botId", handleWebhook);

  return app;
}
