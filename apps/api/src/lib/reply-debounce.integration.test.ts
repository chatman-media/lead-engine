// Integration test for the reply debounce (пауза перед ответом): webhook ставит
// conversations.reply_due_at вместо немедленного ответа, поллер replyDebounceTick
// добивает один ответ по тишине. Требует живой Postgres (DATABASE_URL); без него
// весь suite skip'ается (как webhook-telegram.integration.test.ts).

import { TelegramBotAdapter } from "@chatman-media/channel-telegram";
import { DEFAULT_BOT_SETTINGS, withTenant } from "@chatman-media/conversation-engine";
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
import { replyDebounceTick } from "./reply-debounce.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_debounce_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-debounce-12345";
const TG_SECRET = "tg-debounce-secret-xyz";
const DELAY_SEC = 3;

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let tenantId = 0;
let channelDbId = 0;
let entry: Record<string, unknown> | null = null;

// Эхо-стратегия: один текстовый envelope получателю из inbound. Используется и
// webhook'ом (через botSettings.replyDelaySeconds=3 он не зовётся сразу), и поллером.
const echoStrategy = {
  // biome-ignore lint/suspicious/noExplicitAny: тестовый fake ReplyStrategy
  generate: async (o: any) => [
    {
      channelId: String(channelDbId),
      externalUserId: o.inbound.externalUserId as string,
      parts: [{ kind: "text" as const, text: "debounced reply" }],
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
      from: { id: fromId, username: "deb" },
      date: 1700000000,
      text,
    },
  };
}

/** Conversation-строка контакта с externalUserId = String(fromId) в нашем канале. */
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
    .select({ id: conversations.id, replyDueAt: conversations.replyDueAt, mode: conversations.mode })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, ident.contactId),
        eq(conversations.channelId, channelDbId),
      ),
    );
  return conv ?? null;
}

async function outboundCount(conversationId: number): Promise<number> {
  const rows = await db
    .select({ id: outboundQueue.id })
    .from(outboundQueue)
    .where(eq(outboundQueue.conversationId, conversationId));
  return rows.length;
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
      // Пауза включена через botSettings.replyDelaySeconds → webhook планирует, не отвечает сразу.
      resolveBotSettings: async () => ({ ...DEFAULT_BOT_SETTINGS, replyDelaySeconds: DELAY_SEC }),
    }),
  );

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "debounce@demo.io", password: "strong-pwd-12345" }),
  });
  tenantId = ((await sa.json()) as { admin: { tenantId: number } }).admin.tenantId;

  channelDbId = await withTenant(db, tenantId, async (tx) => {
    const [ch] = await tx
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: "@debot", status: "active" })
      .returning();
    return ch!.id;
  });
  const adapter = new TelegramBotAdapter({ id: String(channelDbId), token: "TKN", fetch: globalThis.fetch });
  entry = {
    tenantId,
    tenantSlug: "demo",
    channelDbId,
    kind: "telegram_bot",
    externalId: "@debot",
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

describe("reply debounce", () => {
  it("при delay>0 webhook не отвечает сразу, а ставит reply_due_at ≈ now+delay", async () => {
    if (!sql) return;
    const nowBefore = Math.floor(Date.now() / 1000);
    const res = await post("demo", tgText("первое", 9001, 1), TG_SECRET);
    expect(res.status).toBe(200);

    const conv = await convFor(9001);
    expect(conv).not.toBeNull();
    // Ответ не сгенерирован сразу.
    expect(await outboundCount(conv!.id)).toBe(0);
    // reply_due_at выставлен в будущее ≈ now+delay.
    expect(conv!.replyDueAt).not.toBeNull();
    expect(conv!.replyDueAt!).toBeGreaterThanOrEqual(nowBefore + 1);
  });

  it("второе сообщение в окне перезаписывает reply_due_at (сброс таймера)", async () => {
    if (!sql) return;
    await post("demo", tgText("a", 9002, 1), TG_SECRET);
    const due1 = (await convFor(9002))!.replyDueAt!;
    await post("demo", tgText("b", 9002, 2), TG_SECRET);
    const conv = await convFor(9002);
    expect(conv!.replyDueAt).not.toBeNull();
    // Дедлайн не раньше прежнего (таймер сброшен/продлён), без немедленного ответа.
    expect(conv!.replyDueAt!).toBeGreaterThanOrEqual(due1);
    expect(await outboundCount(conv!.id)).toBe(0);
  });

  it("replyDebounceTick генерит один ответ по наступившему дедлайну и чистит due_at", async () => {
    if (!sql) return;
    await post("demo", tgText("готов обменять", 9003, 1), TG_SECRET);
    const conv = await convFor(9003);
    expect(conv!.replyDueAt).not.toBeNull();
    expect(await outboundCount(conv!.id)).toBe(0);

    // nowSec в будущем → дедлайн наступил.
    await replyDebounceTick(db, {
      nowSec: Math.floor(Date.now() / 1000) + 100,
      // biome-ignore lint/suspicious/noExplicitAny: fake ReplyStrategy
      replyStrategy: echoStrategy as any,
    });

    const after = await convFor(9003);
    expect(after!.replyDueAt).toBeNull(); // claim очистил
    expect(await outboundCount(conv!.id)).toBe(1); // один ответ в очереди
  });

  it("mode='human' (оператор) → due_at очищается, ответ не генерится", async () => {
    if (!sql) return;
    await post("demo", tgText("вопрос", 9004, 1), TG_SECRET);
    const conv = await convFor(9004);
    // Имитируем уход к оператору: mode=human, дедлайн в прошлом.
    await db
      .update(conversations)
      .set({ mode: "human", replyDueAt: Math.floor(Date.now() / 1000) - 1 })
      .where(eq(conversations.id, conv!.id));

    await replyDebounceTick(db, {
      nowSec: Math.floor(Date.now() / 1000) + 100,
      // biome-ignore lint/suspicious/noExplicitAny: fake ReplyStrategy
      replyStrategy: echoStrategy as any,
    });

    const after = await convFor(9004);
    expect(after!.replyDueAt).toBeNull(); // claim очистил
    expect(await outboundCount(conv!.id)).toBe(0); // но ответа нет (mode!=ai)
  });
});
