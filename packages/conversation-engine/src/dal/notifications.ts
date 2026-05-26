import { eq, and, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { notificationRules, operatorSettings, notificationTemplates, type notificationRules as nrTable, type operatorSettings as osTable, type notificationTemplates as ntTable } from "@chatman-media/storage";

export type NotificationRule = typeof nrTable.$inferSelect;
export type OperatorSettings = typeof osTable.$inferSelect;
export type NotificationTemplate = typeof ntTable.$inferSelect;

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
}
