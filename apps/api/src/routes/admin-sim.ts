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
  LeadsRepo,
  MessagesRepo,
  OutboundQueueRepo,
  processInbound,
  type ReplyStrategy,
  type StageClassifier,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { FieldExtractor } from "../lib/field-extractor.ts";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { Inbound, OutboundPart } from "@chatman-media/channel-core";
import {
  channels,
  contacts,
  conversations,
  funnels,
  leadEvents,
  leadFieldValues,
  leads,
  messages,
  stageDefinitions,
  stageFields,
  tenants,
} from "@chatman-media/storage";
import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Криптостойкий короткий токен для sim-идентификаторов (sim-user, message-id,
 * stream-id). Эти id участвуют в дедупликации/идентичности контактов, поэтому
 * Math.random() здесь небезопасен (CodeQL js/insecure-randomness).
 */
function simToken(bytes = 5): string {
  return randomBytes(bytes).toString("hex");
}

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

// Глобальный kill-switch на тенант: «Остановить все» инкрементит epoch, и каждый
// идущий simulateClient видит расхождение между своим стартовым epoch и текущим
// → прерывает диалог между ходами (не убивая сервер).
const CANCEL_EPOCH = new Map<number, number>();

// ── Funnel walker (полное прохождение воронки «как нужно») ────────────────────

interface WalkField {
  id: number;
  slug: string;
  fieldType: string;
  required: boolean;
  optionsJson: string;
  displayName: string;
}
interface WalkStage {
  id: number;
  slug: string;
  displayName: string;
  kind: string;
  stageType: string;
  nextStages: string[];
}

// Правдоподобные числа для типовых полей обмена/воронки.
const NUM_BY_SLUG: Record<string, number> = {
  amount_from: 500,
  exchange_rate: 32.7,
  thb_amount: 16350,
  matched_amount: 16350,
  final_thb_paid: 16350,
  risk_score: 12,
  requisites_ttl: 30,
};

function synthValue(f: WalkField): unknown {
  let opts: Array<{ value: string; label?: string }> = [];
  try {
    opts = JSON.parse(f.optionsJson || "[]");
  } catch {
    opts = [];
  }
  switch (f.fieldType) {
    case "select":
      return opts[0]?.value ?? "ok";
    case "multiselect":
      return opts[0]?.value ? [opts[0].value] : [];
    case "boolean":
      return true;
    case "number":
      return NUM_BY_SLUG[f.slug] ?? 1;
    case "date":
      return "2026-06-20";
    case "phone":
      return "+66 80 123 4567";
    case "email":
      return "client@example.com";
    case "photo":
    case "video":
    case "file":
      return "received";
    default:
      return f.displayName;
  }
}

function isMedia(f: WalkField): boolean {
  return f.fieldType === "video" || f.fieldType === "photo" || f.fieldType === "file";
}

// Реплика-нарратор для стадии: клиент (ответ/медиа) или оператор (подтверждение).
function narrate(stage: WalkStage, fields: WalkField[]): { role: "user" | "assistant"; text: string } {
  if (stage.kind === "terminal_won") return { role: "assistant", text: "🎉 Сделка завершена — выдача выполнена." };
  if (stage.kind === "terminal_lost") return { role: "assistant", text: "Заявка отменена." };
  const media = fields.find(isMedia);
  if (media) {
    const isVideo = media.fieldType === "video" || /verif|kyc/.test(media.slug);
    return {
      role: "user",
      text: isVideo
        ? "📹 Прислал видео для верификации личности."
        : "🧾 Прислал подтверждение (документ/скрин оплаты).",
    };
  }
  const operatorish = ["assessment", "external_approval", "milestone", "rate_confirmation"].includes(
    stage.stageType,
  );
  if (operatorish) return { role: "assistant", text: `✅ ${stage.displayName} — подтверждено оператором.` };
  return { role: "user", text: `Ответил на вопросы этапа «${stage.displayName}».` };
}

/**
 * Создаёт `count` лидов и проводит каждого по ВСЕЙ активной воронке: на каждой
 * стадии заполняет её поля (синтетика по типу — ответы, видео-верификация,
 * пруф оплаты, подтверждения), пишет диалог в self_play и двигает до won.
 */
