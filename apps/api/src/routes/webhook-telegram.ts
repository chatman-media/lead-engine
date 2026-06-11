import type { MediaRef } from "@chatman-media/channel-core";
import type { TelegramBotAdapter, TgUpdate } from "@chatman-media/channel-telegram";
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
import { Hono } from "hono";
import type { ChannelRegistry } from "../channel-registry.ts";
import { adminEventBus } from "../lib/admin-event-bus.ts";
import {
  expandCallbackQuery,
  wrapWithConciergeButtons,
} from "../lib/concierge-reply-markup.ts";
import type { FieldExtractor } from "../lib/field-extractor.ts";
import type { PhotoProcessor } from "../lib/photo-processor.ts";
import { resolvePlan } from "../lib/plans.ts";
import { runPostInboundAutomation } from "../lib/post-inbound-automation.ts";
import type { InboundRateLimiter } from "../lib/rate-limiter.ts";
import type { ServiceCatalogRuntime } from "../lib/service-catalog-runtime.ts";

/**
 * Telegram webhook handler. Telegram постит JSON на /webhook/telegram/:slug
 * с header X-Telegram-Bot-Api-Secret-Token = webhookSecret.
 *
 * Поток:
 *   1. Валидируем секрет (rejection: 401).
 *   2. Резолвим tenant + active telegram_bot channel по slug.
 *   3. Парсим payload как TgUpdate.
 *   4. Дёргаем adapter.pushUpdate(update) — это конвертит в Inbound и
 *      кладёт в внутреннюю очередь адаптера.
 *   5. Если есть voice-part — download + STT до DB transaction.
 *   6. Дёргаем processInbound() — persist + cheap DB hooks.
 *   7. Делаем stage/memory post-processing: LLM outside tx, writes in short tx.
 *   8. Генерируем reply вне DB transaction и enqueue'им outbound.
 *   9. 200 ack Telegram'у после обработки текущего inbound.
 *
 * Outbound HTTP delivery делается в apps/worker; reply LLM/STT выполняются
 * в apps/api, но без открытой Postgres transaction.
 */
