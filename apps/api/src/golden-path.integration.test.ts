// Golden-path backend e2e: один сквозной прогон критичного маршрута диалога
// через РЕАЛЬНЫЙ pipeline (makeTelegramWebhookRoutes → processInbound →
// generateReplyAndEnqueue) и РЕАЛЬНЫЕ NotificationService/AdminInformer.
// Замокано только сетевое окружение: fake reply-strategy (вместо LLM),
// TelegramBotAdapter без API-вызовов, fake Telegram-sender у информера.
//
// Сценарий (всё в одном диалоге, один контакт):
//   1. Клиент пишет → бот отвечает → ответ в outbound_queue + assistant-сообщение.
//   2. Клиент пишет снова → стратегия эскалирует → диалог уходит оператору
//      (mode='human') + владельцу приходит алерт (лента admin_notifications +
//      realtime-пуш в его личный Telegram).
//   3. Оператор отвечает через POST /admin/conversations/:id/reply → ответ
//      клиенту в outbound_queue + human-сообщение.
//
// Требует DATABASE_URL (owner-роль); без него тест graceful-skip'ается.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import {
  AdminInformer,
  NotificationService,
  NotificationsRepo,
  type ReplyStrategy,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  adminNotifications,
  admins,
  applyAllMigrations,
  channels,
  conversations,
  createIsolatedDb,
  messages,
  operatorSettings,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { makeRequireAuth } from "./middleware/require-auth.ts";
import { makeAdminConversationsRoutes } from "./routes/admin-conversations.ts";
import { makeAuthRoutes } from "./routes/auth.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_golden_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-golden-flow-12345";
const TG_SECRET = "golden-tg-webhook-secret";
const OWNER_CHAT = "999000111";
const CLIENT_TG_ID = 7;

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let ownerAdminId = 0;
let token = "";
let entry: Record<string, unknown> | null = null;

// Управляемая fake-стратегия: "bot" → обычный ответ, "escalate" → передача оператору.
let replyMode: "bot" | "escalate" = "bot";
// Перехват realtime-пушей информера владельцу (вместо реального Telegram).
const informerSends: Array<{ chatId: string; html: string }> = [];

function tgUpdate(text: string, fromId = CLIENT_TG_ID): unknown {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      chat: { id: fromId, type: "private" },
      from: { id: fromId, username: "kate" },
      date: 1700000000,
      text,
    },
  };
}

