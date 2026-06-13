import { type Db, type NotificationService, withTenant } from "@chatman-media/conversation-engine";
import {
  adminNotifications,
  admins,
  channelIdentities,
  channels,
  contacts,
  conversations,
  leadEvents,
  leads,
  messages,
  outboundQueue,
} from "@chatman-media/storage";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { adminEventBus } from "../lib/admin-event-bus.ts";
import { advanceLead } from "../lib/advance-lead.ts";
import {
  buildBannedAttributes,
  buildUnbannedAttributes,
  contactBanState,
} from "../lib/contact-ban.ts";

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
  /** Для пинга оператору при входе лида в awaiting_operator-стадию. */
  notifications?: NotificationService | null;
  partnerPing?: { appUrl: string; operatorBotToken: string; callbackSecret: string } | null;
  /**
   * Скачать медиа клиента по mediaRef (для media-proxy: оператор видит
   * паспорт/видео прямо в инбоксе). Использует адаптер канала-владельца
   * file_id. null — канал не найден/медиа недоступно.
   */
  downloadMedia?: (ref: { channelId: string; externalRef: string }) => Promise<Response | null>;
}

const kycHandoffKinds = new Set(["verification_requested", "document_uploaded"]);

function hasKycMarker(row: { title: string; body: string }): boolean {
  const text = `${row.title}\n${row.body}`.toLowerCase();
  return text.includes("kyc") || text.includes("верификац");
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isResolvedKycHandoff(
  row: { kind: string; title: string; body: string; createdAt: number },
  contactAttributesJson: string | null,
): boolean {
  if (!kycHandoffKinds.has(row.kind)) {
    if (row.kind !== "operator_handoff_required" || !hasKycMarker(row)) {
      return false;
    }
  }

  const attrs = parseJsonObject(contactAttributesJson);
  const kyc = objectValue(attrs.exchangeKyc);
  const reviewedAt = numberValue(kyc.reviewedAt);
  if (reviewedAt !== null && reviewedAt >= row.createdAt) return true;

  return (
    kyc.verified === true ||
    attrs.isVerified === true ||
    kyc.status === "verified" ||
    attrs.verificationStatus === "verified" ||
    attrs.kycStatus === "verified"
  );
}

export function makeAdminConversationsRoutes(
  opts: AdminConversationsRoutesOpts,
): Hono {
  const app = new Hono();
  const operatorHandoffKinds = [
    "operator_handoff_required",
    "operator_confirm_needed",
    "human_takeover",
    "verification_requested",
    "document_uploaded",
  ] as const;

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
    const sourceFilter = c.req.query("source") || null;
    const modeFilter = c.req.query("mode") || null;
    const statusFilter = c.req.query("status") || null;
    const assigneeFilter = c.req.query("assigneeId") ? Number.parseInt(c.req.query("assigneeId")!, 10) : null;
    const escalatedOnly = c.req.query("escalated") === "1";
    const qFilter = c.req.query("q")?.trim() || null;
    const includeBanned = c.req.query("includeBanned") === "1" || contactIdFilter !== null;
    const dbLimit = includeBanned ? limit + 1 : Math.min(limit * 3 + 1, 300);

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const conditions = [
        eq(conversations.tenantId, tenantId),
        ...(cursor !== null && Number.isFinite(cursor) ? [lt(conversations.lastMessageAt, cursor)] : []),
        ...(contactIdFilter !== null ? [eq(conversations.userId, contactIdFilter)] : []),
        ...(sourceFilter ? [eq(conversations.source, sourceFilter)] : []),
        ...(modeFilter ? [eq(conversations.mode, modeFilter)] : []),
        ...(statusFilter ? [eq(conversations.status, statusFilter)] : []),
        ...(assigneeFilter !== null ? [eq(conversations.assignedAdminId, assigneeFilter)] : []),
        ...(escalatedOnly ? [isNotNull(conversations.escalatedAt)] : []),
        ...(qFilter ? [ilike(contacts.displayName, `%${qFilter}%`)] : []),
      ];

      return tx
        .select({
          id: conversations.id,
          contactId: conversations.userId,
          contactName: contacts.displayName,
          contactAttributesJson: contacts.attributesJson,
          source: conversations.source,
          mode: conversations.mode,
          status: conversations.status,
          unreadCount: conversations.unreadCount,
          assignedAdminId: conversations.assignedAdminId,
          currentStage: conversations.currentStage,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
          escalatedAt: conversations.escalatedAt,
          lastMessagePreview: conversations.lastMessageText,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.userId))
        .where(and(...conditions))
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(dbLimit);
    });

    const mapped = rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contactName: r.contactName,
      contactBan: contactBanState(r.contactAttributesJson),
      source: r.source,
      mode: r.mode,
      status: r.status,
      unreadCount: r.unreadCount,
      assignedAdminId: r.assignedAdminId,
      currentStage: r.currentStage,
      lastMessageAt: r.lastMessageAt,
      createdAt: r.createdAt,
      ...(r.escalatedAt !== null ? { escalatedAt: r.escalatedAt } : {}),
      ...(r.lastMessagePreview !== null ? { lastMessagePreview: r.lastMessagePreview } : {}),
    }));
    const visible = includeBanned ? mapped : mapped.filter((item) => !item.contactBan.banned);
    const items = visible.slice(0, limit);
    const hasMore =
      visible.length > limit ||
      (!includeBanned && rows.length === dbLimit) ||
      (includeBanned && rows.length > limit);
    const cursorSource =
      visible.length > limit
        ? items[items.length - 1]
        : !includeBanned && rows.length === dbLimit
          ? rows[rows.length - 1]
          : includeBanned && rows.length > limit
            ? items[items.length - 1]
            : null;
    const nextCursor = hasMore ? cursorSource?.lastMessageAt ?? null : null;

    return c.json({
      items,
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
      // Reset unread count when conversation is opened by admin.
      await tx
        .update(conversations)
        .set({ unreadCount: 0 })
        .where(
          and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)),
        );

      const [conv] = await tx
        .select({
          id: conversations.id,
          contactId: conversations.userId,
          contactName: contacts.displayName,
          contactAttributesJson: contacts.attributesJson,
          source: conversations.source,
          mode: conversations.mode,
          status: conversations.status,
          unreadCount: conversations.unreadCount,
          assignedAdminId: conversations.assignedAdminId,
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
          metaJson: messages.metaJson,
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
      conversation: {
        ...result.conversation,
        contactBan: contactBanState(result.conversation.contactAttributesJson),
      },
      messages: [...result.messages].reverse(),
    });
  });

  /**
   * GET /api/admin/conversations/:id/media?msgId=<id>&ref=<externalRef>
   * Media-proxy: качает файл клиента (паспорт/видео/документ) через адаптер
   * канала-владельца file_id и отдаёт байты — чтобы оператор видел медиа прямо
   * в инбоксе. Доступ скоупится по tenant + conversation + message (RLS), а ref
   * должен реально присутствовать в parts сообщения.
   */
  app.get("/api/admin/conversations/:id/media", async (c) => {
    const tenantId = c.var.tenantId;
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    const msgId = Number.parseInt(c.req.query("msgId") ?? "", 10);
    const ref = c.req.query("ref")?.trim();
    if (!Number.isFinite(conversationId) || !Number.isFinite(msgId) || !ref) {
      return c.json({ error: "bad request" }, 400);
    }
    if (!opts.downloadMedia) return c.json({ error: "media proxy disabled" }, 501);

    const row = await withTenant(opts.db, tenantId, async (tx) => {
      const [msg] = await tx
        .select({ metaJson: messages.metaJson })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(messages.id, msgId),
            eq(messages.conversationId, conversationId),
            eq(conversations.tenantId, tenantId),
          ),
        )
        .limit(1);
      return msg ?? null;
    });
    if (!row) return c.json({ error: "message not found" }, 404);

    // Ищем part с этим externalRef — заодно авторизация (ref должен принадлежать
    // именно этому сообщению текущего tenant'а, а не быть произвольным file_id).
    const meta = parseJsonObject(row.metaJson);
    const parts = Array.isArray(meta.parts) ? (meta.parts as unknown[]) : [];
    let channelId = "";
    let kind = "";
    for (const p of parts) {
      const part = objectValue(p);
      const mr = objectValue(part.mediaRef);
      if (typeof mr.externalRef === "string" && mr.externalRef === ref) {
        channelId =
          typeof mr.channelId === "string" ? mr.channelId : String(mr.channelId ?? "");
        kind = typeof part.kind === "string" ? part.kind : "";
        break;
      }
    }
    if (!channelId) return c.json({ error: "media ref not found in message" }, 404);

    let resp: Response | null = null;
    try {
      resp = await opts.downloadMedia({ channelId, externalRef: ref });
    } catch {
      resp = null;
    }
    if (!resp || !resp.ok) return c.json({ error: "media download failed" }, 502);

    const buf = await resp.arrayBuffer();
    const ct =
      resp.headers.get("content-type") ||
      (kind === "photo"
        ? "image/jpeg"
        : kind === "video" || kind === "video_note"
          ? "video/mp4"
          : kind === "voice"
            ? "audio/ogg"
            : "application/octet-stream");
    return c.body(buf, 200, {
      "Content-Type": ct,
      "Cache-Control": "private, max-age=300",
    });
  });

  app.get("/api/admin/conversations/:id/operator-handoffs", async (c) => {
    const tenantId = c.var.tenantId;
    const idStr = c.req.param("id");
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select({
          contactAttributesJson: contacts.attributesJson,
        })
        .from(conversations)
        .leftJoin(contacts, eq(contacts.id, conversations.userId))
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)))
        .limit(1);
      if (!conv) return [];

      const candidates = await tx
        .select({
          id: adminNotifications.id,
          kind: adminNotifications.kind,
          title: adminNotifications.title,
          body: adminNotifications.body,
          severity: adminNotifications.severity,
          deliveredAt: adminNotifications.deliveredAt,
          readAt: adminNotifications.readAt,
          createdAt: adminNotifications.createdAt,
        })
        .from(adminNotifications)
        .where(
          and(
            eq(adminNotifications.tenantId, tenantId),
            isNull(adminNotifications.readAt),
            inArray(
              adminNotifications.dedupKey,
              operatorHandoffKinds.map((kind) => `${kind}:${id}`),
            ),
          ),
        )
        .orderBy(desc(adminNotifications.createdAt), desc(adminNotifications.id))
        .limit(50);

      const resolvedIds = candidates
        .filter((row) => isResolvedKycHandoff(row, conv.contactAttributesJson))
        .map((row) => row.id);
      if (resolvedIds.length > 0) {
        await tx
          .update(adminNotifications)
          .set({ readAt: Math.floor(Date.now() / 1000) })
          .where(
            and(
              eq(adminNotifications.tenantId, tenantId),
              inArray(adminNotifications.id, resolvedIds),
              isNull(adminNotifications.readAt),
            ),
          );
      }

      const resolvedIdSet = new Set(resolvedIds);
      return candidates.filter((row) => !resolvedIdSet.has(row.id)).slice(0, 20);
    });

    return c.json({ items: rows });
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

      // 5. Conversation mode → human, lastMessageAt → now, set preview.
      await tx
        .update(conversations)
        .set({
          mode: "human",
          lastMessageAt: nowEpoch,
          lastMessageText: text.slice(0, 200),
          unreadCount: 0, // Оператор сам ответил — значит всё прочитано.
        })
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

    adminEventBus.emit({
      type: "new_message",
      tenantId,
      conversationId,
      contactId: 0,
      preview: text.slice(0, 180),
      role: "human",
    });

    return c.json({
      ok: true,
      messageId: outcome.messageId,
      channelKind: outcome.channelKind,
    });
  });

  /**
   * POST /api/admin/conversations/:id/advance
   * Body: { text?: string }
   *
   * Operator-in-the-loop: подтверждает текущую operator-стадию лида и двигает
   * его на следующую (next_stages[0]). Пишет сообщение в чат (role=assistant —
   * «бот» подтверждает шаг и ведёт дальше), НЕ глушит AI (mode остаётся 'ai').
   * Для real-канала сообщение уходит клиенту; для self_play — только в чат.
   * Так оператор проходит воронку по шагам прямо из диалога.
   */
  app.post("/api/admin/conversations/:id/advance", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    let body: { text?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown };
    } catch {
      body = {};
    }
    const note = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";

    const [conv] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ contactId: conversations.userId })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
        .limit(1),
    );
    if (!conv) return c.json({ error: "conversation not found" }, 404);

    const outcome = await advanceLead({
      db: opts.db,
      tenantId,
      ...(adminId !== undefined ? { adminId } : {}),
      ...(note ? { note } : {}),
      selector: { contactId: conv.contactId },
      notifications: opts.notifications ?? null,
      partnerPing: opts.partnerPing ?? null,
    });

    if (outcome.kind === "no_lead") {
      return c.json({ error: "no lead with funnel stage for this conversation" }, 409);
    }
    if (outcome.kind === "terminal") {
      return c.json({ error: "lead already at terminal stage", stage: outcome.stage }, 409);
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "conversation.advance",
      targetKind: "lead",
      targetId: outcome.leadId,
      details: { from: outcome.from, to: outcome.to },
    });
    adminEventBus.emit({
      type: "stage_changed",
      tenantId,
      leadId: outcome.leadId,
      toStage: outcome.to,
      toStageDisplayName: outcome.toDisplayName,
    });

    return c.json({
      ok: true,
      from: outcome.from,
      to: outcome.to,
      toDisplayName: outcome.toDisplayName,
      awaitingOperator: outcome.awaitingOperator,
      terminal: outcome.terminal,
    });
  });

  /**
   * Общий путь для бана/разбана из диалога: беседа → контакт → мутация
   * attributesJson, плюс best-effort событие в историю лида (если он есть),
   * чтобы запись о бане была консистентна с карточкой лида.
   */
  async function moderateConversationContact(
    tenantId: number,
    conversationId: number,
    adminId: number | undefined,
    now: number,
    mutate: (attributesJson: string | null) => {
      attributesJson: string;
      eventType: string;
      eventDetails: Record<string, unknown>;
    },
  ) {
    return withTenant(opts.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select({ contactId: conversations.userId })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
        .limit(1);
      if (!conv) return { kind: "not_found" } as const;

      const [contact] = await tx
        .select({ id: contacts.id, attributesJson: contacts.attributesJson })
        .from(contacts)
        .where(and(eq(contacts.id, conv.contactId), eq(contacts.tenantId, tenantId)))
        .limit(1);
      if (!contact) return { kind: "contact_not_found" } as const;

      const result = mutate(contact.attributesJson);

      await tx
        .update(contacts)
        .set({ attributesJson: result.attributesJson, updatedAt: now })
        .where(and(eq(contacts.id, contact.id), eq(contacts.tenantId, tenantId)));

      const [lead] = await tx
        .select({ id: leads.id, state: leads.state })
        .from(leads)
        .where(and(eq(leads.tenantId, tenantId), eq(leads.userId, contact.id)))
        .orderBy(desc(leads.id))
        .limit(1);
      if (lead) {
        await tx.insert(leadEvents).values({
          tenantId,
          leadId: lead.id,
          fromState: lead.state,
          toState: lead.state,
          byAdminId: adminId,
          notes: JSON.stringify({
            type: result.eventType,
            contactId: contact.id,
            ...result.eventDetails,
          }),
          createdAt: now,
        });
      }

      return { kind: "ok", contactId: contact.id, mutation: result } as const;
    });
  }

  /**
   * POST /api/admin/conversations/:id/contact/ban
   * Банит контакт беседы (зеркало /api/admin/leads/:id/contact/ban, но по
   * conversation id — чтобы оператор банил прямо из инбокса).
   */
  app.post("/api/admin/conversations/:id/contact/ban", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    let reason = "";
    try {
      const body = (await c.req.json()) as { reason?: unknown };
      if (typeof body.reason === "string") reason = body.reason.trim().slice(0, 500);
    } catch {
      // empty body allowed
    }
    const now = Math.floor(Date.now() / 1000);
    const outcome = await moderateConversationContact(
      tenantId,
      conversationId,
      adminId,
      now,
      (attrs) => ({
        attributesJson: buildBannedAttributes(attrs, {
          adminId,
          reason,
          now,
          source: "admin_inbox",
        }),
        eventType: "contact_banned",
        eventDetails: { reason: reason || null },
      }),
    );
    if (outcome.kind === "not_found") return c.json({ error: "conversation not found" }, 404);
    if (outcome.kind === "contact_not_found") return c.json({ error: "contact not found" }, 409);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "conversation.contact_ban",
      targetKind: "contact",
      targetId: String(outcome.contactId),
      details: { conversationId, ...outcome.mutation.eventDetails },
    });

    return c.json({ ok: true, contactId: outcome.contactId, status: "banned" });
  });

  /**
   * POST /api/admin/conversations/:id/contact/unban
   * Снимает бан контакта беседы. Зеркало /contact/ban.
   */
  app.post("/api/admin/conversations/:id/contact/unban", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(conversationId) || conversationId <= 0) {
      return c.json({ error: "invalid conversation id" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const outcome = await moderateConversationContact(
      tenantId,
      conversationId,
      adminId,
      now,
      (attrs) => {
        const unban = buildUnbannedAttributes(attrs, { adminId, now });
        return {
          attributesJson: unban.attributesJson,
          eventType: "contact_unbanned",
          eventDetails: {
            wasBanned: unban.wasBanned,
            previousReason: unban.previousReason,
            previousBannedAt: unban.previousBannedAt,
          },
        };
      },
    );
    if (outcome.kind === "not_found") return c.json({ error: "conversation not found" }, 404);
    if (outcome.kind === "contact_not_found") return c.json({ error: "contact not found" }, 409);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "conversation.contact_unban",
      targetKind: "contact",
      targetId: String(outcome.contactId),
      details: { conversationId, ...outcome.mutation.eventDetails },
    });

    return c.json({ ok: true, contactId: outcome.contactId, status: "unbanned" });
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

  /**
   * DELETE /api/admin/conversations/:id/messages/:msgId
   * Soft-delete оператор сообщения (role='human'). Только свои сообщения.
   */
  app.delete("/api/admin/conversations/:id/messages/:msgId", async (c) => {
    const tenantId = c.var.tenantId;
    const conversationId = Number.parseInt(c.req.param("id"), 10);
    const messageId = Number.parseInt(c.req.param("msgId"), 10);
    if (!Number.isFinite(conversationId) || !Number.isFinite(messageId)) {
      return c.json({ error: "invalid id" }, 400);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const updated = await opts.db
      .update(messages)
      .set({ deletedAt: nowEpoch })
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.id, messageId),
          eq(messages.conversationId, conversationId),
          eq(messages.role, "human"),
          sql`${messages.deletedAt} IS NULL`,
        ),
      )
      .returning({ id: messages.id });

    if (updated.length === 0) return c.json({ error: "message not found or not deletable" }, 404);
    return c.json({ ok: true });
  });

  /**
   * PATCH /api/admin/conversations/:id
   * Body: { status?: 'open'|'pending'|'resolved', assignedAdminId?: number|null }
   */
  app.patch("/api/admin/conversations/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);

    let body: { status?: string; assignedAdminId?: number | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const updates: Partial<typeof conversations.$inferInsert> = {};
    if (body.status !== undefined) {
      if (!["open", "pending", "resolved"].includes(body.status)) {
        return c.json({ error: "invalid status" }, 400);
      }
      updates.status = body.status;
    }
    if (body.assignedAdminId !== undefined) {
      if (
        body.assignedAdminId !== null
        && (!Number.isInteger(body.assignedAdminId) || body.assignedAdminId <= 0)
      ) {
        return c.json({ error: "invalid assignedAdminId" }, 400);
      }
      updates.assignedAdminId = body.assignedAdminId;
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "no updates provided" }, 400);
    }

    const outcome = await withTenant(opts.db, tenantId, async (tx) => {
      if (body.assignedAdminId !== undefined && body.assignedAdminId !== null) {
        const [assignee] = await tx
          .select({ id: admins.id })
          .from(admins)
          .where(and(eq(admins.id, body.assignedAdminId), eq(admins.tenantId, tenantId)));
        if (!assignee) return { error: "assignee not found" as const };
      }

      const [updated] = await tx
        .update(conversations)
        .set(updates)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId)))
        .returning();
      return { conversation: updated ?? null };
    });

    if ("error" in outcome) return c.json({ error: outcome.error }, 404);
    if (!outcome.conversation) return c.json({ error: "conversation not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "conversation.update",
      targetKind: "conversation",
      targetId: id,
      details: updates,
    });

    return c.json({ ok: true, conversation: outcome.conversation });
  });

  return app;
}