async function walkLeads(
  db: Db,
  tenantId: number,
  adminId: number,
  count: number,
  displayName?: string,
): Promise<{ kind: "ok"; leadIds: number[]; finalStage: string } | { kind: "no_funnel" }> {
  return withTenant(db, tenantId, async (tx) => {
    const [funnel] = await tx
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
      .limit(1);
    if (!funnel) return { kind: "no_funnel" as const };

    const stages: WalkStage[] = await tx
      .select({
        id: stageDefinitions.id,
        slug: stageDefinitions.slug,
        displayName: stageDefinitions.displayName,
        kind: stageDefinitions.kind,
        stageType: stageDefinitions.stageType,
        nextStages: stageDefinitions.nextStages,
      })
      .from(stageDefinitions)
      .where(eq(stageDefinitions.funnelId, funnel.id))
      .orderBy(asc(stageDefinitions.position));
    if (stages.length === 0) return { kind: "no_funnel" as const };

    const stageIds = stages.map((s) => s.id);
    const allFields = await tx
      .select({
        stageId: stageFields.stageId,
        id: stageFields.id,
        slug: stageFields.slug,
        fieldType: stageFields.fieldType,
        required: stageFields.required,
        optionsJson: stageFields.optionsJson,
        displayName: stageFields.displayName,
      })
      .from(stageFields)
      .where(eq(stageFields.tenantId, tenantId));
    const fieldsByStage = new Map<number, WalkField[]>();
    for (const f of allFields) {
      if (!stageIds.includes(f.stageId)) continue;
      const arr = fieldsByStage.get(f.stageId) ?? [];
      arr.push(f);
      fieldsByStage.set(f.stageId, arr);
    }

    const intake = stages.find((s) => s.kind === "intake") ?? stages[0]!;
    const leadIds: number[] = [];
    let finalStage = "";
    const baseNow = Math.floor(Date.now() / 1000);

    for (let i = 0; i < count; i++) {
      let ts = baseNow + i * 1000;
      const name = (displayName?.trim() || randomName()).trim();
      const [contact] = await tx
        .insert(contacts)
        .values({ tenantId, displayName: name, createdAt: ts })
        .returning({ id: contacts.id });
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId,
          userId: contact!.id,
          source: "self_play",
          mode: "ai",
          status: "open",
          lastMessageAt: ts,
        })
        .returning({ id: conversations.id });
      const [lead] = await tx
        .insert(leads)
        .values({
          tenantId,
          userId: contact!.id,
          state: intake.slug,
          stageDefinitionId: intake.id,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning({ id: leads.id });
      leadIds.push(lead!.id);

      let cur: WalkStage | undefined = intake;
      let guard = 0;
      while (cur && guard < stages.length + 2) {
        guard++;
        // 1. заполняем поля стадии
        for (const f of fieldsByStage.get(cur.id) ?? []) {
          await tx.insert(leadFieldValues).values({
            leadId: lead!.id,
            fieldId: f.id,
            tenantId,
            valueJson: JSON.stringify(synthValue(f)),
            updatedAt: ts,
            updatedByAdminId: adminId,
          });
        }
        // 2. нарратор в чат
        ts++;
        const msg = narrate(cur, fieldsByStage.get(cur.id) ?? []);
        await tx.insert(messages).values({
          tenantId,
          conversationId: conv!.id,
          role: msg.role,
          text: msg.text,
          metaJson: JSON.stringify({ _sim: true, _walk: true, adminId }),
          createdAt: ts,
        });
        await tx
          .update(conversations)
          .set({ lastMessageAt: ts, lastMessageText: msg.text.slice(0, 200) })
          .where(eq(conversations.id, conv!.id));
        finalStage = cur.slug;

        if (cur.kind === "terminal_won" || cur.kind === "terminal_lost") break;
        const nextSlug: string | undefined = cur.nextStages[0];
        const next: WalkStage | undefined = nextSlug
          ? stages.find((s) => s.slug === nextSlug)
          : undefined;
        if (!next) break;
        await tx
          .update(leads)
          .set({ stageDefinitionId: next.id, state: next.slug, updatedAt: ts })
          .where(eq(leads.id, lead!.id));
        await tx.insert(leadEvents).values({
          tenantId,
          leadId: lead!.id,
          fromState: cur.slug,
          toState: next.slug,
          byAdminId: adminId,
          createdAt: ts,
        });
        cur = next;
      }
    }

    return { kind: "ok" as const, leadIds, finalStage };
  });
}