async function postWebhook(slug: string, body: unknown): Promise<Response> {
  return app.request(`/webhook/telegram/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": TG_SECRET },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  // Управляемая reply-стратегия (читает replyMode лениво).
  const replyStrategy: ReplyStrategy = {
    generate: async ({ channel, inbound, userMessageText }) => {
      if (replyMode === "escalate") {
        return {
          envelopes: [],
          autoTakeover: true,
          operatorHandoffs: [
            { reason: "operator_request", title: "Нужен оператор", action: "operator_reply" },
          ],
        };
      }
      return [
        {
          channelId: String(channel.channelId),
          externalUserId: inbound.externalUserId,
          parts: [{ kind: "text", text: `Бот: ${userMessageText}` }],
        },
      ];
    },
  };

  // Информер владельца с fake Telegram-отправителем (перехват push'ей).
  const adminInformer = new AdminInformer({
    db: db as never,
    botToken: "",
    appUrl: "http://golden.local",
    telegram: {
      send: async (chatId, html) => {
        informerSends.push({ chatId, html });
      },
    },
  });
  // botToken="" → NotificationService шлёт только информеру (без per-operator сети).
  const notificationService = new NotificationService(
    new NotificationsRepo(db as never),
    "",
    "http://golden.local",
    adminInformer,
  );

  // Ленивый stub реестра каналов (entry заполняется после signup).
  const channelsStub = {
    getTelegramBotsByTenant: (slug: string) => (slug === "demo" && entry ? [entry] : []),
  } as never;

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.route(
    "/",
    makeTelegramWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
      db: db as any,
      channels: channelsStub,
      webhookSecret: TG_SECRET,
      replyStrategy,
      notificationService,
    }),
  );
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAdminConversationsRoutes({ db: db as any }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "golden@demo.io", password: "strong-pwd-12345" }),
  });
  const sj = (await sa.json()) as { token: string; admin: { tenantId: number } };
  token = sj.token;
  tenantId = sj.admin.tenantId;

  const [owner] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(and(eq(admins.tenantId, tenantId), eq(admins.role, "superadmin")));
  ownerAdminId = owner!.id;

  // Владелец привязал личный Telegram → операционные алерты доходят до него.
  await db.insert(operatorSettings).values({
    adminId: ownerAdminId,
    tenantId,
    telegramChatId: OWNER_CHAT,
    notifyOnAssignedOnly: false,
  });

  const channelDbId = await withTenant(db, tenantId, async (tx) => {
    const [ch] = await tx
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: "@goldenbot", status: "active" })
      .returning();
    return ch!.id;
  });

  const adapter = new TelegramBotAdapter({
    id: String(channelDbId),
    token: "TKN",
    fetch: globalThis.fetch,
  });
  entry = {
    tenantId,
    tenantSlug: "demo",
    channelDbId,
    kind: "telegram_bot",
    externalId: "@goldenbot",
    tenantPlan: "free",
    adapter,
  };
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
  sql = null;
}, 10_000);

describe("golden-path (inbound → bot → escalation → operator reply)", () => {
  it("сквозной маршрут диалога + алерт владельцу", async () => {
    if (!sql) return;

    // ── 1. Клиент пишет → бот отвечает ─────────────────────────────────────
    replyMode = "bot";
    const r1 = await postWebhook("demo", tgUpdate("привет"));
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { result?: { conversationId?: number } };
    const conversationId = b1.result?.conversationId ?? 0;
    expect(conversationId).toBeGreaterThan(0);

    const botOut = await db
      .select()
      .from(schema.outboundQueue)
      .where(
        and(
          eq(schema.outboundQueue.tenantId, tenantId),
          eq(schema.outboundQueue.conversationId, conversationId),
        ),
      );
    expect(botOut).toHaveLength(1);
    expect(botOut[0]?.payloadJson).toContain("Бот:");

    const assistantMsgs = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, conversationId),
          eq(messages.role, "assistant"),
        ),
      );
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);

    // ── 2. Клиент пишет снова → эскалация оператору + алерт владельцу ───────
    replyMode = "escalate";
    const r2 = await postWebhook("demo", tgUpdate("хочу живого оператора"));
    expect(r2.status).toBe(200);

    const [conv] = await db
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conv?.mode).toBe("human");

    // Эскалация НЕ слала клиенту бот-ответ (полный молчок) — outbound всё ещё 1.
    const afterEsc = await db
      .select({ id: schema.outboundQueue.id })
      .from(schema.outboundQueue)
      .where(
        and(
          eq(schema.outboundQueue.tenantId, tenantId),
          eq(schema.outboundQueue.conversationId, conversationId),
        ),
      );
    expect(afterEsc).toHaveLength(1);

    // Алерт владельцу: строка в ленте информера + realtime-пуш в его личный чат.
    const notif = await db
      .select()
      .from(adminNotifications)
      .where(
        and(
          eq(adminNotifications.tenantId, tenantId),
          eq(adminNotifications.kind, "operator_handoff_required"),
        ),
      );
    expect(notif).toHaveLength(1);
    expect(notif[0]?.adminId).toBe(ownerAdminId);
    expect(informerSends.some((s) => s.chatId === OWNER_CHAT)).toBe(true);

    // ── 3. Оператор отвечает через admin-роут → доставка клиенту ────────────
    const r3 = await app.request(`/api/admin/conversations/${conversationId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "Оператор: здравствуйте!" }),
    });
    expect(r3.status).toBe(200);

    const allOut = await db
      .select()
      .from(schema.outboundQueue)
      .where(
        and(
          eq(schema.outboundQueue.tenantId, tenantId),
          eq(schema.outboundQueue.conversationId, conversationId),
        ),
      );
    // Теперь две исходящих: бот-ответ (шаг 1) + ответ оператора (шаг 3).
    expect(allOut).toHaveLength(2);
    expect(allOut.some((o) => o.payloadJson.includes("Оператор: здравствуйте!"))).toBe(true);

    const humanMsgs = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, conversationId),
          eq(messages.role, "human"),
        ),
      );
    expect(humanMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
