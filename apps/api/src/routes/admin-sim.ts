/**
 * Dialog Simulator API — генерирует «живой» входящий диалог(и) для тестов.
 *
 * POST   /api/admin/sim/start        — один симулированный клиент (LLM играет клиента)
 * POST   /api/admin/sim/stream       — поток: N клиентов по интервалу («боевой режим»)
 * DELETE /api/admin/sim/stream/:id   — остановить поток (отменить ещё не запущенных)
 * GET    /api/admin/sim/streams      — активные потоки
 * GET    /api/admin/sim/personas     — список готовых персон/сценариев
 * DELETE /api/admin/sim/:id          — удалить симулированный диалог
 *
 * Идея: оператор сидит в обычном инбоксе (SaasConversations) и наблюдает,
 * как «клиенты» пишут — будто сообщения приходят из Telegram. Реально это
 * LLM-«клиенты»: каждый сам генерит реплики по персоне, реплика прогоняется
 * через НАСТОЯЩИЙ processInbound (persist + stage classify + extract hooks),
 * затем replyStrategy.generate() даёт ответ бота.
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
      "Сразу называешь сумму и сеть и ТРЕБУЕШЬ конкретный курс и сколько бат получишь на руки — " +
      "не соглашаешься на «уточню у оператора», переспрашиваешь точную цифру. Получив курс, " +
      "уточняешь детали и готов подтвердить и отправить перевод. Веди себя естественно.",
  },
  {
    id: "exchange_rub",
    name: "Обменник — рубли в баты",
    displayName: "Марина Лебедева",
    brief:
      "Ты — клиент обменника. Хочешь перевести 40 000 рублей в тайские баты, оплата со Сбера. " +
      "Сразу просишь назвать курс и сколько бат получишь за 40 000 ₽, требуешь конкретную цифру, " +
      "немного торгуешься по курсу, но в итоге соглашаешься и подтверждаешь перевод.",
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
    displayName: "Дмитрий Волков",
    brief:
      "Ты — представитель B2B-компании (отдел продаж 20–30 человек), сейчас на AmoCRM, но не устраивает. " +
      "Хочешь попробовать продукт, в итоге просишь демо на следующей неделе.",
  },
];

// Пул имён для потоковых клиентов — чтобы в инбоксе они выглядели как разные люди.
const FIRST_NAMES = [
  "Александр", "Дмитрий", "Максим", "Андрей", "Сергей", "Иван", "Никита", "Егор",
  "Анна", "Мария", "Елена", "Ольга", "Наталья", "Юлия", "Дарья", "Виктория",
];
const LAST_NAMES = [
  "Иванов", "Смирнов", "Кузнецов", "Попов", "Соколов", "Лебедев", "Новиков", "Морозов",
  "Волков", "Козлов", "Петров", "Орлов", "Макаров", "Зайцев", "Павлов", "Семёнов",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomName(): string {
  const last = pick(LAST_NAMES);
  const first = pick(FIRST_NAMES);
  // Женское имя → женская фамилия (грубо, но достаточно для теста).
  const female = "аяьи".includes(first.slice(-1));
  return `${female ? `${last}а` : last} ${first}`.trim();
}

// ── Sim runner config ───────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 6;
const MAX_TURNS_CAP = 20;
const DONE_TOKEN = "[DONE]";

const DEFAULT_STREAM_INTERVAL_SEC = 60;
const MIN_STREAM_INTERVAL_SEC = 5;
const MAX_STREAM_CLIENTS = 50;

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

// Реестр активных потоков (in-memory; живёт в процессе apps/api).
interface StreamState {
  id: string;
  tenantId: number;
  total: number;
  spawned: number;
  intervalSec: number;
  cancelled: boolean;
  timers: ReturnType<typeof setTimeout>[];
}
const STREAMS = new Map<string, StreamState>();

// ── Route factory ────────────────────────────────────────────────────────────

export function makeAdminSimRoutes(opts: {
  db: Db;
  replyStrategy?: ReplyStrategy | null;
  resolveSimChat: (tenantId: number) => ChatClient | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  stageClassifier?: StageClassifier | null;
}): Hono {
  const app = new Hono();

  // Контекст для одного «прогона»: канал + persona-клиент + reply-стратегия.
  interface SimCtx {
    tenantId: number;
    adminId: number;
    channelDbId: number;
    externalId: string;
    tenantSlug: string;
    personaClient: ChatClient;
    replyStrategy: ReplyStrategy;
    template?: VerticalTemplate;
  }

  // Резолвит активный канал + slug + persona-клиент. Возвращает строку-ошибку
  // (для 400) либо готовый контекст.
  async function buildCtx(tenantId: number, adminId: number): Promise<SimCtx | string> {
    const personaClient = opts.resolveSimChat(tenantId);
    if (!personaClient) return "chat LLM not configured for this tenant";
    if (!opts.replyStrategy) return "reply strategy not configured (add a chat LLM config)";

    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ id: channels.id, kind: channels.kind, externalId: channels.externalId })
        .from(channels)
        .where(and(eq(channels.tenantId, tenantId), eq(channels.status, "active")))
        .limit(3),
    );
    if (rows.length === 0) return "no active channel — add a Telegram channel first";
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

    return {
      tenantId,
      adminId,
      channelDbId: ch.id,
      externalId: ch.externalId,
      tenantSlug,
      personaClient,
      replyStrategy: opts.replyStrategy,
      ...(opts.resolveTemplate?.(tenantSlug) ? { template: opts.resolveTemplate(tenantSlug) } : {}),
    };
  }

  // Прогон одного клиента: создаёт уникального sim-юзера, делает первый обмен
  // (await — чтобы вернуть conversationId), остальные ходы — в фоне.
  async function simulateClient(
    ctx: SimCtx,
    params: { brief: string; displayName: string; maxTurns: number },
  ): Promise<number> {
    const { tenantId, adminId } = ctx;
    const tenant = { tenantId, slug: ctx.tenantSlug, llmBillingMode: "byok" as const };
    // kind='self_play' → conversation.source='self_play' (см. channelKindToSource).
    // ChannelContext.kind не содержит 'self_play' в типе — cast локально для sim.
    const channel = {
      channelId: ctx.channelDbId,
      kind: "self_play" as unknown as "telegram_bot",
      externalId: ctx.externalId,
    };
    const channelIdStr = String(ctx.channelDbId);
    const simStamp = `${adminId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const externalUserId = `__sim_${simStamp}__`;

    const runExchange = async (
      userText: string,
    ): Promise<{ conversationId: number; contactId: number; botReply: string } | null> => {
      const now = Math.floor(Date.now() / 1000);
      const inbound: Inbound = {
        channelId: channelIdStr,
        externalMessageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        externalUserId,
        externalUsername: params.displayName,
        parts: [{ kind: "text", text: userText }],
        receivedAt: now,
        raw: { _sim: true, adminId },
      };

      const pi = await withTenant(opts.db, tenantId, async (tx) =>
        processInbound(inbound, {
          tenant,
          channel,
          channelDbId: ctx.channelDbId,
          contacts: new ContactsRepo({ db: tx, tenantId }),
          identities: new ChannelIdentitiesRepo({ db: tx, tenantId }),
          conversations: new ConversationsRepo({ db: tx, tenantId }),
          messages: new MessagesRepo({ db: tx, tenantId }),
          outbound: new OutboundQueueRepo({ db: tx, tenantId }),
          reply: null,
          ...(ctx.template ? { template: ctx.template } : {}),
          ...(opts.stageClassifier ? { stageClassifier: opts.stageClassifier, db: tx } : {}),
        }),
      );
      if (!pi) return null;

      let botReply = "";
      try {
        const envelopes = await ctx.replyStrategy.generate({
          tenant,
          channel,
          conversationId: pi.conversationId,
          contactId: pi.contactId,
          inbound,
          userMessageText: userText,
        });
        botReply = firstPartText(envelopes?.flatMap((e) => e.parts) ?? []);
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
          await new ConversationsRepo({ db: tx, tenantId }).updateInboxMetadata(pi.conversationId, {
            lastMessageText: botReply.slice(0, 200),
            lastMessageAt: now + 1,
          });
        });
      }
      return { conversationId: pi.conversationId, contactId: pi.contactId, botReply };
    };

    const exchanges: Array<{ user: string; bot: string }> = [];
    const nextUserMessage = async (): Promise<string | null> => {
      const msgs: ChatMessage[] = [{ role: "system", content: personaSystemPrompt(params.brief) }];
      for (const ex of exchanges) {
        msgs.push({ role: "assistant", content: ex.user }); // реплика клиента
        msgs.push({ role: "user", content: ex.bot }); // ответ бота (собеседник)
      }
      const out = await ctx.personaClient.complete(msgs, { temperature: 0.8, numPredict: 200 });
      const text = out?.trim() ?? "";
      if (!text || text.includes(DONE_TOKEN)) return null;
      return text;
    };

    const firstUser = await nextUserMessage();
    if (!firstUser) throw new Error("persona produced no message");
    const first = await runExchange(firstUser);
    if (!first) throw new Error("pipeline produced no conversation");
    exchanges.push({ user: firstUser, bot: first.botReply });

    // Остальные ходы — в фоне (инбокс наполняется по поллингу).
    void (async () => {
      for (let turn = 1; turn < params.maxTurns; turn++) {
        const userText = await nextUserMessage();
        if (!userText) break;
        const res = await runExchange(userText);
        if (!res) break;
        exchanges.push({ user: userText, bot: res.botReply });
      }
    })().catch(() => {
      /* фоновая симуляция — ошибки не должны валить процесс */
    });

    return first.conversationId;
  }

  // ── GET /api/admin/sim/personas ────────────────────────────────────────
  app.get("/api/admin/sim/personas", async (c) => {
    return c.json({ personas: PERSONAS });
  });

  // ── GET /api/admin/sim/streams ─────────────────────────────────────────
  app.get("/api/admin/sim/streams", async (c) => {
    const tenantId = c.var.tenantId;
    const items = [...STREAMS.values()]
      .filter((s) => s.tenantId === tenantId && !s.cancelled && s.spawned < s.total)
      .map((s) => ({
        id: s.id,
        total: s.total,
        spawned: s.spawned,
        intervalSec: s.intervalSec,
      }));
    return c.json({ streams: items });
  });

  // ── DELETE /api/admin/sim/streams ──────────────────────────────────────
  // Остановить ВСЕ активные потоки тенанта разом.
  app.delete("/api/admin/sim/streams", async (c) => {
    const tenantId = c.var.tenantId;
    let stopped = 0;
    for (const st of STREAMS.values()) {
      if (st.tenantId !== tenantId || st.cancelled) continue;
      st.cancelled = true;
      for (const t of st.timers) clearTimeout(t);
      st.timers = [];
      stopped += 1;
    }
    return c.json({ ok: true, stopped });
  });

  // ── DELETE /api/admin/sim/stream/:id ───────────────────────────────────
  app.delete("/api/admin/sim/stream/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const st = STREAMS.get(c.req.param("id"));
    if (!st || st.tenantId !== tenantId) return c.json({ error: "stream not found" }, 404);
    st.cancelled = true;
    for (const t of st.timers) clearTimeout(t);
    st.timers = [];
    return c.json({ ok: true, spawned: st.spawned, total: st.total });
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
    if (!brief) return c.json({ error: "personaId or brief required" }, 400);
    const displayName = (body.displayName?.trim() || persona?.displayName || "Симулятор клиента").trim();
    const maxTurns = Math.min(Math.max(1, body.maxTurns ?? DEFAULT_MAX_TURNS), MAX_TURNS_CAP);

    const ctx = await buildCtx(tenantId, adminId);
    if (typeof ctx === "string") return c.json({ error: ctx }, 400);

    try {
      const conversationId = await simulateClient(ctx, { brief, displayName, maxTurns });
      return c.json({ ok: true, conversationId, displayName, maxTurns });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── POST /api/admin/sim/stream ─────────────────────────────────────────
  // «Боевой режим»: N клиентов появляются по одному каждые intervalSec.
  app.post("/api/admin/sim/stream", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? 0;

    let body: { count?: number; intervalSec?: number; personaIds?: string[]; maxTurns?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const count = Math.min(Math.max(1, body.count ?? 5), MAX_STREAM_CLIENTS);
    const intervalSec = Math.max(MIN_STREAM_INTERVAL_SEC, body.intervalSec ?? DEFAULT_STREAM_INTERVAL_SEC);
    const maxTurns = Math.min(Math.max(1, body.maxTurns ?? DEFAULT_MAX_TURNS), MAX_TURNS_CAP);
    const pool =
      body.personaIds && body.personaIds.length > 0
        ? PERSONAS.filter((p) => body.personaIds!.includes(p.id))
        : PERSONAS;
    if (pool.length === 0) return c.json({ error: "no matching personas" }, 400);

    const ctx = await buildCtx(tenantId, adminId);
    if (typeof ctx === "string") return c.json({ error: ctx }, 400);

    const streamId = `str_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state: StreamState = {
      id: streamId,
      tenantId,
      total: count,
      spawned: 0,
      intervalSec,
      cancelled: false,
      timers: [],
    };
    STREAMS.set(streamId, state);

    const spawnOne = () => {
      if (state.cancelled) return;
      const persona = pick(pool);
      state.spawned += 1;
      void simulateClient(ctx, {
        brief: persona.brief,
        displayName: randomName(),
        maxTurns,
      }).catch(() => {
        /* отдельный клиент упал — поток продолжается */
      });
    };

    // Первый — сразу, остальные по таймеру. (Регистрируем timers для отмены.)
    spawnOne();
    for (let i = 1; i < count; i++) {
      const t = setTimeout(spawnOne, i * intervalSec * 1000);
      state.timers.push(t);
    }

    return c.json({ ok: true, streamId, count, intervalSec, maxTurns });
  });

  // ── DELETE /api/admin/sim/:id ──────────────────────────────────────────
  app.delete("/api/admin/sim/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const conversationId = Number(c.req.param("id"));
    if (!Number.isFinite(conversationId)) return c.json({ error: "invalid conversation id" }, 400);

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

  return app;
}
