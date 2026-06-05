import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { admins, adminNotifications, notificationRules, operatorSettings, notificationTemplates, notificationGroupTokens, type adminNotifications as anTable, type notificationRules as nrTable, type operatorSettings as osTable, type notificationTemplates as ntTable } from "@chatman-media/storage";

export type NotificationRule = typeof nrTable.$inferSelect;
export type OperatorSettings = typeof osTable.$inferSelect;
export type NotificationTemplate = typeof ntTable.$inferSelect;
export type AdminNotificationRow = typeof anTable.$inferSelect;
export type NewAdminNotification = typeof anTable.$inferInsert;

/** Частичный апдейт informer-настроек владельца (см. миграцию 0032). */
export type InformerPrefs = Partial<
  Pick<
    OperatorSettings,
    | "informerLevel"
    | "informerTopics"
    | "informerDigest"
    | "informerDigestHour"
    | "informerTz"
    | "informerMutedUntil"
    | "informerLastDigestAt"
  >
>;

/** Владелец тенанта (superadmin) + его operator_settings. */
export interface OwnerSettings {
  adminId: number;
  email: string;
  settings: OperatorSettings | undefined;
}

export class NotificationsRepo {
  constructor(private readonly db: PostgresJsDatabase) {}

  async findRulesByEvent(tenantId: number, eventType: string): Promise<NotificationRule[]> {
    return this.db
      .select()
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.tenantId, tenantId),
          eq(notificationRules.eventType, eventType),
          eq(notificationRules.isActive, true)
        )
      );
  }

  async findOperatorSettings(adminId: number): Promise<OperatorSettings | undefined> {
    const rows = await this.db
      .select()
      .from(operatorSettings)
      .where(eq(operatorSettings.adminId, adminId))
      .limit(1);
    return rows[0];
  }

  async findByLinkToken(token: string): Promise<OperatorSettings | undefined> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .select()
      .from(operatorSettings)
      .where(
        and(
          eq(operatorSettings.linkToken, token),
          sql`${operatorSettings.linkTokenExpiresAt} > ${now}`
        )
      )
      .limit(1);
    return rows[0];
  }

  async generateLinkToken(adminId: number, tenantId: number): Promise<string> {
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour

    await this.db
      .insert(operatorSettings)
      .values({
        adminId,
        tenantId,
        linkToken: token,
        linkTokenExpiresAt: expiresAt,
      })
      .onConflictDoUpdate({
        target: [operatorSettings.adminId],
        set: {
          linkToken: token,
          linkTokenExpiresAt: expiresAt,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      });
    
    return token;
  }

  async linkChat(adminId: number, telegramChatId: string): Promise<void> {
    await this.db
      .update(operatorSettings)
      .set({
        telegramChatId,
        linkToken: null,
        linkTokenExpiresAt: null,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(operatorSettings.adminId, adminId));
  }

  async findOperatorSettingsByTenant(tenantId: number): Promise<OperatorSettings[]> {
    return this.db
      .select()
      .from(operatorSettings)
      .where(eq(operatorSettings.tenantId, tenantId));
  }

  async partialUpdateSettings(
    adminId: number,
    tenantId: number,
    fields: Partial<Pick<OperatorSettings, "telegramChatId" | "notifyOnAssignedOnly">>,
  ): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await this.db
      .insert(operatorSettings)
      .values({ adminId, tenantId, ...fields })
      .onConflictDoUpdate({
        target: [operatorSettings.adminId],
        set: { ...fields, updatedAt: Math.floor(Date.now() / 1000) },
      });
  }

  async upsertOperatorSettings(settings: Omit<OperatorSettings, "id" | "updatedAt">): Promise<void> {
    await this.db
      .insert(operatorSettings)
      .values(settings)
      .onConflictDoUpdate({
        target: [operatorSettings.adminId],
        set: {
          telegramChatId: settings.telegramChatId,
          notifyOnAssignedOnly: settings.notifyOnAssignedOnly,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      });
  }

  async createRule(rule: Omit<NotificationRule, "id" | "createdAt" | "updatedAt">): Promise<NotificationRule> {
    const [inserted] = await this.db
      .insert(notificationRules)
      .values(rule)
      .returning();
    if (!inserted) throw new Error("notification rule insert returned no row");
    return inserted;
  }

  async listRules(tenantId: number): Promise<NotificationRule[]> {
    return this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.tenantId, tenantId));
  }

  async deleteRule(tenantId: number, id: number): Promise<void> {
    await this.db
      .delete(notificationRules)
      .where(and(eq(notificationRules.tenantId, tenantId), eq(notificationRules.id, id)));
  }

  // ---- Templates ----

  async findTemplate(tenantId: number, slug: string): Promise<NotificationTemplate | undefined> {
    const rows = await this.db
      .select()
      .from(notificationTemplates)
      .where(and(eq(notificationTemplates.tenantId, tenantId), eq(notificationTemplates.slug, slug)))
      .limit(1);
    return rows[0];
  }

  async upsertTemplate(tpl: Omit<NotificationTemplate, "id" | "updatedAt">): Promise<void> {
    await this.db
      .insert(notificationTemplates)
      .values(tpl)
      .onConflictDoUpdate({
        target: [notificationTemplates.tenantId, notificationTemplates.slug],
        set: {
          body: tpl.body,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      });
  }

  async listTemplates(tenantId: number): Promise<NotificationTemplate[]> {
    return this.db
      .select()
      .from(notificationTemplates)
      .where(eq(notificationTemplates.tenantId, tenantId));
  }

  async deleteTemplate(tenantId: number, slug: string): Promise<void> {
    await this.db
      .delete(notificationTemplates)
      .where(and(eq(notificationTemplates.tenantId, tenantId), eq(notificationTemplates.slug, slug)));
  }

  async generateGroupLinkToken(tenantId: number, adminId: number, eventType: string): Promise<string> {
    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await this.db.insert(notificationGroupTokens).values({
      token,
      tenantId,
      adminId,
      eventType,
      expiresAt,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return token;
  }

  async findGroupLinkToken(token: string): Promise<{ tenantId: number; adminId: number; eventType: string } | undefined> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .select()
      .from(notificationGroupTokens)
      .where(and(eq(notificationGroupTokens.token, token), sql`${notificationGroupTokens.expiresAt} > ${now}`))
      .limit(1);
    return rows[0];
  }

  async deleteGroupLinkToken(token: string): Promise<void> {
    await this.db.delete(notificationGroupTokens).where(eq(notificationGroupTokens.token, token));
  }

  // ── Informer: владелец + настройки ────────────────────────────────────

  /**
   * Владелец тенанта (superadmin) + его operator_settings. admins под RLS —
   * звать ВНУТРИ withTenant(tenantId), иначе вернёт 0 строк.
   */
  async resolveOwnerSettings(tenantId: number): Promise<OwnerSettings | null> {
    const [owner] = await this.db
      .select({ adminId: admins.id, email: admins.email })
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.role, "superadmin")))
      .orderBy(admins.id)
      .limit(1);
    if (!owner) return null;
    const settings = await this.findOperatorSettings(owner.adminId);
    return { adminId: owner.adminId, email: owner.email, settings };
  }

  /** Резолв operator_settings по личному Telegram chat_id (для бот-команд). */
  async findOperatorSettingsByChatId(chatId: string): Promise<OperatorSettings | undefined> {
    const rows = await this.db
      .select()
      .from(operatorSettings)
      .where(eq(operatorSettings.telegramChatId, chatId))
      .limit(1);
    return rows[0];
  }

  /**
   * Частичное обновление informer-настроек владельца по adminId. С tenantId —
   * upsert (создаёт строку, если её ещё нет — путь из UI до привязки Telegram);
   * без tenantId — plain update (путь из бота, где строка уже есть).
   */
  async updateInformerPrefs(
    adminId: number,
    prefs: InformerPrefs,
    tenantId?: number,
  ): Promise<void> {
    if (Object.keys(prefs).length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    if (tenantId !== undefined) {
      await this.db
        .insert(operatorSettings)
        .values({ adminId, tenantId, ...prefs })
        .onConflictDoUpdate({
          target: [operatorSettings.adminId],
          set: { ...prefs, updatedAt: now },
        });
      return;
    }
    await this.db
      .update(operatorSettings)
      .set({ ...prefs, updatedAt: now })
      .where(eq(operatorSettings.adminId, adminId));
  }

  // ── Informer: лента (admin_notifications) ─────────────────────────────

  /** Пишет строку ленты, возвращает id. */
  async insertAdminNotification(row: NewAdminNotification): Promise<number> {
    const [ins] = await this.db
      .insert(adminNotifications)
      .values(row)
      .returning({ id: adminNotifications.id });
    if (!ins) throw new Error("admin_notifications insert returned no row");
    return ins.id;
  }

  /** Помечает строку доставленной в реалтайме (исключает из дайджеста). */
  async markNotificationDelivered(id: number, deliveredAt: number): Promise<void> {
    await this.db
      .update(adminNotifications)
      .set({ deliveredAt })
      .where(eq(adminNotifications.id, id));
  }

  /**
   * Последняя строка по (tenant, dedupKey) не старше sinceEpoch — persisted-дедуп
   * (переживает рестарт процесса, в отличие от in-memory cooldown).
   */
  async findRecentByDedup(
    tenantId: number,
    dedupKey: string,
    sinceEpoch: number,
  ): Promise<AdminNotificationRow | undefined> {
    const rows = await this.db
      .select()
      .from(adminNotifications)
      .where(
        and(
          eq(adminNotifications.tenantId, tenantId),
          eq(adminNotifications.dedupKey, dedupKey),
          gte(adminNotifications.createdAt, sinceEpoch),
        ),
      )
      .orderBy(desc(adminNotifications.createdAt))
      .limit(1);
    return rows[0];
  }

  /** Последние N уведомлений владельца — для «/last». */
  async listRecentNotifications(
    tenantId: number,
    adminId: number,
    limit = 10,
  ): Promise<AdminNotificationRow[]> {
    return this.db
      .select()
      .from(adminNotifications)
      .where(
        and(eq(adminNotifications.tenantId, tenantId), eq(adminNotifications.adminId, adminId)),
      )
      .orderBy(desc(adminNotifications.createdAt))
      .limit(limit);
  }

  /** Очередь дайджеста: принято, в реалтайм не доставлено, ещё не сведено. */
  async listPendingDigest(tenantId: number, adminId: number): Promise<AdminNotificationRow[]> {
    return this.db
      .select()
      .from(adminNotifications)
      .where(
        and(
          eq(adminNotifications.tenantId, tenantId),
          eq(adminNotifications.adminId, adminId),
          isNull(adminNotifications.deliveredAt),
          isNull(adminNotifications.digestBatchId),
        ),
      )
      .orderBy(adminNotifications.createdAt);
  }

  /** Помечает строки вошедшими в батч дайджеста. */
  async markDigested(ids: number[], batchId: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(adminNotifications)
      .set({ digestBatchId: batchId })
      .where(inArray(adminNotifications.id, ids));
  }
}
