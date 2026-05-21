import type { TelegramBotAdapter, TgUpdate } from "@chatman-media/channel-telegram";
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
import type { PlatformMetrics } from "@chatman-media/observability";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { Hono } from "hono";
import type { ChannelRegistry } from "../channel-registry.ts";

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
 *   5. Дёргаем processInbound() — persist + reply-strategy (если зарегистрирована).
 *   6. 200 ack Telegram'у быстро (<100ms typical).
 *
 * Heavy work (LLM, outbound HTTP) делается в apps/worker — handler не
 * блокирует Telegram retry'ями.
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
   * Сейчас — env-mapped (apps/api index.ts передаёт RECRUITMENT_UAE_V1 для
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
    const inbound = next.value;

    const template = opts.resolveTemplate?.(entry.tenantSlug);
    // Весь pipeline-call оборачивается в withTenant — pipeline делает
    // несколько repo-INSERT'ов (Contact + ChannelIdentity + Conversation +
    // Message + OutboundQueue), и они должны (а) видеть друг друга
    // одновременно через атомарную tx, (б) проходить RLS policy на
    // production non-bypass role'и (см. миграцию 0004 + checkRlsEnforcement).
    //
    // Тradeoff: LLM-call внутри pipeline'а (reply-strategy) тоже происходит
    // под открытой Postgres tx — это держит pool connection во время slow
    // external request'а. Mitigation на будущее: split pipeline на
    // persist-only + reply-generate phases в отдельных tx; не делаем
    // сейчас чтобы не растягивать scope. На текущих latencies (~1-2s LLM)
    // и pool=10 это OK для pilot-load'а.
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
