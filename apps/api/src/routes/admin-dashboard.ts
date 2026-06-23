import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { conversations, leads, messages, stageDefinitions } from "@chatman-media/storage";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { loadPrimaryActiveFunnel } from "../lib/primary-funnel.ts";

/**
 * GET /api/admin/dashboard
 * Агрегированная статистика для дашборда:
 * - Лиды по стадиям
 * - Диалоги (открытые / эскалированные / сегодня)
 * - Сообщения за 7 дней
 */
export interface AdminDashboardRoutesOpts {
  db: Db;
}

export function makeAdminDashboardRoutes(opts: AdminDashboardRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/admin/dashboard", async (c) => {
    const tenantId = c.var.tenantId;
    const now = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400); // UTC midnight
    const sevenDaysAgo = now - 7 * 86400;

    const data = await withTenant(opts.db, tenantId, async (tx) => {
      const primaryFunnel = await loadPrimaryActiveFunnel(tx, tenantId);
      // Лиды по стадиям
      const byStage = await tx
        .select({
          id: stageDefinitions.id,
          slug: stageDefinitions.slug,
          displayName: stageDefinitions.displayName,
          kind: stageDefinitions.kind,
          color: stageDefinitions.color,
          position: stageDefinitions.position,
          count: count(leads.id),
        })
        .from(stageDefinitions)
        .leftJoin(
          leads,
          and(eq(leads.stageDefinitionId, stageDefinitions.id), eq(leads.tenantId, tenantId)),
        )
        .where(
          primaryFunnel
            ? and(
                eq(stageDefinitions.tenantId, tenantId),
                eq(stageDefinitions.funnelId, primaryFunnel.id),
              )
            : eq(stageDefinitions.tenantId, tenantId),
        )
        .groupBy(
          stageDefinitions.id,
          stageDefinitions.slug,
          stageDefinitions.displayName,
          stageDefinitions.kind,
          stageDefinitions.color,
          stageDefinitions.position,
        )
        .orderBy(stageDefinitions.position);

      const primaryStageIds = byStage.map((s) => s.id);
      const [leadsTotal] = await tx
        .select({ total: count(leads.id) })
        .from(leads)
        .where(
          primaryStageIds.length > 0
            ? and(eq(leads.tenantId, tenantId), inArray(leads.stageDefinitionId, primaryStageIds))
            : eq(leads.tenantId, tenantId),
        );

      // Диалоги
      const [convOpen] = await tx
        .select({ n: count(conversations.id) })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.mode, "ai")));

      const [convEscalated] = await tx
        .select({ n: count(conversations.id) })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.mode, "human")));

      const [convToday] = await tx
        .select({ n: count(conversations.id) })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), gte(conversations.createdAt, todayStart)));

      const [convUnread] = await tx
        .select({ n: sql<number>`COALESCE(SUM(${conversations.unreadCount}), 0)::int` })
        .from(conversations)
        .where(eq(conversations.tenantId, tenantId));

      // Сообщения от пользователей за 7 дней
      const [msgs7d] = await tx
        .select({ n: count(messages.id) })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, tenantId),
            eq(messages.role, "user"),
            gte(messages.createdAt, sevenDaysAgo),
            sql`${messages.deletedAt} IS NULL`,
          ),
        );

      return {
        leads: {
          total: leadsTotal?.total ?? 0,
          byStage: byStage.map((s) => ({
            slug: s.slug,
            displayName: s.displayName,
            kind: s.kind,
            color: s.color,
            position: s.position,
            count: s.count,
          })),
        },
        conversations: {
          open: convOpen?.n ?? 0,
          escalated: convEscalated?.n ?? 0,
          today: convToday?.n ?? 0,
          unread: convUnread?.n ?? 0,
        },
        messages: {
          last7days: msgs7d?.n ?? 0,
        },
      };
    });

    return c.json(data);
  });

  return app;
}
