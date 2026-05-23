import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  contacts,
  conversations,
  messages,
  outboundQueue,
} from "@chatman-media/storage";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

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
   *             lastMessageAt, createdAt, escalatedAt?, lastMessagePreview? }],
   *   nextCursor?: number
   * }
   */
  app.get("/api/admin/conversations", async (c) => {
    const tenantId = c.var.tenantId;
    const limitParam = Number.parseInt(c.req.query("limit") ?? "30", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 30, 1), 100);
    const cursorRaw = c.req.query("cursor");
    const cursor = cursorRaw ? Number.parseInt(cursorRaw, 10) : null;
    const contactIdRaw = c.req.query("contactId");
    const contactIdFilter = contactIdRaw ? Number.parseInt(contactIdRaw, 10) : null;

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      // Correlated subquery для last message preview: берём последний non-system
      // текст (role IN ('user','assistant','human')) — до 120 символов.
      // Выполняется один раз per-row (indexed by conversation_id + created_at DESC).
      const lastMsgPreview = sql<string | null>`(
        SELECT left(text, 120)
        FROM messages
        WHERE tenant_id = ${tenantId}
          AND conversation_id = conversations.id
          AND role IN ('user', 'assistant', 'human')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )`;

      return tx
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
          lastMessagePreview: lastMsgPreview,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.userId))
        .where(
          cursor !== null && Number.isFinite(cursor)
            ? and(
                eq(conversations.tenantId, tenantId),
                lt(conversations.lastMessageAt, cursor),
                ...(contactIdFilter !== null ? [eq(conversations.userId, contactIdFilter)] : []),
              )
            : contactIdFilter !== null
              ? and(eq(conversations.tenantId, tenantId), eq(conversations.userId, contactIdFilter))
              : eq(conversations.tenantId, tenantId),
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit + 1);
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
        ...(r.escalatedAt !== null ? { escalatedAt: r.escalatedAt } : {}),
        ...(r.lastMessagePreview !== null ? { lastMessagePreview: r.lastMessagePreview } : {}),
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

  /**
   * POST /api/admin/conversations/:id/reply
   * Body: { text }
   *
   * Operator takeover: вставляет message с role='human', enqueue'ит
   * outbound для отправки клиенту через channel-adapter (worker pickup),
   * выставляет conversation.mode='human' (AI больше не отвечает).
   *
   * Errors:
   *   400 — invalid id / empty text / no json
   *   404 — conversation не найден
   *   409 — нет channel_identity для этого contact'а (контакт пришёл из
   *         channel, который удалили; нечем доставить ответ)
   *
   * NB: для пилотов берём первый telegram_bot channel_identity. Multi-channel
   * routing (whatsapp/web) — отдельный PR.
   */
  app.post("/api/admin/conversations/:id/reply", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId;
    const idStr = c.req.param("id");
    const conversationId = Number.parseInt(idStr, 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    let body: { text?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);
    if (text.length > 4000) {
      return c.json({ error: "text too long (max 4000)" }, 400);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);

    const outcome = await withTenant(opts.db, tenantId, async (tx) => {
      // 1. Find conversation + contactId.
      const [conv] = await tx
        .select({
          id: conversations.id,
          contactId: conversations.userId,
        })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)),
        );
      if (!conv) return { kind: "not_found" } as const;

      // 2. Find first active telegram_bot channel_identity для этого contact'а.
      const [identity] = await tx
        .select({
          channelDbId: channels.id,
          channelKind: channels.kind,
          externalUserId: channelIdentities.externalUserId,
        })
        .from(channelIdentities)
        .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
        .where(
          and(
            eq(channelIdentities.contactId, conv.contactId),
            eq(channels.status, "active"),
          ),
        )
        .limit(1);
      if (!identity) return { kind: "no_channel" } as const;

      // 3. Insert message (role='human', adminId в meta для аудита).
      const [msg] = await tx
        .insert(messages)
        .values({
          tenantId,
          conversationId,
          role: "human",
          text,
          metaJson: JSON.stringify({ adminId, sentVia: "admin-reply" }),
          createdAt: nowEpoch,
        })
        .returning({ id: messages.id });

      // 4. Build OutboundEnvelope JSON и enqueue.
      const envelope = {
        channelId: String(identity.channelDbId),
        externalUserId: identity.externalUserId,
        parts: [{ kind: "text", text }],
      };
      // idempotencyKey производный от message.id (auto-increment serial),
      // поэтому коллизий не будет — onConflict не нужен (partial unique
      // index требует WHERE clause, drizzle target column'у этого не даёт).
      const idempotencyKey = `admin-reply-${msg!.id}`;
      await tx.insert(outboundQueue).values({
        tenantId,
        channelId: identity.channelDbId,
        conversationId,
        payloadJson: JSON.stringify(envelope),
        idempotencyKey,
        scheduledAt: nowEpoch,
        createdAt: nowEpoch,
      });

      // 5. Conversation mode → human, lastMessageAt → now.
      await tx
        .update(conversations)
        .set({ mode: "human", lastMessageAt: nowEpoch })
        .where(eq(conversations.id, conversationId));

      return {
        kind: "sent",
        messageId: msg!.id,
        channelKind: identity.channelKind,
      } as const;
    });

    if (outcome.kind === "not_found") {
      return c.json({ error: "conversation not found" }, 404);
    }
    if (outcome.kind === "no_channel") {
      return c.json(
        { error: "no active channel for this contact — cannot deliver" },
        409,
      );
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "conversation.reply",
      targetKind: "conversation",
      targetId: conversationId,
      details: {
        messageId: outcome.messageId,
        channelKind: outcome.channelKind,
        textLength: text.length,
      },
    });

    return c.json({
      ok: true,
      messageId: outcome.messageId,
      channelKind: outcome.channelKind,
    });
  });

  /**
   * PUT /api/admin/conversations/:id/mode
   * Body: { mode: 'ai' | 'human' }
   *
   * Operator toggle:
   *  - mode='human' — AI замолкает (pipeline в processInbound уже respect'ит
   *    conversation.mode === 'ai' для запуска reply.generate).
   *  - mode='ai'   — вернуть управление AI после operator takeover.
   *
   * 400 если mode не валидный, 404 если conversation не найден или
   * принадлежит другому tenant'у (RLS).
   */
  app.put("/api/admin/conversations/:id/mode", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId;
    const idStr = c.req.param("id");
    const conversationId = Number.parseInt(idStr, 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    let body: { mode?: unknown };
    try {
      body = (await c.req.json()) as { mode?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (body.mode !== "ai" && body.mode !== "human") {
      return c.json({ error: "mode must be 'ai' or 'human'" }, 400);
    }
    const newMode = body.mode;
    const nowEpoch = Math.floor(Date.now() / 1000);

    const outcome = await withTenant(opts.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select({ mode: conversations.mode })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)),
        );
      if (!existing) return { kind: "not_found" } as const;
      if (existing.mode === newMode) {
        return { kind: "noop", mode: newMode } as const;
      }
      await tx
        .update(conversations)
        .set({ mode: newMode, lastMessageAt: nowEpoch })
        .where(eq(conversations.id, conversationId));
      return { kind: "changed", from: existing.mode, to: newMode } as const;
    });

    if (outcome.kind === "not_found") {
      return c.json({ error: "conversation not found" }, 404);
    }

    if (outcome.kind === "changed") {
      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: newMode === "human" ? "conversation.mode.takeover" : "conversation.mode.return_to_ai",
        targetKind: "conversation",
        targetId: conversationId,
        details: { from: outcome.from, to: outcome.to },
      });
    }

    return c.json({ ok: true, mode: newMode });
  });

  return app;
}
