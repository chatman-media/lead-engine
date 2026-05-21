import type { TgUpdate } from "@chatman-media/channel-telegram";
import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  MessagesRepo,
  OutboundQueueRepo,
  processInbound,
  type ReplyStrategy,
} from "@chatman-media/conversation-engine";
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
}): Hono {
  const app = new Hono();

  app.post("/webhook/telegram/:slug", async (c) => {
    const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (got !== opts.webhookSecret) {
      return c.json({ error: "invalid secret" }, 401);
    }

    const slug = c.req.param("slug");
    const entries = opts.channels.getTelegramBotsByTenant(slug);
    if (entries.length === 0) {
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
      return c.json({ error: "invalid json" }, 400);
    }

    // 1. Pushим в адаптер чтобы apps/worker.receive() loop увидел
    //    это (для будущего merge-flow). На данный момент worker не
    //    читает receive() из api-process'а — у него свой ChannelRegistry.
    entry.adapter.pushUpdate(update);

    // 2. Сразу синхронно дёргаем processInbound — это безопасно потому
    //    что pipeline сам не делает HTTP-вызовов наружу. Долгие действия
    //    (отправка ответа) ставятся в outbound_queue и берутся worker'ом.
    //
    //    parseUpdate тут не reused — мы реюзаем pushUpdate, а потом
    //    читаем единственный pending Inbound через одноразовый iterator.
    //
    //    Future: переключиться на receive()-streaming если pipeline'у
    //    потребуется state между сообщениями.
    const iter = entry.adapter.receive()[Symbol.asyncIterator]();
    const next = await iter.next();
    if (next.done) {
      return c.json({ ok: true, processed: false });
    }
    const inbound = next.value;

    const repoCtx = { db: opts.db, tenantId: entry.tenantId };
    const template = opts.resolveTemplate?.(entry.tenantSlug);
    const result = await processInbound(inbound, {
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
    });

    return c.json({ ok: true, processed: true, result });
  });

  return app;
}
