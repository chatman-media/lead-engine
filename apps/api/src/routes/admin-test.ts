/**
 * Bot Tester API — позволяет тестировать бота прямо из admin-UI.
 *
 * POST /api/admin/test/send       — отправить сообщение (текст или медиа)
 * DELETE /api/admin/test/session  — сбросить тест-сессию (удалить тест-контакт)
 * GET  /api/admin/test/scenarios  — получить список готовых сценариев
 *
 * Принцип работы:
 *   1. Создаёт «виртуального» пользователя с externalUserId = __test_<adminId>__
 *      в канале тенанта (используется первый активный канал).
 *   2. Прогоняет сообщение через полный processInbound pipeline (classifies stage,
 *      extracts fields, сохраняет в messages).
 *   3. Вызывает replyStrategy.generate() напрямую — без записи в outbound_queue.
 *      Реальному Telegram боту ничего НЕ отправляется.
 *   4. Ответ бота записывается в messages (role='assistant') для корректного
 *      multi-turn контекста.
 *   5. Возвращает parts[] с текстом/медиа ответа в admin-UI.
 */

import { resolve } from "node:path";
import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  MessagesRepo,
  normalizeReplyStrategyResult,
  OutboundQueueRepo,
  processInbound,
  type ReplyStrategy,
  withTenant,
} from "@chatman-media/conversation-engine";
import type {
  ChannelAdapter,
  Inbound,
  InboundPart,
  OutboundPart,
} from "@chatman-media/channel-core";
import type { PhotoProcessor } from "../lib/photo-processor.ts";
import { channelIdentities, channels, contacts, messages, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

// ── Predefined test scenarios ──────────────────────────────────────────────

export interface TestScenarioStep {
  text?: string;
  /** `asset:<file>` — встроенный тестовый файл из apps/api/assets/bot-test, либо http(s)-URL. */
  mediaUrl?: string;
  mediaType?: "photo" | "video";
  caption?: string;
  hint?: string;
}

export interface TestScenario {
  id: string;
  name: string;
  vertical: string;
  steps: TestScenarioStep[];
}

const SCENARIOS: TestScenario[] = [
  {
    id: "exchange_usdt_trc20",
    name: "Обменник — 500 USDT TRC20 → THB",
    vertical: "exchange_v1",
    steps: [
      { text: "Привет, хочу обменять 500 USDT на THB", hint: "Запрос обмена" },
      { text: "TRC20", hint: "Выбор сети" },
      { text: "Да, подтверждаю курс", hint: "Подтверждение курса" },
      { text: "Иван Иванов", hint: "KYC — имя (если запросит)" },
      { text: "Перевод сделан, вот tx hash: abc123def456", hint: "Подтверждение оплаты" },
    ],
  },
  {
    id: "exchange_rub",
    name: "Обменник — 40 000 ₽ → THB",
    vertical: "exchange_v1",
    steps: [
      { text: "Хочу перевести рубли на THB, 40000", hint: "Запрос обмена" },
      { text: "Перевод на Сбер", hint: "Способ оплаты" },
      { text: "Подтверждаю", hint: "Подтверждение курса" },
      {
        mediaUrl: "asset:receipt-sber.png",
        mediaType: "photo",
        caption: "Оплатил, вот чек",
        hint: "Фото чека (Сбер, 40 000 ₽)",
      },
    ],
  },
  {
    id: "exchange_kyc_passport",
    name: "Обменник — крупная сумма, KYC с фото паспорта",
    vertical: "exchange_v1",
    steps: [
      { text: "Хочу поменять 150000 рублей на баты", hint: "Крупная сумма → KYC" },
      { text: "Перевод на Сбер", hint: "Способ оплаты" },
      { text: "Подтверждаю курс", hint: "Подтверждение" },
      {
        mediaUrl: "asset:passport-demo.png",
        mediaType: "photo",
        caption: "Вот фото паспорта",
        hint: "Фото паспорта (демо-образец)",
      },
    ],
  },
  {
    id: "recruitment_basic",
    name: "Рекрутинг — базовый флоу",
    vertical: "recruitment_generic",
    steps: [
      { text: "Здравствуйте, интересует работа в Дубае", hint: "Первое сообщение" },
      { text: "Строитель, монолитчик", hint: "Специальность" },
      { text: "5 лет опыта в России и Казахстане", hint: "Опыт" },
      { text: "Да, готов к переезду через 2 месяца", hint: "Готовность" },
      { text: "Иван Петров, +7 900 123 45 67", hint: "Контакт" },
    ],
  },
  {
    id: "real_estate_moscow",
    name: "Недвижимость — квартира Москва",
    vertical: "real_estate",
    steps: [
      { text: "Ищу квартиру в Москве", hint: "Первый запрос" },
      { text: "Бюджет 12-15 миллионов", hint: "Бюджет" },
      { text: "2-3 комнаты, центр или ЗАО", hint: "Параметры" },
      { text: "Нет, без ипотеки", hint: "Ипотека" },
      { text: "Суббота, после 13:00", hint: "Удобное время просмотра" },
    ],
  },
  {
    id: "saas_demo",
    name: "SaaS — запрос демо",
    vertical: "saas",
    steps: [
      { text: "Привет, хотим попробовать ваш продукт для команды", hint: "Первый контакт" },
      { text: "20-30 человек, B2B продажи", hint: "Размер команды" },
      { text: "Сейчас используем AmoCRM, но не устраивает", hint: "Текущее решение" },
      { text: "Да, хочу демо на следующей неделе", hint: "Запрос демо" },
    ],
  },
];

// ── Route factory ──────────────────────────────────────────────────────────

export function makeAdminTestRoutes(opts: {
  db: Db;
  replyStrategy?: ReplyStrategy | null;
  /** Vision-обработка фото (классификация + паспортный OCR), как в боевых каналах. */
  photoProcessor?: PhotoProcessor | null;
}): Hono {
  const app = new Hono();

  // ── GET /api/admin/test/scenarios ──────────────────────────────────────
  app.get("/api/admin/test/scenarios", async (c) => {
    return c.json({ scenarios: SCENARIOS });
  });

  // ── DELETE /api/admin/test/session ─────────────────────────────────────
  // Удаляет тест-контакт → каскадно удаляет его conversations + messages.
  // Следующий POST /send создаст свежую сессию.
  app.delete("/api/admin/test/session", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? 0;
    const testUserId = `__test_admin_${adminId}__`;

    // Находим канал тенанта
    const [ch] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.status, "active")))
        .limit(1),
    );
    if (!ch) return c.json({ ok: true, note: "no active channel" });

    // Найти contactId через channel_identities, затем удалить контакт (cascade убирает всё)
    await withTenant(opts.db, tenantId, async (tx) => {
      const [identity] = await tx
        .select({ contactId: channelIdentities.contactId })
        .from(channelIdentities)
        .where(
          and(
            eq(channelIdentities.channelId, ch.id),
            eq(channelIdentities.externalUserId, testUserId),
          ),
        )
        .limit(1);
      if (identity) {
        await tx.delete(contacts).where(eq(contacts.id, identity.contactId));
      }
    });

    return c.json({ ok: true });
  });

  // ── POST /api/admin/test/send ──────────────────────────────────────────
  app.post("/api/admin/test/send", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? 0;

    let body: {
      text?: string;
      mediaUrl?: string;
      mediaType?: "photo" | "video";
      caption?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const text = body.text?.trim() ?? "";
    const mediaUrl = body.mediaUrl?.trim() ?? "";
    if (!text && !mediaUrl) {
      return c.json({ error: "text or mediaUrl required" }, 400);
    }

    // 1. Найти активный канал тенанта
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: channels.id,
          kind: channels.kind,
          externalId: channels.externalId,
        })
        .from(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.status, "active")))
        .limit(3),
    );

    if (rows.length === 0) {
      return c.json({ error: "no active channel — add a Telegram channel first" }, 400);
    }

    // Предпочитаем telegram_bot, иначе берём любой
    const ch =
      rows.find((r) => r.kind === "telegram_bot") ??
      rows.find((r) => r.kind === "telegram_userbot") ??
      rows[0]!;

    // 2. Получить slug тенанта
    const [tenantRow] = await opts.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const tenantSlug = tenantRow?.slug ?? String(tenantId);

    // 3. Сформировать Inbound
    const testUserId = `__test_admin_${adminId}__`;
    const channelIdStr = String(ch.id);
    const now = Math.floor(Date.now() / 1000);

    const parts: InboundPart[] = mediaUrl
      ? [
          {
            kind: (body.mediaType ?? "photo") as "photo" | "video",
            mediaRef: { channelId: channelIdStr, externalRef: mediaUrl },
            ...(body.caption ? { caption: body.caption } : {}),
          },
        ]
      : [{ kind: "text", text }];

    const inbound: Inbound = {
      channelId: channelIdStr,
      externalMessageId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      externalUserId: testUserId,
      externalUsername: "BotTester",
      parts,
      receivedAt: now,
      raw: { _botTest: true, adminId },
    };

    const tenant = { tenantId, slug: tenantSlug, llmBillingMode: "byok" as const };
    const channel = {
      channelId: ch.id,
      kind: ch.kind as "telegram_bot",
      externalId: ch.externalId,
    };

    // 4. processInbound (reply: null — только persist + stage classify)
    let piResult: { contactId: number; conversationId: number } | null = null;
    try {
      piResult = await withTenant(opts.db, tenantId, async (tx) =>
        processInbound(inbound, {
          tenant,
          channel,
          channelDbId: ch.id,
          contacts: new ContactsRepo({ db: tx, tenantId }),
          identities: new ChannelIdentitiesRepo({ db: tx, tenantId }),
          conversations: new ConversationsRepo({ db: tx, tenantId }),
          messages: new MessagesRepo({ db: tx, tenantId }),
          outbound: new OutboundQueueRepo({ db: tx, tenantId }),
          reply: null,
        }),
      );
    } catch (err) {
      return c.json(
        { error: `pipeline error: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    if (!piResult) {
      return c.json({ parts: [] });
    }

    // 4b. Vision-обработка фото, как в боевых каналах. `asset:<file>` резолвится
    // в локальный тестовый файл из apps/api/assets/bot-test, http(s) — скачивается.
    if (opts.photoProcessor && mediaUrl && (body.mediaType ?? "photo") === "photo") {
      const adapter = {
        downloadMedia: async (ref: { externalRef: string }) => {
          if (ref.externalRef.startsWith("asset:")) {
            const name = ref.externalRef.slice("asset:".length);
            if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) {
              throw new Error("bad asset name");
            }
            const path = resolve(import.meta.dir, "..", "..", "assets", "bot-test", name);
            return new Response(await Bun.file(path).arrayBuffer());
          }
          return fetch(ref.externalRef);
        },
      } as unknown as ChannelAdapter;
      await opts.photoProcessor.process({
        tenantId,
        inbound,
        adapter,
        contactId: piResult.contactId,
        db: opts.db,
      });
    }

    // 5. Нет replyStrategy — вернуть пустой ответ
    if (!opts.replyStrategy) {
      return c.json({
        parts: [{ kind: "text", text: "(replyStrategy not configured — add a chat LLM config)" }],
        conversationId: piResult.conversationId,
      });
    }

    // 6. Вызвать replyStrategy.generate() напрямую — БЕЗ записи в outbound_queue
    let responseParts: OutboundPart[] = [];
    try {
      const result = await opts.replyStrategy.generate({
        tenant,
        channel,
        conversationId: piResult.conversationId,
        contactId: piResult.contactId,
        inbound,
        userMessageText:
          text ||
          (mediaUrl
            ? `[${body.mediaType ?? "photo"}]${body.caption ? ` ${body.caption}` : ""}`
            : ""),
      });
      responseParts = normalizeReplyStrategyResult(result)?.envelopes.flatMap((e) => e.parts) ?? [];
    } catch (err) {
      return c.json(
        {
          error: `reply strategy error: ${err instanceof Error ? err.message : String(err)}`,
          conversationId: piResult.conversationId,
        },
        500,
      );
    }

    // 7. Записать ответ бота в messages (для multi-turn контекста)
    if (responseParts.length > 0) {
      const textPart = responseParts.find((p) => p.kind === "text");
      const responseText = textPart && "text" in textPart ? textPart.text : "[media]";
      try {
        await withTenant(opts.db, tenantId, async (tx) =>
          tx.insert(messages).values({
            tenantId,
            conversationId: piResult!.conversationId,
            role: "assistant",
            text: responseText,
            metaJson: JSON.stringify({ _botTest: true, adminId }),
            createdAt: now + 1,
          }),
        );
      } catch {
        // Не критично — просто не записали в историю
      }
    }

    return c.json({
      parts: responseParts,
      conversationId: piResult.conversationId,
    });
  });

  return app;
}
