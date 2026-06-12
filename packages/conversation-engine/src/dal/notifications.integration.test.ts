/**
 * NotificationsRepo: правила, шаблоны, operator_settings (+informer prefs),
 * group-tokens, лента admin_notifications, resolveOwnerSettings. Требует
 * DATABASE_URL; без него — graceful-skip.
 */
import {
  admins,
  applyAllMigrations,
  auditLog,
  contacts,
  conversations,
  createIsolatedDb,
  operatorSettings,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { NotificationsRepo } from "./notifications.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_notif_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let repo: NotificationsRepo;
let tenantId = 0;
let otherTenantId = 0;
let adminId = 0;
let admin2 = 0;
let conversationId = 0;
let otherConversationId = 0;
let enabled = false;

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  repo = new NotificationsRepo(db as never);
  enabled = true;
  const now = Math.floor(Date.now() / 1000);
  const [t] = await db.insert(schema.tenants).values({ slug: `notif-${now}` }).returning({ id: schema.tenants.id });
  tenantId = t!.id;
  const [otherTenant] = await db
    .insert(schema.tenants)
    .values({ slug: `notif-other-${now}` })
    .returning({ id: schema.tenants.id });
  otherTenantId = otherTenant!.id;
  const [a] = await db
    .insert(admins)
    .values({ tenantId, email: `owner-${now}@t.io`, passwordHash: "x", role: "superadmin" })
    .returning({ id: admins.id });
  adminId = a!.id;
  const [a2] = await db
    .insert(admins)
    .values({ tenantId, email: `mgr-${now}@t.io`, passwordHash: "x", role: "manager" })
    .returning({ id: admins.id });
  admin2 = a2!.id;
  const [contact] = await db
    .insert(contacts)
    .values({ tenantId, displayName: "Operator Bot Fixture" })
    .returning({ id: contacts.id });
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, userId: contact!.id, source: "bot", mode: "ai", lastMessageAt: now })
    .returning({ id: conversations.id });
  conversationId = conversation!.id;

  const [otherContact] = await db
    .insert(contacts)
    .values({ tenantId: otherTenantId, displayName: "Other Tenant" })
    .returning({ id: contacts.id });
  const [otherConversation] = await db
    .insert(conversations)
    .values({
      tenantId: otherTenantId,
      userId: otherContact!.id,
      source: "bot",
      mode: "ai",
      lastMessageAt: now,
    })
    .returning({ id: conversations.id });
  otherConversationId = otherConversation!.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("NotificationsRepo: rules", () => {
  it("createRule + findRulesByEvent (только активные) + listRules + deleteRule", async () => {
    if (!enabled) return;
    const active = await repo.createRule({
      tenantId, eventType: "stage_changed", conditionJson: "{}",
      channelType: "telegram_group", targetId: "g1", priority: "normal", isActive: true,
    });
    await repo.createRule({
      tenantId, eventType: "stage_changed", conditionJson: "{}",
      channelType: "telegram_group", targetId: "g2", priority: "normal", isActive: false,
    });
    const byEvent = await repo.findRulesByEvent(tenantId, "stage_changed");
    expect(byEvent.map((r) => r.targetId)).toEqual(["g1"]); // inactive отфильтрован
    expect((await repo.listRules(tenantId)).length).toBe(2);
    await repo.deleteRule(tenantId, active.id);
    expect((await repo.listRules(tenantId)).find((r) => r.id === active.id)).toBeUndefined();
  });
});

describe("NotificationsRepo: templates", () => {
  it("upsert (insert→update) + find + list + delete", async () => {
    if (!enabled) return;
    await repo.upsertTemplate({ tenantId, slug: "stage_changed", body: "v1" });
    expect((await repo.findTemplate(tenantId, "stage_changed"))?.body).toBe("v1");
    await repo.upsertTemplate({ tenantId, slug: "stage_changed", body: "v2" }); // конфликт → update
    expect((await repo.findTemplate(tenantId, "stage_changed"))?.body).toBe("v2");
    expect((await repo.listTemplates(tenantId)).length).toBe(1);
    await repo.deleteTemplate(tenantId, "stage_changed");
    expect(await repo.findTemplate(tenantId, "stage_changed")).toBeUndefined();
  });
});

