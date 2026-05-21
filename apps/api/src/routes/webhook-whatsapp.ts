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
import {
  verifyWebhookSubscription,
  type WaWebhookPayload,
  type WhatsAppCloudAdapter,
} from "@chatman-media/channel-whatsapp";
import type { PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { Hono } from "hono";
import type { ChannelRegistry } from "../channel-registry.ts";

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
 * Signature verification: Meta пробрасывает X-Hub-Signature-256 с HMAC-SHA256
 * от raw body. Сейчас НЕ проверяется — payload идёт открыто, fraud risk
 * минимальный т.к. payload без секретов. Проверку можно добавить отдельным
 * коммитом если понадобится (нужен app_secret из Meta dashboard).
 */
export function makeWhatsAppWebhookRoutes(opts: {
  db: Db;
  channels: ChannelRegistry;
  /** Token который Meta попросил configure в Verify Token поле webhook setup'а. */
  verifyToken: string;
  replyStrategy?: ReplyStrategy | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  memoryExtractor?: MemoryExtractor | null;
  stageClassifier?: StageClassifier | null;
  sink?: PipelineSink;
  metrics?: PlatformMetrics;
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
    const slug = c.req.param("slug");
    const entries = opts.channels.getWhatsAppByTenant(slug);
    if (entries.length === 0) {
      opts.metrics?.webhookRequests.inc(1, { channel: "whatsapp", status: "404" });
      return c.json({ error: "no active whatsapp channel for tenant" }, 404);
    }
    const entry = entries[0]!;
    const adapter = entry.adapter as WhatsAppCloudAdapter;

    let payload: WaWebhookPayload;
    try {
      payload = (await c.req.json()) as WaWebhookPayload;
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
      // См. webhook-telegram.ts — pipeline целиком в withTenant для
      // RLS на non-bypass role'и + атомарности pipeline-INSERT'ов.
      // Каждое сообщение в batch'е — отдельная tx (короче чем одна tx
      // на весь batch — если 49-е сообщение fail'нёт, первые 48 уже
      // committed).
      const result = await withTenant(opts.db, entry.tenantId, async (tx) => {
        const repoCtx = { db: tx, tenantId: entry.tenantId };
        return processInbound(inbound, {
          tenant: {
            tenantId: entry.tenantId,
            slug: entry.tenantSlug,
            llmBillingMode: "byok",
          },
          channel: {
            channelId: entry.channelDbId,
            kind: entry.kind,
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
          ...(opts.stageClassifier ? { stageClassifier: opts.stageClassifier, db: tx } : {}),
          ...(opts.sink ? { sink: opts.sink } : {}),
        });
      });
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
