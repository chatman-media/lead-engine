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
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  verifyWebhookSubscription,
  type WaWebhookPayload,
  type WhatsAppCloudAdapter,
} from "@chatman-media/channel-whatsapp";
import type { PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { Hono } from "hono";
import type { ChannelRegistry } from "../channel-registry.ts";
import type { InboundRateLimiter } from "../lib/rate-limiter.ts";
import type { FieldExtractor } from "../lib/field-extractor.ts";
import type { PhotoProcessor } from "../lib/photo-processor.ts";
import {
  verifyWhatsAppSignature,
  WhatsAppSignatureError,
} from "../lib/whatsapp-signature.ts";

/**
 * WhatsApp Cloud webhook handler. Meta делает два типа запросов:
 *
 *   GET  /webhook/whatsapp/:slug?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
 *        → verify handshake: возвращаем challenge как plaintext если token совпадает
 *
 *   POST /webhook/whatsapp/:slug
 *        → payload с events (messages/statuses/etc). Один POST может содержать
 *          batch из N сообщений; pipeline обрабатывает каждое отдельно.
 *
 * Signature verification: Meta пробрасывает X-Hub-Signature-256 с
 * HMAC-SHA256 от raw body. Если `appSecret` задан в opts — проверяем
 * каждый POST, reject 401 на mismatch. Если не задан — bypass (для
 * dev/staging локальных тестов). Production deploy ДОЛЖЕН выставлять
 * appSecret из Meta dashboard → App Settings → Basic.
 */
export function makeWhatsAppWebhookRoutes(opts: {
  db: Db;
  channels: ChannelRegistry;
  /** Token который Meta попросил configure в Verify Token поле webhook setup'а. */
  verifyToken: string;
  /**
   * App secret из Meta dashboard для HMAC-SHA256 валидации
   * `X-Hub-Signature-256` header'а. Если пусто — signature check
   * пропускается (warning'ом в логах apps/api log boot'ит сценарий).
   */
  appSecret?: string;
  replyStrategy?: ReplyStrategy | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  memoryExtractor?: MemoryExtractor | null;
  stageClassifier?: StageClassifier | null;
  sink?: PipelineSink;
  metrics?: PlatformMetrics;
  rateLimiter?: InboundRateLimiter;
  photoProcessor?: PhotoProcessor;
  fieldExtractor?: FieldExtractor;
  resolveTranscriber?: ((tenantId: number) => ITranscriber | null) | null;
}): Hono {
  const app = new Hono();

  // GET — verify handshake. Один раз при setup'е webhook'а в Meta dashboard.
  app.get("/webhook/whatsapp/:slug", (c) => {
    const result = verifyWebhookSubscription({
      mode: c.req.query("hub.mode") ?? null,
      token: c.req.query("hub.verify_token") ?? null,
      challenge: c.req.query("hub.challenge") ?? null,
      expectedVerifyToken: opts.verifyToken,
    });
    // text/plain (не json) — Meta ждёт plaintext challenge.
    if (result.ok) return c.text(result.body, 200);
    return c.text(result.body, result.status as 400 | 403);
  });

  app.post("/webhook/whatsapp/:slug", async (c) => {
    const startedAt = performance.now();

    // ── Signature verification ДО любых других проверок ──────────────
    // 1. Без appSecret — bypass (dev mode); warning'ом в boot-логе.
    // 2. HMAC считается от RAW request body (c.req.text), не от
    //    re-сериализованного JSON — иначе любая нормализация (whitespace
    //    / key order / unicode escape) даст другой digest.
    // 3. Расположение ПЕРЕД tenant lookup — anti-enumeration: 404 vs 401
    //    раскрыло бы attacker'у какие slug'и есть в платформе.
    const rawBody = await c.req.text();
    if (opts.appSecret) {
      try {
        verifyWhatsAppSignature({
          secret: opts.appSecret,
          payload: rawBody,
          header: c.req.header("X-Hub-Signature-256"),
        });
      } catch (err) {
        opts.metrics?.webhookRequests.inc(1, { channel: "whatsapp", status: "401" });
        if (err instanceof WhatsAppSignatureError) {
          // biome-ignore lint/suspicious/noConsole: webhook diag в stdout
          console.warn("[whatsapp-webhook] signature rejected", err.reason);
        }
        return c.json({ error: "invalid signature" }, 401);
      }
    }

    const slug = c.req.param("slug");
    const entries = opts.channels.getWhatsAppByTenant(slug);
    if (entries.length === 0) {
      opts.metrics?.webhookRequests.inc(1, { channel: "whatsapp", status: "404" });
      return c.json({ error: "no active whatsapp channel for tenant" }, 404);
    }
    const entry = entries[0]!;

    // Rate-limit check (см. webhook-telegram).
    if (opts.rateLimiter) {
      const decision = opts.rateLimiter.check(entry.tenantId);
      if (!decision.allowed) {
        opts.metrics?.webhookRequests.inc(1, { channel: "whatsapp", status: "429" });
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

    const adapter = entry.adapter as WhatsAppCloudAdapter;

    let payload: WaWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WaWebhookPayload;
    } catch {
      opts.metrics?.webhookRequests.inc(1, { channel: "whatsapp", status: "400" });
      return c.json({ error: "invalid json" }, 400);
    }

    adapter.pushUpdate(payload);

    // Дренируем все Inbound'ы из batch'а (один webhook может содержать
    // несколько messages — все процессим в одном HTTP request'е).
    const iter = adapter.receive()[Symbol.asyncIterator]();
    let processedCount = 0;
    const results: unknown[] = [];
    // Тиражируем по очереди до тех пор пока inbox не опустеет.
    // Drain-loop с timeout'ом, чтобы не висеть бесконечно.
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
      // См. webhook-telegram.ts по split-rationale. Для batch'а каждое
      // сообщение получает свою phase1+phase2 пару — если 49-е fail'нёт,
      // первые 48 уже committed.
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
      if (!result.persisted) {
        opts.metrics?.inboundDeduped.inc(1, { tenant: String(entry.tenantId) });
      }
      results.push(result);
      processedCount += 1;
    }

    const elapsedSec = (performance.now() - startedAt) / 1000;
    opts.metrics?.webhookLatency.observe(elapsedSec, { channel: "whatsapp" });
    opts.metrics?.webhookRequests.inc(1, { channel: "whatsapp", status: "200" });

    return c.json({ ok: true, processed: processedCount, results });
  });

  return app;
}