describe("NotificationsRepo: operator settings", () => {
  it("generateLinkToken → findByLinkToken (валидный / истёкший)", async () => {
    if (!enabled) return;
    const token = await repo.generateLinkToken(adminId, tenantId);
    expect((await repo.findByLinkToken(token))?.adminId).toBe(adminId);
    // истёкший токен не находится
    await db
      .update(operatorSettings)
      .set({ linkTokenExpiresAt: Math.floor(Date.now() / 1000) - 10 })
      .where(eq(operatorSettings.adminId, adminId));
    expect(await repo.findByLinkToken(token)).toBeUndefined();
  });

  it("linkChat проставляет chatId и чистит токен; резолв по adminId/chatId/tenant", async () => {
    if (!enabled) return;
    await repo.linkChat(adminId, "chat-777");
    const s = await repo.findOperatorSettings(adminId);
    expect(s?.telegramChatId).toBe("chat-777");
    expect(s?.linkToken).toBeNull();
    expect((await repo.findOperatorSettingsByChatId("chat-777"))?.adminId).toBe(adminId);
    expect((await repo.findOperatorSettingsByTenant(tenantId)).some((x) => x.adminId === adminId)).toBe(true);
  });

  it("partialUpdateSettings и updateInformerPrefs (plain + upsert)", async () => {
    if (!enabled) return;
    await repo.partialUpdateSettings(adminId, tenantId, { notifyOnAssignedOnly: false });
    expect((await repo.findOperatorSettings(adminId))?.notifyOnAssignedOnly).toBe(false);
    await repo.updateInformerPrefs(adminId, { informerLevel: "all" });
    expect((await repo.findOperatorSettings(adminId))?.informerLevel).toBe("all");
    // upsert: у admin2 строки ещё нет — tenantId создаёт её
    await repo.updateInformerPrefs(admin2, { informerDigest: "off" }, tenantId);
    expect((await repo.findOperatorSettings(admin2))?.informerDigest).toBe("off");
  });

  it("upsertOperatorSettings обновляет chatId/флаг по конфликту adminId", async () => {
    if (!enabled) return;
    await repo.upsertOperatorSettings({
      adminId: admin2, tenantId, telegramChatId: "chat-upsert", notifyOnAssignedOnly: true,
      linkToken: null, linkTokenExpiresAt: null,
      informerLevel: "important", informerTopics: null, informerDigest: "daily",
      informerDigestHour: 9, informerTz: "UTC", informerMutedUntil: null, informerLastDigestAt: null, informerQuietFrom: null, informerQuietTo: null,
    });
    expect((await repo.findOperatorSettings(admin2))?.telegramChatId).toBe("chat-upsert");
  });
});

describe("NotificationsRepo: group tokens", () => {
  it("generate → find → delete", async () => {
    if (!enabled) return;
    const token = await repo.generateGroupLinkToken(tenantId, adminId, "high_value_deal");
    const found = await repo.findGroupLinkToken(token);
    expect(found).toMatchObject({ tenantId, adminId, eventType: "high_value_deal" });
    await repo.deleteGroupLinkToken(token);
    expect(await repo.findGroupLinkToken(token)).toBeUndefined();
  });
});

