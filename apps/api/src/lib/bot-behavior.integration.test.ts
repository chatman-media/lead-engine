// Integration test for bot behavior gates (эпик #623): стоп-слова → оператор,
// вне рабочих часов → тихо/авто-сообщение, приветствие при первом сообщении.
// Требует живой Postgres (DATABASE_URL); иначе suite skip'ается.

import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import {
  type BotSettings,
  DEFAULT_BOT_SETTINGS,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  conversations,
  createIsolatedDb,
  outboundQueue,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { makeAuthRoutes } from "../routes/auth.ts";
import { makeTelegramWebhookRoutes } from "../routes/webhook-telegram.ts";
import { autoCloseTick } from "./auto-close.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_botbeh_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-botbeh-12345";
const TG_SECRET = "tg-botbeh-secret-xyz";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let channelDbId = 0;
let entry: Record<string, unknown> | null = null;
// Текущие настройки, которые отдаёт resolveBotSettings (мутируем в тестах).
let botSettings: BotSettings = { ...DEFAULT_BOT_SETTINGS };

const echoStrategy = {
  // biome-ignore lint/suspicious/noExplicitAny: тестовый fake ReplyStrategy
  generate: async (o: any) => [
    {
      channelId: String(channelDbId),
      externalUserId: o.inbound.externalUserId as string,
      parts: [{ kind: "text" as const, text: "AI ответ" }],
    },
  ],
};

async function post(slug: string, body: unknown, secret: string | null): Promise<Response> {
  return app.request(`/webhook/telegram/${slug}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function tgText(text: string, fromId: number, messageId: number): unknown {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: messageId,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, username: "beh" },
      date: 1700000000,
      text,
    },
  };
}

async function convFor(fromId: number) {
  const [ident] = await db
    .select({ contactId: channelIdentities.contactId })
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channelId, channelDbId),
        eq(channelIdentities.externalUserId, String(fromId)),
      ),
    );
  if (!ident) return null;
  const [conv] = await db
    .select({ id: conversations.id, mode: conversations.mode })
    .from(conversations)
    .where(and(eq(conversations.userId, ident.contactId), eq(conversations.channelId, channelDbId)));
  return conv ?? null;
}

async function outboundTexts(conversationId: number): Promise<string[]> {
  const rows = await db
    .select({ payloadJson: outboundQueue.payloadJson })
    .from(outboundQueue)
    .where(eq(outboundQueue.conversationId, conversationId));
  const texts: string[] = [];
  for (const r of rows) {
    try {
      const env = JSON.parse(r.payloadJson) as { parts?: Array<{ text?: string }> };
      for (const p of env.parts ?? []) if (p.text) texts.push(p.text);
    } catch {
      // ignore
    }
  }
  return texts;
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 });
  const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(testUrl, { max: 2, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  const channelsStub = {
    getTelegramBotsByTenant: (slug: string) => (slug === "demo" && entry ? [entry] : []),
    // biome-ignore lint/suspicious/noExplicitAny: minimal ChannelRegistry stub
  } as any;
  app.route(
    "/",
    makeTelegramWebhookRoutes({
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
      db: db as any,
      channels: channelsStub,
      webhookSecret: TG_SECRET,
      // biome-ignore lint/suspicious/noExplicitAny: fake ReplyStrategy
      replyStrategy: echoStrategy as any,
      resolveReplyDelaySeconds: async () => 0, // без debounce — ответ inline
      resolveBotSettings: async () => botSettings,
    }),
  );

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "botbeh@demo.io", password: "strong-pwd-12345" }),
  });
  tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;
  channelDbId = await withTenant(db, tenantId, async (tx) => {
    const [ch] = await tx
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: "@behbot", status: "active" })
      .returning();
    return ch!.id;
  });
  const adapter = new TelegramBotAdapter({ id: String(channelDbId), token: "TKN", fetch: globalThis.fetch });
  entry = {
    tenantId,
    tenantSlug: "demo",
    channelDbId,
    kind: "telegram_bot",
    externalId: "@behbot",
    tenantPlan: "free",
    adapter,
  };
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("bot behavior gates", () => {
  it("стоп-слово → диалог уходит оператору (mode=human), без AI-ответа", async () => {
    if (!sql) return;
    botSettings = { ...DEFAULT_BOT_SETTINGS, stopWords: ["оператор"] };
    await post("demo", tgText("позовите оператора пожалуйста", 8101, 1), TG_SECRET);
    const conv = await convFor(8101);
    expect(conv?.mode).toBe("human");
    expect(await outboundTexts(conv!.id)).not.toContain("AI ответ");
  });

  it("вне рабочих часов → бот молчит, шлёт авто-сообщение", async () => {
    if (!sql) return;
    // Окно [now+120, now+180] мин (UTC) — сейчас точно вне его.
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = (nowMin + 120) % 1440;
    const end = (start + 60) % 1440;
    botSettings = {
      ...DEFAULT_BOT_SETTINGS,
      hoursEnabled: true,
      hoursStartMin: start,
      hoursEndMin: end,
      hoursTz: "UTC",
      offhoursMessage: "Мы отвечаем с 9 до 18.",
    };
    await post("demo", tgText("привет", 8102, 1), TG_SECRET);
    const conv = await convFor(8102);
    const texts = await outboundTexts(conv!.id);
    expect(texts).toContain("Мы отвечаем с 9 до 18.");
    expect(texts).not.toContain("AI ответ"); // AI не отвечает вне часов
  });

  it("приветствие при первом сообщении уходит вместе с ответом", async () => {
    if (!sql) return;
    botSettings = { ...DEFAULT_BOT_SETTINGS, greetingText: "Здравствуйте!" };
    await post("demo", tgText("хочу обмен", 8103, 1), TG_SECRET);
    const conv = await convFor(8103);
    const texts = await outboundTexts(conv!.id);
    expect(texts).toContain("Здравствуйте!");
    expect(texts).toContain("AI ответ");
  });

  it("дефолтные настройки → обычный AI-ответ (нулевая регрессия)", async () => {
    if (!sql) return;
    botSettings = { ...DEFAULT_BOT_SETTINGS };
    await post("demo", tgText("сколько стоит", 8104, 1), TG_SECRET);
    const conv = await convFor(8104);
    expect(conv?.mode).toBe("ai");
    expect(await outboundTexts(conv!.id)).toContain("AI ответ");
  });

  it("#632 — авто-закрытие: idle-диалог старше порога → resolved", async () => {
    if (!sql) return;
    botSettings = { ...DEFAULT_BOT_SETTINGS };
    await post("demo", tgText("давний вопрос", 8105, 1), TG_SECRET);
    const conv = await convFor(8105);
    // Делаем диалог «протухшим»: last_message_at сутки назад.
    const dayAgo = Math.floor(Date.now() / 1000) - 24 * 3600;
    await db.update(conversations).set({ lastMessageAt: dayAgo }).where(eq(conversations.id, conv!.id));

    await autoCloseTick(db, {
      nowSec: Math.floor(Date.now() / 1000),
      resolveBotSettings: async () => ({ ...DEFAULT_BOT_SETTINGS, autocloseHours: 12 }),
    });

    const [after] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conv!.id));
    expect(after?.status).toBe("resolved");
  });

  it("#632 — свежий диалог не закрывается", async () => {
    if (!sql) return;
    botSettings = { ...DEFAULT_BOT_SETTINGS };
    await post("demo", tgText("свежий", 8106, 1), TG_SECRET);
    const conv = await convFor(8106);
    await autoCloseTick(db, {
      nowSec: Math.floor(Date.now() / 1000),
      resolveBotSettings: async () => ({ ...DEFAULT_BOT_SETTINGS, autocloseHours: 12 }),
    });
    const [after] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conv!.id));
    expect(after?.status).not.toBe("resolved");
  });
});
