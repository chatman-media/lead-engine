// Stage 8 (multi-tenant validation): E2E проверка что два независимых
// tenant'а с собственными telegram_bot каналами полностью изолированы
// по данным. Реалистичный сценарий "onboard 2-го клиента" из
// архитектурного плана.
//
// Поток теста (для каждого из A/B):
//   1. Tenant seed'ится через ту же модель что onboard-tenant.ts:
//      tenants row + channels row + (опц.) funnel
//   2. Telegram webhook POST'ит inbound для tenant'а через настоящий
//      makeTelegramWebhookRoutes (включая secret validation, channel
//      lookup, processInbound pipeline → withTenant tx)
//   3. Verify: contact + conversation + message persisted с tenant_id=X
//   4. Admin route GET /admin/conversations под Host=X.test.local →
//      возвращает ровно свою row, не чужую
//
// Изоляция проверяется:
//   - admin endpoints не видят чужих rows (per-handler withTenant)
//   - cross-tenant lookup по id (alpha запрашивает контакт beta) → 404
//   - сырая БД проверка: tenant_id матрица сходится

import type {
  ChannelAdapter,
  ChannelCapabilities,
  DeleteOpts,
  EditOpts,
  Inbound,
  MediaRef,
  OutboundEnvelope,
  Sent,
} from "@chatman-media/channel-core";
import type { TgUpdate } from "@chatman-media/channel-telegram";
import { makePlatformMetrics } from "@chatman-media/observability";
import {
  applyAllMigrations,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  messages,
  schema,
  tenants,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { type ChannelEntry, ChannelRegistry } from "./channel-registry.ts";
import { makeTenantContextMiddleware, requireTenant } from "./middleware/tenant-context.ts";
import { makeAdminRoutes } from "./routes/admin.ts";
import { makeTelegramWebhookRoutes } from "./routes/webhook-telegram.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_mt_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "packages", "storage", "migrations");
const TELEGRAM_SECRET = "test-telegram-secret";
const BASE_DOMAIN = "test.local";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
const tenantIds: Record<"alpha" | "beta", number> = { alpha: 0, beta: 0 };
const channelDbIds: Record<"alpha" | "beta", number> = { alpha: 0, beta: 0 };
const adapters: Record<"alpha" | "beta", FakeTelegramAdapter> = {} as any;
let nowEpoch = 0;

/**
 * Fake Telegram adapter. pushUpdate() парсит TgUpdate → Inbound, кладёт
 * в локальный inbox; receive() выдаёт его pipeline'у. Достаточно для
 * end-to-end webhook → pipeline flow без сетевых вызовов в Telegram API.
 */
class FakeTelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram_bot" as const;
  readonly id: string;
  readonly capabilities: ChannelCapabilities = {
    text: true,
    photo: false,
    video: false,
    voice: false,
    document: false,
    edit: false,
    delete: false,
    callbackQuery: false,
    typing: false,
  };
  private inbox: Inbound[] = [];

  constructor(id: string) {
    this.id = id;
  }
  pushUpdate(update: TgUpdate): void {
    const msg = update.message;
    if (!msg) return;
    this.inbox.push({
      channelId: this.id,
      externalMessageId: String(msg.message_id),
      externalUserId: String(msg.from?.id ?? "unknown"),
      receivedAt: msg.date ?? Math.floor(Date.now() / 1000),
      parts: msg.text ? [{ kind: "text", text: msg.text }] : [],
      raw: update,
    });
  }
  receive(): AsyncIterable<Inbound> {
    const self = this;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const next = self.inbox.shift();
          if (next) return { value: next, done: false };
          return { value: undefined as unknown as Inbound, done: true };
        },
      }),
    };
  }
  async send(_envelope: OutboundEnvelope): Promise<Sent> {
    return { channelId: this.id, externalMessageId: "fake-out", sentAt: 0 };
  }
  async edit(_opts: EditOpts): Promise<void> {}
  async delete(_opts: DeleteOpts): Promise<void> {}
  async downloadMedia(_r: MediaRef): Promise<Response> {
    throw new Error("not impl");
  }
  async signalTyping(_id: string): Promise<void> {}
  close(): void {}
}

class TestChannelRegistry extends ChannelRegistry {
  addEntry(entry: ChannelEntry): void {
    // biome-ignore lint/suspicious/noExplicitAny: tunneling в private
    const byTenant: Map<string, ChannelEntry[]> = (this as any).byTenantSlug;
    // biome-ignore lint/suspicious/noExplicitAny: tunneling в private
    const byDbId: Map<number, ChannelEntry> = (this as any).byDbId;
    const list = byTenant.get(entry.tenantSlug) ?? [];
    list.push(entry);
    byTenant.set(entry.tenantSlug, list);
    byDbId.set(entry.channelDbId, entry);
  }
}

