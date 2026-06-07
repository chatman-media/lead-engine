// Интеграционный тест кампаний капельной рассылки + drip-диспетчера.
// Реальная БД. Проверяет: создание/активацию кампании, выдачу приветствия в
// outbound_queue по скорости, подстановку {name}, и C5 (telegram-бот не пишет
// холодным контактам — лид skipped без существующей беседы).

import { withTenant } from "@chatman-media/conversation-engine";
import {
  applyAllMigrations,
  channelIdentities,
  channels,
  contacts,
  conversations,
  createIsolatedDb,
  leads,
  outboundQueue,
  outreachCampaignLeads,
  outreachCampaigns,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { dripDispatchTick } from "../lib/drip-dispatcher.ts";
import { makeRequireAuth } from "../middleware/require-auth.ts";
import { makeAdminOutreachCampaignsRoutes } from "./admin-outreach-campaigns.ts";
import { makeAuthRoutes } from "./auth.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_camp_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "storage", "migrations");
const SECRET = "test-secret-camp-12345";

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let app: Hono;
let token = "";
let tenantId = 0;
let botChannelId = 0;

async function makeLead(opts: {
  name: string;
  withIdentity: boolean;
  withConversation: boolean;
}): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  return withTenant(db, tenantId, async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ tenantId, displayName: opts.name, createdAt: now, updatedAt: now })
      .returning({ id: contacts.id });
    const contactId = contact!.id;
    if (opts.withIdentity) {
      await tx.insert(channelIdentities).values({
        contactId,
        channelId: botChannelId,
        externalUserId: `tg-${opts.name}-${now}`,
        createdAt: now,
      });
    }
    if (opts.withConversation) {
      await tx.insert(conversations).values({
        tenantId,
        userId: contactId,
        source: "bot",
        mode: "ai",
        createdAt: now,
        lastMessageAt: now,
      });
    }
    const [lead] = await tx
      .insert(leads)
      .values({ tenantId, userId: contactId, state: "new", createdAt: now, updatedAt: now })
      .returning({ id: leads.id });
    return lead!.id;
  });
}

async function authReq(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
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

  app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: drizzle generic
  app.route("/", makeAuthRoutes({ db: db as any, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db: db as never, secret: SECRET }));
  app.route("/", makeAdminOutreachCampaignsRoutes({ db }));

  const sa = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "camp@demo.io", password: "strong-pwd-12345" }),
  });
  const sba = (await sa.json()) as { token: string; admin: { tenantId: number } };
  token = sba.token;
  tenantId = sba.admin.tenantId;

  const now = Math.floor(Date.now() / 1000);
  botChannelId = await withTenant(db, tenantId, async (tx) => {
    const [ch] = await tx
      .insert(channels)
      .values({ tenantId, kind: "telegram_bot", externalId: "@campbot", status: "active", createdAt: now, updatedAt: now })
      .returning({ id: channels.id });
    return ch!.id;
  });
}, 30_000);

afterAll(async () => {
  if (sql) {
    await sql.end({ timeout: 0 }).catch(() => {});
    sql = null;
  }
}, 10_000);

describe("outreach campaigns + drip", () => {
  it("validates required fields", async () => {
    if (!sql) return;
    expect((await authReq("/api/admin/outreach-campaigns", { method: "POST", body: "{}" })).status).toBe(400);
    const noGreet = await authReq("/api/admin/outreach-campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "X" }),
    });
    expect(noGreet.status).toBe(400);
  });

  it("drips greeting to reachable lead, skips cold telegram contact (C5)", async () => {
    if (!sql) return;
    // warm: контакт писал боту (есть беседа) — охватываем.
    const warmLead = await makeLead({ name: "Иван", withIdentity: true, withConversation: true });
    // cold: telegram-бот, но контакт не писал первым — skipped.
    const coldLead = await makeLead({ name: "Пётр", withIdentity: true, withConversation: false });
    // no-channel: нет identity вовсе — skipped.
    const noChanLead = await makeLead({ name: "Без канала", withIdentity: false, withConversation: false });

    const created = await authReq("/api/admin/outreach-campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: "Привет-кампания",
        greetingText: "Здравствуйте, {name}! Есть выгодное предложение.",
        dripPerTick: 10,
        dripIntervalSec: 0,
        leadIds: [warmLead, coldLead, noChanLead],
      }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: number; leadsAdded: number };

    // Активируем и прогоняем тик.
    await authReq(`/api/admin/outreach-campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    await dripDispatchTick(db, { nowSec: Math.floor(Date.now() / 1000) });

    // warm-лид: enqueued + сообщение с подставленным именем в очереди.
    const cl = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ leadId: outreachCampaignLeads.leadId, status: outreachCampaignLeads.status })
        .from(outreachCampaignLeads)
        .where(eq(outreachCampaignLeads.campaignId, id)),
    );
    const byLead = new Map(cl.map((r) => [r.leadId, r.status]));
    expect(byLead.get(warmLead)).toBe("enqueued");
    expect(byLead.get(coldLead)).toBe("skipped");
    expect(byLead.get(noChanLead)).toBe("skipped");

    const ob = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ payloadJson: outboundQueue.payloadJson, idk: outboundQueue.idempotencyKey })
        .from(outboundQueue)
        .where(eq(outboundQueue.tenantId, tenantId)),
    );
    expect(ob.length).toBe(1);
    expect(ob[0]!.payloadJson).toContain("Здравствуйте, Иван!");
    expect(String(ob[0]!.idk)).toContain(`campaign-${id}-`);
  });

  it("completes campaign when no pending leads remain", async () => {
    if (!sql) return;
    const created = await authReq("/api/admin/outreach-campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "Пустая", greetingText: "Привет" }),
    });
    const { id } = (await created.json()) as { id: number };
    await authReq(`/api/admin/outreach-campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    await dripDispatchTick(db, { nowSec: Math.floor(Date.now() / 1000) });
    const [row] = await withTenant(db, tenantId, (tx) =>
      tx
        .select({ status: outreachCampaigns.status })
        .from(outreachCampaigns)
        .where(and(eq(outreachCampaigns.tenantId, tenantId), eq(outreachCampaigns.id, id)))
        .limit(1),
    );
    expect(row!.status).toBe("completed");
  });
});
