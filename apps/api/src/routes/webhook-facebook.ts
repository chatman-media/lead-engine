import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  generateReplyAndEnqueue,
  type ITranscriber,
  type MemoryExtractor,
  MessagesRepo,
  OutboundQueueRepo,
  type PipelineSink,
  processInbound,
  type ReplyStrategy,
  type StageClassifier,
  type NotificationService,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  type FbWebhookPayload,
  type MessengerAdapter,
  verifyWebhookSubscription,
} from "@chatman-media/channel-facebook";
import type { PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { Hono } from "hono";
import type { ChannelRegistry } from "../channel-registry.ts";
import type { InboundRateLimiter } from "../lib/rate-limiter.ts";
import { resolvePlan } from "../lib/plans.ts";
import type { FieldExtractor } from "../lib/field-extractor.ts";
import type { PhotoProcessor } from "../lib/photo-processor.ts";
import { adminEventBus } from "../lib/admin-event-bus.ts";
import { FacebookSignatureError, verifyFacebookSignature } from "../lib/facebook-signature.ts";

/**
 * Facebook Messenger webhook handler. Зеркалит WhatsApp (тот же Meta hub-
 * handshake + X-Hub-Signature-256), отличается формат payload'а
 * (`entry[].messaging[]`) и endpoint отправки (`/me/messages`, в адаптере).
 *
 *   GET  /webhook/facebook/:slug?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
 *        → verify handshake: возвращаем challenge как plaintext если token совпадает
 *
 *   POST /webhook/facebook/:slug
 *        → payload с messaging-событиями. Один POST может содержать batch —
 *          pipeline обрабатывает каждое отдельно.
 *
 * Signature: Meta пробрасывает X-Hub-Signature-256 (HMAC-SHA256 от raw body).
 * Если `appSecret` задан (per-tenant или env) — проверяем каждый POST, reject
 * 401 на mismatch. Если не задан — bypass (dev/staging). Production ДОЛЖЕН
 * выставлять App Secret из Meta dashboard → App Settings → Basic.
 */
export function makeFacebookWebhookRoutes(opts: {
  db: Db;
  channels: ChannelRegistry;
  /** Token который Meta попросил configure в Verify Token поле webhook setup'а. */
  verifyToken: string;
  /** App secret для HMAC-SHA256 валидации. Пусто — signature check пропускается. */
  appSecret?: string;
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
  resolveTranscriber?: ((tenantId: number) => ITranscriber | null) | null;
}): Hono {
  const app = new Hono();

  // GET — verify handshake. Один раз при setup'е webhook'а в Meta dashboard.
  app.get("/webhook/facebook/:slug", (c) => {
    const slug = c.req.param("slug");
    const entry = opts.channels.getFacebookByTenant(slug)[0];
    const expectedVerifyToken = entry?.facebookVerifyToken ?? opts.verifyToken;
    const result = verifyWebhookSubscription({
      mode: c.req.query("hub.mode") ?? null,
      token: c.req.query("hub.verify_token") ?? null,
      challenge: c.req.query("hub.challenge") ?? null,
      expectedVerifyToken,
    });
    // text/plain (не json) — Meta ждёт plaintext challenge.
    if (result.ok) return c.text(result.body, 200);
    return c.text(result.body, result.status as 400 | 403);
  });

  app.post("/webhook/facebook/:slug", async (c) => {
    const startedAt = performance.now();

    // HMAC считается от RAW body — любая ре-сериализация даст другой digest.
    const rawBody = await c.req.text();

    // Per-tenant app_secret требует резолва тенанта по slug ДО проверки подписи
    // (slug публичен — он в URL вебхука). Env-secret остаётся фолбэком.
    const slug = c.req.param("slug");
    const entries = opts.channels.getFacebookByTenant(slug);
    if (entries.length === 0) {
      opts.metrics?.webhookRequests.inc(1, { channel: "facebook", status: "404" });
      return c.json({ error: "no active facebook channel for tenant" }, 404);
    }
    const entry = entries[0]!;

    // Без appSecret (ни per-tenant, ни env) — bypass (dev mode).
    const appSecret = entry.facebookAppSecret ?? opts.appSecret;
    if (appSecret) {
      try {
        verifyFacebookSignature({
          secret: appSecret,
          payload: rawBody,
          header: c.req.header("X-Hub-Signature-256"),
        });
      } catch (err) {
        opts.metrics?.webhookRequests.inc(1, { channel: "facebook", status: "401" });
        if (err instanceof FacebookSignatureError) {
          // biome-ignore lint/suspicious/noConsole: webhook diag в stdout
          console.warn("[facebook-webhook] signature rejected", err.reason);
        }
        return c.json({ error: "invalid signature" }, 401);
      }
    }

    // Rate-limit check (см. webhook-whatsapp). Per-plan limits override global cfg.
    if (opts.rateLimiter) {
      const planLimits = resolvePlan(entry.tenantPlan);
      const decision = opts.rateLimiter.check(entry.tenantId, {
        perMinute: planLimits.rateLimitPerMinute,
        perHour: planLimits.rateLimitPerHour,
      });
      if (!decision.allowed) {
        opts.metrics?.webhookRequests.inc(1, { channel: "facebook", status: "429" });
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

    const adapter = entry.adapter as MessengerAdapter;

    let payload: FbWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as FbWebhookPayload;
    } catch {
      opts.metrics?.webhookRequests.inc(1, { channel: "facebook", status: "400" });
      return c.json({ error: "invalid json" }, 400);
    }

    adapter.pushUpdate(payload);

    // Дренируем все Inbound'ы из batch'а в одном HTTP request'е.
    const iter = adapter.receive()[Symbol.asyncIterator]();
    let processedCount = 0;
    const results: unknown[] = [];
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
      // ── Phase 1: persist + classify + memory (одна короткая tx) ──
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
                      downloadVoice: (mediaRef: import("@chatman-media/channel-core").MediaRef) =>
                        entry.adapter.downloadMedia(mediaRef),
                    }
                  : {};
              })()
            : {}),
        });
      });
      // ── Phase 2: reply.generate (LLM) ВНЕ tx + enqueue новой короткой tx ──
      if (result.replyDeferred && opts.replyStrategy) {
        const gen = await generateReplyAndEnqueue({
          db: opts.db,
          tenant,
          channel,
          channelDbId: entry.channelDbId,
          inbound,
          result,
          replyStrategy: opts.replyStrategy,
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
      if (result.persisted && opts.fieldExtractor) {
        const text = inbound.parts
          .filter((p) => p.kind === "text")
          .map((p) => (p as { kind: "text"; text: string }).text)
          .join(" ")
          .trim();
        if (text.length > 0) {
          void opts.fieldExtractor
            .extract({ tenantId: entry.tenantId, contactId: result.contactId, text, db: opts.db })
            .catch(() => {});
        }
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
          preview: preview?.text.slice(0, 80) ?? null,
        });
      } else {
        opts.metrics?.inboundDeduped.inc(1, { tenant: String(entry.tenantId) });
      }
      results.push(result);
      processedCount += 1;
    }

    const elapsedSec = (performance.now() - startedAt) / 1000;
    opts.metrics?.webhookLatency.observe(elapsedSec, { channel: "facebook" });
    opts.metrics?.webhookRequests.inc(1, { channel: "facebook", status: "200" });

    return c.json({ ok: true, processed: processedCount, results });
  });

  return app;
}