beforeAll(
  async () => {
    if (!ownerUrl) return;
    const probe = await tryConnectToPg(ownerUrl);
    if (!probe) return;
    await probe.end({ timeout: 0 });
    const testUrl = await createIsolatedDb({ ownerUrl, testDbName: dbName });
    sql = postgres(testUrl, { max: 4, onnotice: () => {} });
    await applyAllMigrations(sql, migrationsDir);
    // Apps run под superuser/BYPASSRLS на локальном dev — pipeline'у это OK;
    // под dedicated non-bypass role'ью pipeline тоже работает (см.
    // packages/storage/src/rls.integration.test.ts). Здесь фокус на
    // data-level изоляции, не на RLS-механике.
    db = drizzle(sql, { schema });
    nowEpoch = Math.floor(Date.now() / 1000);

    const registry = new TestChannelRegistry();

    for (const slug of ["alpha", "beta"] as const) {
      const [t] = await db
        .insert(tenants)
        .values({
          slug,
          plan: "free",
          status: "active",
          llmBillingMode: "byok",
          createdAt: nowEpoch,
          updatedAt: nowEpoch,
        })
        .returning();
      if (!t) throw new Error(`seed tenant ${slug}`);
      tenantIds[slug] = t.id;

      const [ch] = await db
        .insert(channels)
        .values({
          tenantId: t.id,
          kind: "telegram_bot",
          externalId: `${slug}-bot`,
          status: "active",
          createdAt: nowEpoch,
          updatedAt: nowEpoch,
        })
        .returning();
      if (!ch) throw new Error(`seed channel ${slug}`);
      channelDbIds[slug] = ch.id;

      const adapter = new FakeTelegramAdapter(String(ch.id));
      adapters[slug] = adapter;
      registry.addEntry({
        channelDbId: ch.id,
        tenantId: t.id,
        tenantSlug: slug,
        tenantPlan: "free",
        kind: "telegram_bot",
        externalId: `${slug}-bot`,
        // FakeTelegramAdapter удовлетворяет channel-core ChannelAdapter
        // интерфейсу, но ChannelRegistry typed под конкретные классы
        // (TelegramBotAdapter | WhatsAppCloudAdapter). webhook-telegram
        // делает `entry.adapter as TelegramBotAdapter` без проверки —
        // safe cast в тестах.
        // biome-ignore lint/suspicious/noExplicitAny: structural cast для теста
        adapter: adapter as any,
      });
    }

    const metrics = makePlatformMetrics();
    app = new Hono();
    app.route(
      "/",
      makeTelegramWebhookRoutes({
        db,
        channels: registry,
        webhookSecret: TELEGRAM_SECRET,
        metrics,
      }),
    );
    app.use("/admin/*", makeTenantContextMiddleware({ baseDomain: BASE_DOMAIN }));
    app.use("/admin/*", requireTenant);
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
    app.route("/", makeAdminRoutes({ db: db as any }));
  },
  30_000,
);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

function tgUpdate(opts: {
  messageId: number;
  fromId: number;
  text: string;
}): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: opts.messageId,
      from: {
        id: opts.fromId,
        is_bot: false,
        first_name: `User-${opts.fromId}`,
      },
      chat: {
        id: opts.fromId,
        type: "private",
      },
      date: nowEpoch,
      text: opts.text,
    },
  };
}