// ── Route factory ────────────────────────────────────────────────────────────

export function makeAdminSimRoutes(opts: {
  db: Db;
  replyStrategy?: ReplyStrategy | null;
  resolveSimChat: (tenantId: number) => ChatClient | null;
  resolveTemplate?: (tenantSlug: string) => VerticalTemplate | undefined;
  stageClassifier?: StageClassifier | null;
  /** Извлечение полей лида из текста (заполняет lead_field_values + auto-advance). */
  fieldExtractor?: FieldExtractor | null;
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
    params: { brief: string; displayName: string; maxTurns: number; isCancelled?: () => boolean },
  ): Promise<number> {
    const { tenantId, adminId } = ctx;
    // Снимок epoch на старте: если «Остановить все» инкрементит его — прерываемся.
    const startEpoch = CANCEL_EPOCH.get(tenantId) ?? 0;
    const aborted = () =>
      (CANCEL_EPOCH.get(tenantId) ?? 0) !== startEpoch || params.isCancelled?.() === true;
    const tenant = { tenantId, slug: ctx.tenantSlug, llmBillingMode: "byok" as const };
    // kind='self_play' → conversation.source='self_play' (см. channelKindToSource).
    // ChannelContext.kind не содержит 'self_play' в типе — cast локально для sim.
    const channel = {
      channelId: ctx.channelDbId,
      kind: "self_play" as unknown as "telegram_bot",
      externalId: ctx.externalId,
    };
    const channelIdStr = String(ctx.channelDbId);
    const simStamp = `${adminId}_${Date.now()}_${simToken()}`;
    const externalUserId = `__sim_${simStamp}__`;

    const runExchange = async (
      userText: string,
    ): Promise<{ conversationId: number; contactId: number; botReply: string } | null> => {
      const now = Math.floor(Date.now() / 1000);
      const inbound: Inbound = {
        channelId: channelIdStr,
        externalMessageId: `sim-${Date.now()}-${simToken()}`,
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
          leads: new LeadsRepo({ db: tx, tenantId }),
          reply: null,
          ...(ctx.template ? { template: ctx.template } : {}),
          ...(opts.stageClassifier ? { stageClassifier: opts.stageClassifier, db: tx } : {}),
        }),
      );
      if (!pi) return null;

      // Извлекаем поля лида из реплики (заполняет lead_field_values + двигает
      // стадию по заполненности) — чтобы у sim-лидов был реальный прогресс,
      // а не «0%». Не блокируем диалог: ошибки глотаем.
      if (opts.fieldExtractor) {
        try {
          await opts.fieldExtractor.extract({
            tenantId,
            contactId: pi.contactId,
            text: userText,
            db: opts.db,
          });
        } catch {
          /* извлечение полей не критично для диалога */
        }
      }

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
        if (aborted()) break; // kill-switch: «Остановить все» / стоп потока
        const userText = await nextUserMessage();
        if (!userText || aborted()) break;
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
    // Глобальный kill-switch: инкремент epoch обрывает ВСЕ идущие диалоги тенанта
    // (и потоковые, и одиночные) между ходами.
    CANCEL_EPOCH.set(tenantId, (CANCEL_EPOCH.get(tenantId) ?? 0) + 1);
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

    const streamId = `str_${Date.now()}_${simToken(6)}`;
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
        isCancelled: () => state.cancelled, // стоп потока обрывает и идущие диалоги
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

  // ── POST /api/admin/sim/walk ───────────────────────────────────────────
  // Проводит НОВОГО лида по ВСЕЙ активной воронке «как нужно»: на каждой
  // стадии удовлетворяет её поля (ответы, видео-верификация, пруф оплаты,
  // подтверждения оператора) и двигает дальше — до терминальной won-стадии.
  // Пишет диалог в self_play (виден в инбоксе), заполняет lead_field_values.
  app.post("/api/admin/sim/walk", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? 0;
    let body: { count?: number; displayName?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = {};
    }
    const count = Math.min(Math.max(1, body.count ?? 1), 10);

    const created = await walkLeads(opts.db, tenantId, adminId, count, body.displayName);
    if (created.kind === "no_funnel") return c.json({ error: "no active funnel with stages" }, 400);
    return c.json({ ok: true, leads: created.leadIds, finalStage: created.finalStage });
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
