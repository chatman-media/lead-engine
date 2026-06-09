import { conversations as conversationsTable } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface ConversationRow {
  id: number;
  tenantId: number;
  userId: number;
  source: string;
  mode: "ai" | "queued" | "human";
  status: "open" | "pending" | "resolved";
  unreadCount: number;
  lastMessageText: string | null;
  escalatedAt: number | null;
  assignedAdminId: number | null;
  lastMessageAt: number | null;
  createdAt: number;
  styleId: number | null;
  experimentId: number | null;
  currentStage: string | null;
  summaryJson: string | null;
  metaJson: string | null;
}

/**
 * Conversations repo. Поле `userId` — legacy: было задумано как ссылка
 * на старую таблицу users. Сейчас conversations.user_id хранит contact.id
 * (мы reused колонку чтобы избежать схема-миграции при backfill).
 * После Этапа 8 (миграция users → contacts) переименуем колонку в
 * contact_id.
 *
 * `source` — legacy enum 'bot|userbot|self_play'. В будущей миграции
 * заменяется на channel_id напрямую (FK на channels). Сейчас contactId
 * прокидывается дополнительно — каждая conversation per (contact_id, source).
 */
export class ConversationsRepo {
  constructor(private readonly ctx: RepoCtx) {}

  /**
   * Найти существующую conversation per (contactId, source). UNIQUE
   * uniq_conversations_user_source гарантирует одну строку.
   */
  async findByContactAndSource(contactId: number, source: string): Promise<ConversationRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.tenantId, this.ctx.tenantId),
          eq(conversationsTable.userId, contactId),
          eq(conversationsTable.source, source),
        ),
      );
    return (row as ConversationRow) ?? null;
  }

  async create(opts: {
    contactId: number;
    source: string;
    mode?: "ai" | "queued" | "human";
    styleId?: number | null;
    experimentId?: number | null;
    nowEpoch: number;
  }): Promise<ConversationRow> {
    const [row] = await this.ctx.db
      .insert(conversationsTable)
      .values({
        tenantId: this.ctx.tenantId,
        userId: opts.contactId,
        source: opts.source,
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.styleId !== undefined ? { styleId: opts.styleId } : {}),
        ...(opts.experimentId !== undefined ? { experimentId: opts.experimentId } : {}),
        lastMessageAt: opts.nowEpoch,
      })
      .returning();
    if (!row) throw new Error("conversations.create: insert returned no row");
    return row as ConversationRow;
  }

  /**
   * Последние N conversations tenant'а, sorted DESC by last_message_at
   * (NULLS LAST). Для admin-UI inbox.
   */
  async recent(limit: number): Promise<ConversationRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.tenantId, this.ctx.tenantId))
      .orderBy(sql`last_message_at DESC NULLS LAST`)
      .limit(limit);
    return rows as ConversationRow[];
  }

  async touchLastMessageAt(conversationId: number, nowEpoch: number): Promise<void> {
    await this.ctx.db
      .update(conversationsTable)
      .set({ lastMessageAt: nowEpoch })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
  }

  async updateInboxMetadata(
    conversationId: number,
    opts: {
      lastMessageText?: string;
      lastMessageAt?: number;
      incrementUnread?: boolean;
      status?: "open" | "pending" | "resolved";
    },
  ): Promise<void> {
    const updates: Partial<typeof conversationsTable.$inferInsert> = {};
    if (opts.lastMessageText !== undefined) updates.lastMessageText = opts.lastMessageText;
    if (opts.lastMessageAt !== undefined) updates.lastMessageAt = opts.lastMessageAt;
    if (opts.status !== undefined) updates.status = opts.status;

    await this.ctx.db
      .update(conversationsTable)
      .set({
        ...updates,
        ...(opts.incrementUnread
          ? { unreadCount: sql`${conversationsTable.unreadCount} + 1` }
          : {}),
      })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
  }

  async markAsRead(conversationId: number): Promise<void> {
    await this.ctx.db
      .update(conversationsTable)
      .set({ unreadCount: 0 })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
  }

  async setAssignee(conversationId: number, adminId: number | null): Promise<void> {
    await this.ctx.db
      .update(conversationsTable)
      .set({ assignedAdminId: adminId })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
  }

  /** Persist the style / experiment chosen for this conversation turn. */
  async setAssignment(
    conversationId: number,
    assignment: { styleId?: number | null; experimentId?: number | null },
  ): Promise<void> {
    const updates: Partial<typeof conversationsTable.$inferInsert> = {};
    if (assignment.styleId !== undefined) updates.styleId = assignment.styleId;
    if (assignment.experimentId !== undefined) updates.experimentId = assignment.experimentId;
    if (Object.keys(updates).length === 0) return;

    await this.ctx.db
      .update(conversationsTable)
      .set(updates)
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
  }

  /** Сохранить сжатое резюме диалога (conversation compaction). */
  async setSummaryJson(conversationId: number, summaryJson: string): Promise<void> {
    await this.ctx.db
      .update(conversationsTable)
      .set({ summaryJson })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
  }

  /** Загрузить conversation по ID. Null если не найдена (или другой tenant). */
  async findById(conversationId: number): Promise<ConversationRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.tenantId, this.ctx.tenantId),
        ),
      );
    return (row as ConversationRow) ?? null;
  }
}