async function postWebhook(slug: string, body: TgUpdate): Promise<Response> {
  return app.request(`/webhook/telegram/${slug}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_SECRET,
    },
    body: JSON.stringify(body),
  });
}

function tenantHost(slug: string): string {
  return `${slug}.${BASE_DOMAIN}`;
}

describe("multi-tenant isolation (Stage 8)", () => {
  it("setup sanity: 2 tenants + 2 channels created, no overlap", async () => {
    if (!sql) return;
    expect(tenantIds.alpha).toBeGreaterThan(0);
    expect(tenantIds.beta).toBeGreaterThan(0);
    expect(tenantIds.alpha).not.toBe(tenantIds.beta);
    expect(channelDbIds.alpha).not.toBe(channelDbIds.beta);
  });

  it("inbound для tenant alpha → persist'ит только под tenant_id=alpha", async () => {
    if (!sql) return;
    const res = await postWebhook(
      "alpha",
      tgUpdate({ messageId: 1001, fromId: 11111, text: "привет от alpha-user" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: boolean };
    expect(body.processed).toBe(true);

    // Все persist'ed rows у alpha tenant_id'а
    const alphaContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.tenantId, tenantIds.alpha));
    expect(alphaContacts).toHaveLength(1);

    const alphaConversations = await db
      .select()
      .from(conversations)
      .where(eq(conversations.tenantId, tenantIds.alpha));
    expect(alphaConversations).toHaveLength(1);

    const alphaMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.tenantId, tenantIds.alpha));
    expect(alphaMessages).toHaveLength(1);
    expect(alphaMessages[0]?.text).toBe("привет от alpha-user");

    // Beta — пусто
    const betaContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.tenantId, tenantIds.beta));
    expect(betaContacts).toHaveLength(0);
  });

  it("inbound для tenant beta → persist'ит только под tenant_id=beta (alpha не затронут)", async () => {
    if (!sql) return;
    const res = await postWebhook(
      "beta",
      tgUpdate({ messageId: 2001, fromId: 22222, text: "сообщение от beta-user" }),
    );
    expect(res.status).toBe(200);

    const betaContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.tenantId, tenantIds.beta));
    expect(betaContacts).toHaveLength(1);
    expect(betaContacts[0]?.tenantId).toBe(tenantIds.beta);

    const betaMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.tenantId, tenantIds.beta));
    expect(betaMessages).toHaveLength(1);
    expect(betaMessages[0]?.text).toBe("сообщение от beta-user");

    // Alpha — без изменений (всё ещё 1 message)
    const alphaMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.tenantId, tenantIds.alpha));
    expect(alphaMessages).toHaveLength(1);
  });

  it("admin /admin/conversations: alpha видит только свою conversation", async () => {
    if (!sql) return;
    const res = await app.request("/admin/conversations", {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number; tenantId?: number }> };
    expect(body.items).toHaveLength(1);
    // Полученная conversation должна принадлежать alpha
    const alphaConv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.tenantId, tenantIds.alpha));
    expect(body.items[0]?.id).toBe(alphaConv[0]!.id);
  });

  it("admin /admin/conversations: beta видит только свою (не alpha'ину)", async () => {
    if (!sql) return;
    const res = await app.request("/admin/conversations", {
      headers: { Host: tenantHost("beta") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: number }> };
    expect(body.items).toHaveLength(1);

    const betaConv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.tenantId, tenantIds.beta));
    const alphaConv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.tenantId, tenantIds.alpha));
    expect(body.items[0]?.id).toBe(betaConv[0]!.id);
    expect(body.items[0]?.id).not.toBe(alphaConv[0]!.id);
  });

  it("admin cross-tenant probe: alpha запрашивает контакт beta → 404", async () => {
    if (!sql) return;
    // Узнаём id beta'иного контакта (через DB), пробуем достать его как alpha
    const betaContact = (
      await db
        .select()
        .from(contacts)
        .where(eq(contacts.tenantId, tenantIds.beta))
    )[0]!;

    const res = await app.request(`/admin/contacts/${betaContact.id}`, {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(404);
  });

  it("admin cross-tenant probe: beta запрашивает контакт alpha → 404", async () => {
    if (!sql) return;
    const alphaContact = (
      await db
        .select()
        .from(contacts)
        .where(eq(contacts.tenantId, tenantIds.alpha))
    )[0]!;

    const res = await app.request(`/admin/contacts/${alphaContact.id}`, {
      headers: { Host: tenantHost("beta") },
    });
    expect(res.status).toBe(404);
  });

  it("admin cross-tenant: alpha запрашивает messages у beta'иной conversation → пустой list", async () => {
    if (!sql) return;
    const betaConv = (
      await db
        .select()
        .from(conversations)
        .where(eq(conversations.tenantId, tenantIds.beta))
    )[0]!;

    // Здесь endpoint вернёт 200 с пустым items (MessagesRepo фильтрует по
    // tenant_id из repo-context, conversation не найдётся в alpha-scope'е).
    const res = await app.request(`/admin/conversations/${betaConv.id}/messages`, {
      headers: { Host: tenantHost("alpha") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("multiple inbounds в один tenant → conversation re-used, не дублируется", async () => {
    if (!sql) return;
    // Второй inbound от того же user'а в alpha
    const res = await postWebhook(
      "alpha",
      tgUpdate({ messageId: 1002, fromId: 11111, text: "ещё одно сообщение от того же user'а" }),
    );
    expect(res.status).toBe(200);

    // Conversation остался один, message stack += 1
    const alphaConvs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.tenantId, tenantIds.alpha));
    expect(alphaConvs).toHaveLength(1);

    const alphaMsgs = await db
      .select()
      .from(messages)
      .where(eq(messages.tenantId, tenantIds.alpha));
    expect(alphaMsgs).toHaveLength(2);
  });

  it("matrix-проверка: сырой COUNT по tenant_id показывает строгую изоляцию", async () => {
    if (!sql) return;
    // Глобальный snapshot. Beta = 1 message, alpha = 2 (из предыдущих тестов).
    // Если изоляция нарушится — counts разойдутся.
    const matrix = (await sql`
      SELECT tenant_id, COUNT(*)::text as cnt FROM messages GROUP BY tenant_id ORDER BY tenant_id
    `) as unknown as Array<{ tenant_id: number; cnt: string }>;

    // Должно быть ровно 2 группы (alpha, beta), не больше и не меньше.
    expect(matrix).toHaveLength(2);
    const byTenant = new Map(matrix.map((r) => [Number(r.tenant_id), Number(r.cnt)]));
    expect(byTenant.get(tenantIds.alpha)).toBe(2);
    expect(byTenant.get(tenantIds.beta)).toBe(1);

    // Никаких rows с tenant_id = 0 или NULL.
    const stragglers = (await sql`
      SELECT COUNT(*)::text as cnt FROM messages WHERE tenant_id IS NULL
    `) as unknown as Array<{ cnt: string }>;
    expect(stragglers[0]?.cnt).toBe("0");
  });
});
