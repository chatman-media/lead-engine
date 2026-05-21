import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { contacts, conversations, messages } from "@chatman-media/storage";
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Per-tenant read-only conversations API под /api/admin/conversations/*.
 *
 * Endpoints:
 *   GET /api/admin/conversations            — list (paginated by createdAt DESC)
 *   GET /api/admin/conversations/:id        — single conversation + last N messages
 *
 * Возвращает только данные текущего tenant'а (withTenant + RLS). PII не
 * редактируется на этом этапе — admin видит всё что в БД. Pagination —
 * cursor по lastMessageAt (keyset, не offset, чтобы не дрейфил при insert'е).
 */
export interface AdminConversationsRoutesOpts {
  db: Db;
}

export function makeAdminConversationsRoutes(
  opts: AdminConversationsRoutesOpts,
): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/conversations
   * Query: ?limit=N (default 30, max 100), ?cursor=<epoch> (lastMessageAt before)
   *
   * Returns: {
   *   items: [{ id, contactId, contactName?, source, mode, currentStage?,
   *             lastMessageAt, createdAt, lastMessagePreview? }],
   *   nextCursor?: number
   * }
   */
  app.get("/api/admin/conversations", async (c) => {
    const tenantId = c.var.tenantId;
    const limitParam = Number.parseInt(c.req.query("limit") ?? "30", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 30, 1), 100);
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw ? Number.parseInt(cursorRaw, 10) : null;

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const baseQuery = tx
        .select({
          id: conversations.id,
          contactId: conversations.userId,
          contactName: contacts.displayName,
          source: conversations.source,
          mode: conversations.mode,
          currentStage: conversations.currentStage,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.userId))
        .where(
          cursor !== null && Number.isFinite(cursor)
            ? and(
                eq(conversations.tenantId, tenantId),
                lt(conversations.lastMessageAt, cursor),
              )
            : eq(conversations.tenantId, tenantId),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit + 1);
      return await baseQuery;
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && items.length > 0
        ? items[items.length - 1]?.lastMessageAt ?? null
        : null;

    return c.json({
      items: items.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contactName,
        source: r.source,
        mode: r.mode,
        currentStage: r.currentStage,
        lastMessageAt: r.lastMessageAt,
        createdAt: r.createdAt,
      })),
      ...(nextCursor !== null ? { nextCursor } : {}),
    });
  });

  /**
   * GET /api/admin/conversations/:id
   * Returns: {
   *   conversation: { id, contactId, contactName?, source, mode, ... },
   *   messages: [{ id, role, text, createdAt, stage?, deletedAt? }]
   * }
   *
   * Возвращает последние 200 сообщений (DESC limit, потом client reverse'нет
   * для chat-render'а). Soft-deleted messages включены (UI рендерит strike).
   */
  app.get("/api/admin/conversations/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const idStr = c.req.param("id");
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select({
          id: conversations.id,
          contactId: conversations.userId,
          contactName: contacts.displayName,
          source: conversations.source,
          mode: conversations.mode,
          currentStage: conversations.currentStage,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
          escalatedAt: conversations.escalatedAt,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.userId))
        .where(
          and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)),
        );
      if (!conv) return null;

      // Note: deletedAt НЕ фильтруется — admin видит soft-deleted сообщения
      // тоже (UI render'ит strikethrough).
      const msgs = await tx
        .select({
          id: messages.id,
          role: messages.role,
          text: messages.text,
          createdAt: messages.createdAt,
          stage: messages.stage,
          deletedAt: messages.deletedAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, tenantId),
            eq(messages.conversationId, id),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(200);

      return { conversation: conv, messages: msgs };
    });

    if (!result) return c.json({ error: "conversation not found" }, 404);
    // Reverse так чтобы client получил chronological order (oldest first).
    return c.json({
      conversation: result.conversation,
      messages: [...result.messages].reverse(),
    });
  });

  return app;
}
