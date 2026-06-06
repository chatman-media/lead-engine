/**
 * Dialog Simulator API — генерирует «живой» входящий диалог для тестов.
 *
 * POST   /api/admin/sim/start      — запустить симуляцию (LLM играет клиента)
 * GET    /api/admin/sim/personas   — список готовых персон/сценариев
 * DELETE /api/admin/sim/:id         — удалить симулированный диалог (cascade)
 *
 * Идея: оператор сидит в обычном инбоксе (SaasConversations) и наблюдает,
 * как «клиент» пишет — будто сообщения приходят из Telegram. Реально это
 * LLM-«клиент»: он сам генерит реплики пользователя по заданной персоне,
 * каждая реплика прогоняется через НАСТОЯЩИЙ processInbound (persist + stage
 * classify + extract hooks), затем replyStrategy.generate() даёт ответ бота.
 *
 * Отличия от admin-test:
 *   - диалог идёт сам (LLM-клиент), а не по ручным шагам;
 *   - помечается source='self_play' и виден в живом инбоксе;
 *   - в Telegram ничего НЕ отправляется (ответ пишется прямо в messages,
 *     без outbound_queue → воркер не задействован).
 */

import {
  ChannelIdentitiesRepo,
  ContactsRepo,
  ConversationsRepo,
  type Db,
  MessagesRepo,
  OutboundQueueRepo,
  processInbound,
  type ReplyStrategy,
  type StageClassifier,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { Inbound, OutboundPart } from "@chatman-media/channel-core";
import { channels, conversations, messages, tenants } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

// ── Predefined personas ─────────────────────────────────────────────────────

export interface SimPersona {
  id: string;
  name: string;
  /** Краткое имя клиента для отображения в инбоксе. */
  displayName: string;
  /** Системный промпт для LLM-«клиента» — кого он играет. */
  brief: string;
}

const PERSONAS: SimPersona[] = [
  {
    id: "exchange_usdt",
    name: "Обменник — обмен USDT",
    displayName: "Сергей Котов",
    brief:
      "Ты — клиент криптообменника. Хочешь обменять 500 USDT (сеть TRC20) на тайские баты. " +
      "Спрашиваешь курс, уточняешь детали, готов подтвердить и отправить перевод. Веди себя естественно.",
  },
  {
    id: "exchange_rub",
    name: "Обменник — рубли в баты",
    displayName: "Марина Лебедева",
    brief:
      "Ты — клиент обменника. Хочешь перевести 40 000 рублей в тайские баты, оплата со Сбера. " +
      "Немного торгуешься по курсу, но в итоге соглашаешься и подтверждаешь перевод.",
  },
  {
    id: "recruitment",
    name: "Рекрутинг — вакансия в Дубае",
    displayName: "Иван Петров",
    brief:
      "Ты — соискатель. Интересует работа строителем-монолитчиком в Дубае. Опыт 5 лет в России и " +
      "Казахстане, готов к переезду через 2 месяца. Отвечаешь на вопросы рекрутёра, оставляешь контакт.",
  },
  {
    id: "real_estate",
    name: "Недвижимость — квартира Москва",
    displayName: "Ольга Смирнова",
    brief:
      "Ты — покупатель квартиры в Москве, бюджет 12–15 млн, 2–3 комнаты, центр или ЗАО, без ипотеки. " +
      "Уточняешь варианты и готова записаться на просмотр в выходные.",
  },
  {
    id: "saas_demo",
    name: "SaaS — запрос демо",
    displayName: "Дмитрий Volkов",
    brief:
      "Ты — представитель B2B-компании (отдел продаж 20–30 человек), сейчас на AmoCRM, но не устраивает. " +
      "Хочешь попробовать продукт, в итоге просишь демо на следующей неделе.",
  },
];

// ── Sim runner config ───────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 6;
const MAX_TURNS_CAP = 20;
const DONE_TOKEN = "[DONE]";

function personaSystemPrompt(brief: string): string {
  return (
    `${brief}\n\n` +
    "ПРАВИЛА:\n" +
    "- Ты пишешь как реальный человек в мессенджере: коротко, по одной мысли за сообщение.\n" +
    "- Пиши ТОЛЬКО следующую реплику клиента, без кавычек и пояснений.\n" +
    "- Реагируй на ответ собеседника естественно, продвигай диалог к своей цели.\n" +
    `- Когда твой вопрос решён или диалог логически завершён — ответь ровно: ${DONE_TOKEN}`
  );
}

function firstPartText(parts: OutboundPart[]): string {
  const t = parts.find((p) => p.kind === "text");
  return t && "text" in t ? t.text : parts.length > 0 ? "[медиа]" : "";
}

// ── Route factory ────────────────────────────────────────────────────────────

export function makeAdminSimRoutes(opts: {
  db: Db;
  replyStrategy?: ReplyStrategy | null;
  resolveSimChat: (tenantId: number) => ChatClient | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  stageClassifier?: StageClassifier | null;
}): Hono {
  const app = new Hono();

  // ── GET /api/admin/sim/personas ────────────────────────────────────────
  app.get("/api/admin/sim/personas", async (c) => {
    return c.json({ personas: PERSONAS });
  });

  // ── DELETE /api/admin/sim/:id ──────────────────────────────────────────
  app.delete("/api/admin/sim/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const conversationId = Number(c.req.param("id"));
    if (!Number.isFinite(conversationId)) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    // Удаляем только self_play-диалоги (защита от случайного сноса реальных).
    const deleted = await withTenant(opts.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select({ id: conversations.id, source: conversations.source })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
        .limit(1);
      if (!conv || conv.source !== "self_play") return false;
      await tx
        .delete(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)));
      await tx
        .delete(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
      return true;
    });
    if (!deleted) return c.json({ error: "not a self_play conversation" }, 400);
    return c.json({ ok: true });
  });

  // ── POST /api/admin/sim/start ──────────────────────────────────────────
  app.post("/api/admin/sim/start", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? 0;

    let body: { personaId?: string; brief?: string; displayName?: string; maxTurns?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const persona = body.personaId ? PERSONAS.find((p) => p.id === body.personaId) : undefined;
    const brief = (body.brief?.trim() || persona?.brief || "").trim();
    if (!brief) {
      return c.json({ error: "personaId or brief required" }, 400);
    }
    const displayName = (body.displayName?.trim() || persona?.displayName || "Симулятор клиента").trim();
    const maxTurns = Math.min(
      Math.max(1, body.maxTurns ?? DEFAULT_MAX_TURNS),
      MAX_TURNS_CAP,
    );

    const personaClient = opts.resolveSimChat(tenantId);
    if (!personaClient) {
      return c.json({ error: "chat LLM not configured for this tenant" }, 400);
    }
    if (!opts.replyStrategy) {
      return c.json({ error: "reply strategy not configured (add a chat LLM config)" }, 400);
    }

    // 1. Активный канал тенанта (контакт привязываем к реальному channelId,
    //    но conversation помечаем self_play через channel.kind).
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ id: channels.id, kind: channels.kind, externalId: channels.externalId })
        .from(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.status, "active")))
        .limit(3),
    );
    if (rows.length === 0) {
      return c.json({ error: "no active channel — add a Telegram channel first" }, 400);
    }
    const ch =
      rows.find((r) => r.kind === "telegram_bot") ??
      rows.find((r) => r.kind === "telegram_userbot") ??
      rows[0]!;

    const [tenantRow] = await opts.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const tenantSlug = tenantRow?.slug ?? String(tenantId);

    const tenant = { tenantId, slug: tenantSlug, llmBillingMode: "byok" as const };
    // kind='self_play' → conversation.source='self_play' (см. channelKindToSource).
    // ChannelContext.kind не содержит 'self_play' в типе — cast локально для sim.
    const channel = {
      channelId: ch.id,
      kind: "self_play" as unknown as "telegram_bot",
      externalId: ch.externalId,
    };
    const channelIdStr = String(ch.id);
    const template = opts.resolveTemplate?.(tenantSlug);

    // Уникальный sim-пользователь (новый диалог на каждый запуск).
    const simStamp = `${adminId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const externalUserId = `__sim_${simStamp}__`;

    // ── Один обмен репликами: persist user → reply → persist assistant. ──
    const runExchange = async (
      userText: string,
    ): Promise<{ conversationId: number; contactId: number; botReply: string } | null> => {
      const now = Math.floor(Date.now() / 1000);
      const inbound: Inbound = {
        channelId: channelIdStr,
        externalMessageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        externalUserId,
        externalUsername: displayName,
        parts: [{ kind: "text", text: userText }],
        receivedAt: now,
        raw: { _sim: true, adminId },
      };

      const pi = await withTenant(opts.db, tenantId, async (tx) =>
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
          ...(template ? { template } : {}),
          ...(opts.stageClassifier ? { stageClassifier: opts.stageClassifier, db: tx } : {}),
        }),
      );
      if (!pi) return null;

      // replyStrategy.generate напрямую — без outbound_queue.
      let botReply = "";
      try {
        const envelopes = await opts.replyStrategy!.generate({
          tenant,
          channel,
          conversationId: pi.conversationId,
          contactId: pi.contactId,
          inbound,
          userMessageText: userText,
        });
        const parts = envelopes?.flatMap((e) => e.parts) ?? [];
        botReply = firstPartText(parts);
      } catch (err) {
        botReply = `(reply error: ${err instanceof Error ? err.message : String(err)})`;
      }

      if (botReply) {
        await withTenant(opts.db, tenantId, async (tx) => {
          await tx.insert(messages).values({
            tenantId,
            conversationId: pi.conversationId,
            role: "assistant",
            text: botReply,
            metaJson: JSON.stringify({ _sim: true, adminId }),
            createdAt: now + 1,
          });
          await new ConversationsRepo({ db: tx, tenantId }).updateInboxMetadata(
            pi.conversationId,
            { lastMessageText: botReply.slice(0, 200), lastMessageAt: now + 1 },
          );
        });
      }
      return { conversationId: pi.conversationId, contactId: pi.contactId, botReply };
    };

    // ── Цикл диалога: LLM-клиент ведёт переписку. ──
    const exchanges: Array<{ user: string; bot: string }> = [];
    const nextUserMessage = async (): Promise<string | null> => {
      const msgs: ChatMessage[] = [
        { role: "system", content: personaSystemPrompt(brief) },
      ];
      for (const ex of exchanges) {
        msgs.push({ role: "assistant", content: ex.user }); // реплика клиента
        msgs.push({ role: "user", content: ex.bot }); // ответ бота (собеседник)
      }
      const out = await personaClient.complete(msgs, { temperature: 0.8, numPredict: 200 });
      const text = out?.trim() ?? "";
      if (!text || text.includes(DONE_TOKEN)) return null;
      return text;
    };

    // Первый обмен — синхронно, чтобы вернуть conversationId сразу.
    const firstUser = await nextUserMessage();
    if (!firstUser) {
      return c.json({ error: "persona produced no message" }, 500);
    }
    const first = await runExchange(firstUser);
    if (!first) {
      return c.json({ error: "pipeline produced no conversation" }, 500);
    }
    exchanges.push({ user: firstUser, bot: first.botReply });
    const conversationId = first.conversationId;

    // Остальные ходы — в фоне (fire-and-forget), инбокс наполняется по поллингу.
    void (async () => {
      for (let turn = 1; turn < maxTurns; turn++) {
        const userText = await nextUserMessage();
        if (!userText) break;
        const res = await runExchange(userText);
        if (!res) break;
        exchanges.push({ user: userText, bot: res.botReply });
      }
    })().catch(() => {
      /* фоновая симуляция — ошибки не должны валить процесс */
    });

    return c.json({
      ok: true,
      conversationId,
      displayName,
      maxTurns,
      firstMessage: firstUser,
    });
  });

  return app;
}