export function makeTelegramWebhookRoutes(opts: {
  db: Db;
  channels: ChannelRegistry;
  webhookSecret: string;
  /**
   * Стратегия ответа. null = pipeline persist'ит inbound и не отвечает
   * (бот silent — оператор отвечает руками через admin-ui).
   */
  replyStrategy?: ReplyStrategy | null;
  /**
   * Резолвер vertical-template по tenant_slug. Если задан и для tenant'а
   * есть template — pipeline дёрнет hooks.extractFields на новые user-
   * messages (автозаполнение questionnaire-полей в contact.attributes_json)
   * и валидирует transitions через funnel state machine.
   *
   * После Этапа 8 будет lookup через funnels.vertical_template_id из БД.
   * Сейчас — env-mapped (apps/api index.ts передаёт RECRUITMENT_V1 для
   * legacy tenant'а).
   */
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  /**
   * Опциональный LLM-based memory extractor (apps/api инжектит когда
   * сконфигурирован chat-LLM). Вызывается после persist user-message
   * и merge'ит facts в contact.attributes_json. Exception в extractor'е
   * логируется и не ломает reply-loop.
   */
  memoryExtractor?: MemoryExtractor | null;
  /**
   * Опциональный stage classifier (regex или LLM). Если задан, после
   * persist user-message pipeline классифицирует sales-stage и пишет
   * в conversations.current_stage. Exception в classifier'е логируется,
   * pipeline продолжает.
   */
  stageClassifier?: StageClassifier | null;
  /**
   * Опциональные observability hooks — PipelineSink + PlatformMetrics.
   * apps/api инжектит их через makeMetricsSink, тогда webhook handler
   * считает webhookRequests / webhookLatency, а pipeline эмитит inbound/
   * outbound counters через sink.emit.
   */
  sink?: PipelineSink;
  metrics?: PlatformMetrics;
  /**
   * Опциональный per-tenant rate limiter (см. apps/api/src/lib/rate-limiter.ts).
   * Если задан и tenant превысил лимит — webhook handler возвращает 429 с
   * Retry-After header (Telegram уважает 429 и replay'нёт позже).
   */
  rateLimiter?: InboundRateLimiter;
  notificationService?: NotificationService;
  photoProcessor?: PhotoProcessor;
  fieldExtractor?: FieldExtractor;
  serviceCatalogRuntime?: ServiceCatalogRuntime;
  /** Per-tenant STT factory. Вызывается с tenantId на каждый webhook-запрос. */
  resolveTranscriber?: ((tenantId: number) => ITranscriber | null) | null;
}): Hono {
  const app = new Hono();

  app.post("/webhook/telegram/:slug", async (c) => {
    const startedAt = performance.now();
    const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (got !== opts.webhookSecret) {
      opts.metrics?.webhookRequests.inc(1, { channel: "telegram_bot", status: "401" });
      return c.json({ error: "invalid secret" }, 401);
    }

    const slug = c.req.param("slug");
    const entries = opts.channels.getTelegramBotsByTenant(slug);
    if (entries.length === 0) {
      opts.metrics?.webhookRequests.inc(1, { channel: "telegram_bot", status: "404" });
      return c.json({ error: "no active telegram_bot channel for tenant" }, 404);
    }
    // На текущем этапе один tenant держит один telegram_bot. Когда появится
    // несколько (multi-bot per tenant) — нужен дополнительный
    // dispatch-критерий, например `bot_id` в URL.
    const entry = entries[0]!;

    // Rate-limit check: protect от spam-волн which drain LLM credits.
    // Per-plan limits override the global cfg default.
    if (opts.rateLimiter) {
      const planLimits = resolvePlan(entry.tenantPlan);
      const decision = opts.rateLimiter.check(entry.tenantId, {
        perMinute: planLimits.rateLimitPerMinute,
        perHour: planLimits.rateLimitPerHour,
      });
      if (!decision.allowed) {
        opts.metrics?.webhookRequests.inc(1, { channel: "telegram_bot", status: "429" });
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

    let update: TgUpdate;
    try {
      update = (await c.req.json()) as TgUpdate;
    } catch {
      opts.metrics?.webhookRequests.inc(1, { channel: "telegram_bot", status: "400" });
      return c.json({ error: "invalid json" }, 400);
    }

    // getTelegramBotsByTenant возвращает строго telegram_bot — но TS не
    // narrow'нет union TelegramBotAdapter|WhatsAppCloudAdapter без явного cast'а.
    const adapter = entry.adapter as TelegramBotAdapter;

    // 1. Pushим в адаптер чтобы apps/worker.receive() loop увидел
    //    это (для будущего merge-flow). На данный момент worker не
    //    читает receive() из api-process'а — у него свой ChannelRegistry.
    adapter.pushUpdate(update);

    // 2. Сразу синхронно дёргаем processInbound — это безопасно потому
    //    что pipeline сам не делает HTTP-вызовов наружу. Долгие действия
    //    (отправка ответа) ставятся в outbound_queue и берутся worker'ом.
    //
    //    parseUpdate тут не reused — мы реюзаем pushUpdate, а потом
    //    читаем единственный pending Inbound через одноразовый iterator.
    //
    //    Future: переключиться на receive()-streaming если pipeline'у
    //    потребуется state между сообщениями.
    const iter = adapter.receive()[Symbol.asyncIterator]();
    const next = await iter.next();
    if (next.done) {
      return c.json({ ok: true, processed: false });
    }
    let inbound = next.value;

    // Concierge click-витрина: callback_query с data "srv:<type>" конвертируем
    // в синтетическое text-сообщение. Это позволяет field-extractor'у
    // классифицировать request_type без изменений в conversation-engine.
    const expanded = expandCallbackQuery(inbound);
    if (expanded) {
      // Ответить на callback_query — убрать спиннер на кнопке у гостя.
      void adapter.rawClient
        .answerCallbackQuery({ callbackQueryId: expanded.callbackQueryId })
        .catch(() => {});
      inbound = expanded.syntheticInbound;
    }

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

    // ── Phase 0: optional voice download + STT (NO tx) ───────────────────
    // `processInbound` ниже остаётся DB-only: media API + transcribe не держат
    // Postgres connection и не расширяют RLS transaction.
    await transcribeInboundVoice(inbound, {
      tenantId: entry.tenantId,
      resolveTranscriber: opts.resolveTranscriber
        ? () => opts.resolveTranscriber?.(entry.tenantId) ?? null
        : null,
      downloadVoice: (mediaRef: MediaRef) => adapter.rawClient.downloadFile(mediaRef.externalRef),
      ...(opts.sink ? { sink: opts.sink } : {}),
    });

    // ── Phase 1: persist + cheap DB hooks (одна короткая tx) ─────────────
    // Все DB-операции (Contact / ChannelIdentity / Conversation / Message /
    // extractFields) живут в atomic tx с SET LOCAL app.tenant_id.
    // Stage classifier, memory extractor и reply.generate НЕ вызываются здесь.
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
        // reply остаётся для conv-engine'а как gate — но НЕ вызывается
        // при deferReply, processInbound вернётся раньше.
        reply: opts.replyStrategy
          ? wrapWithConciergeButtons(opts.replyStrategy, opts.db)
          : null,
        deferReply: true,
        deferPostProcessing: Boolean(opts.memoryExtractor || opts.stageClassifier),
        ...(template ? { template } : {}),
        ...(opts.sink ? { sink: opts.sink } : {}),
      });
    });

    // ── Phase 2: stage/memory post-processing ───────────────────────────
    // Classifier/extractor LLM calls run outside tx; DB writes use short txs.
    if (result.postProcessingDeferred) {
      await runDeferredInboundPostProcessing({
        db: opts.db,
        tenant,
        result,
        stageClassifier: opts.stageClassifier,
        memoryExtractor: opts.memoryExtractor,
        advanceLead: true,
        ...(opts.sink ? { sink: opts.sink } : {}),
      });
    }

    // ── Phase 3: reply.generate (LLM ВНЕ tx) + enqueue в новой короткой tx ──
    // Освобождает Postgres pool connection на время LLM call'а (~1-2s).
    // Pool=10, под нагрузкой это устраняет typical bottleneck.
    if (result.replyDeferred && opts.replyStrategy) {
      const replyStrategyWithButtons = wrapWithConciergeButtons(opts.replyStrategy, opts.db);
      const gen = await generateReplyAndEnqueue({
        db: opts.db,
        tenant,
        channel,
        channelDbId: entry.channelDbId,
        inbound,
        result,
        replyStrategy: replyStrategyWithButtons,
        notifications: opts.notificationService,
        ...(opts.sink ? { sink: opts.sink } : {}),
      });
      result = { ...result, outboundEnqueued: gen.outboundEnqueued };
    }

    // Photo classification + passport OCR (outside tx — LLM + download).
    // Skipped for deduped inbounds and when no vision config is set for tenant.
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
      void runPostInboundAutomation({
        db: opts.db,
        tenantId: entry.tenantId,
        contactId: result.contactId,
        conversationId: result.conversationId,
        inbound,
        fieldExtractor: opts.fieldExtractor,
        serviceCatalogRuntime: opts.serviceCatalogRuntime,
      });
    }

    if (result.persisted) {
      const preview = inbound.parts.find((p) => p.kind === "text") as { kind: "text"; text: string } | undefined;
      adminEventBus.emit({
        type: "new_message",
        tenantId: entry.tenantId,
        conversationId: result.conversationId,
        contactId: result.contactId,
        preview: preview?.text.slice(0, 180) ?? null,
        role: "user",
      });
    }

    // Inbound deduped path: persisted=false означает что messages.id
    // existed (uniq_msg_user_tg hit) — это retry от Telegram'а.
    if (!result.persisted) {
      opts.metrics?.inboundDeduped.inc(1, { tenant: String(entry.tenantId) });
    }
    const elapsedSec = (performance.now() - startedAt) / 1000;
    opts.metrics?.webhookLatency.observe(elapsedSec, { channel: "telegram_bot" });
    opts.metrics?.pipelineLatency.observe(elapsedSec, { tenant: String(entry.tenantId) });
    opts.metrics?.webhookRequests.inc(1, { channel: "telegram_bot", status: "200" });

    return c.json({ ok: true, processed: true, result });
  });

  return app;
}