describe("NotificationsRepo: operator conversation mode actions", () => {
  it("takeover/return_ai are tenant-scoped, audited, and idempotent", async () => {
    if (!enabled) return;

    const takeover = await repo.applyOperatorConversationModeAction({
      tenantId,
      adminId,
      conversationId,
      action: "takeover",
    });
    expect(takeover).toMatchObject({ kind: "changed", from: "ai", to: "human" });
    const [afterTakeover] = await db
      .select({
        mode: conversations.mode,
        assignedAdminId: conversations.assignedAdminId,
        unreadCount: conversations.unreadCount,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(afterTakeover).toMatchObject({
      mode: "human",
      assignedAdminId: adminId,
      unreadCount: 0,
    });

    const repeated = await repo.applyOperatorConversationModeAction({
      tenantId,
      adminId,
      conversationId,
      action: "takeover",
    });
    expect(repeated).toEqual({ kind: "noop", mode: "human" });

    const crossTenant = await repo.applyOperatorConversationModeAction({
      tenantId,
      adminId,
      conversationId: otherConversationId,
      action: "takeover",
    });
    expect(crossTenant).toEqual({ kind: "not_found" });
    const [other] = await db
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(eq(conversations.id, otherConversationId));
    expect(other?.mode).toBe("ai");

    const returnAi = await repo.applyOperatorConversationModeAction({
      tenantId,
      adminId,
      conversationId,
      action: "return_ai",
    });
    expect(returnAi).toMatchObject({ kind: "changed", from: "human", to: "ai" });

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.targetKind, "conversation"),
          eq(auditLog.targetId, String(conversationId)),
        ),
      );
    expect(rows.map((row) => row.action).sort()).toEqual([
      "conversation.mode.return_to_ai",
      "conversation.mode.takeover",
    ]);
    expect(rows.every((row) => row.detailsJson?.includes('"source":"operator_bot"'))).toBe(true);
  });
});

describe("NotificationsRepo: ledger + resolveOwnerSettings", () => {
  it("insert → dedup → list → pending → delivered/digested", async () => {
    if (!enabled) return;
    const id = await repo.insertAdminNotification({
      tenantId, adminId, topic: "leads", severity: "info", kind: "stage_changed",
      title: "T", body: "", dedupKey: "led-1",
    });
    expect(id).toBeGreaterThan(0);
    const since = Math.floor(Date.now() / 1000) - 60;
    expect((await repo.findRecentByDedup(tenantId, "led-1", since))?.id).toBe(id);
    // окно в будущем → не находим
    expect(await repo.findRecentByDedup(tenantId, "led-1", Math.floor(Date.now() / 1000) + 60)).toBeUndefined();
    expect((await repo.listRecentNotifications(tenantId, adminId, 10)).some((r) => r.id === id)).toBe(true);
    expect((await repo.listPendingDigest(tenantId, adminId)).some((r) => r.id === id)).toBe(true);

    await repo.markNotificationDelivered(id, Math.floor(Date.now() / 1000));
    expect((await repo.listPendingDigest(tenantId, adminId)).some((r) => r.id === id)).toBe(false);

    const id2 = await repo.insertAdminNotification({
      tenantId, adminId, topic: "system", severity: "critical", kind: "channel_down",
      title: "down", body: "", dedupKey: "led-2",
    });
    await repo.markDigested([id2], 12345);
    expect((await repo.listPendingDigest(tenantId, adminId)).some((r) => r.id === id2)).toBe(false);

    const id3 = await repo.insertAdminNotification({
      tenantId, adminId, topic: "escalation", severity: "important", kind: "verification_requested",
      title: "kyc", body: "", dedupKey: "led-3",
    });
    expect((await repo.listPendingDigest(tenantId, adminId)).some((r) => r.id === id3)).toBe(true);
    await repo.markNotificationsRead(tenantId, adminId, Math.floor(Date.now() / 1000));
    expect((await repo.listPendingDigest(tenantId, adminId)).some((r) => r.id === id3)).toBe(false);
  });

  it("resolveOwnerSettings возвращает superadmin + его settings", async () => {
    if (!enabled) return;
    const owner = await repo.resolveOwnerSettings(tenantId);
    expect(owner?.adminId).toBe(adminId);
    expect(owner?.email).toContain("owner-");
    expect(owner?.settings?.telegramChatId).toBe("chat-777");
  });
});
