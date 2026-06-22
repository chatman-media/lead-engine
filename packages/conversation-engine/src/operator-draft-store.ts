// Хранилище отложенных черновиков ответа оператора, вынесенное из
// operator-bot-handler. Владеет in-memory Map (fallback без БД) и таблицей
// operator_action_drafts. Persistence-слой draft-flow, тестируется изолированно.

import { operatorActionDrafts } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { Db } from "./dal/types.ts";
import { type PendingOperatorDraft, parseJsonObject } from "./operator-bot-shared.ts";
import { withTenant } from "./with-tenant.ts";

export class DraftStore {
  private readonly pending = new Map<string, PendingOperatorDraft>();

  constructor(private readonly db?: Db) {}

  /** Удалить черновик из in-memory очереди (after-handle cleanup без БД). */
  deletePending(draftId: string): void {
    this.pending.delete(draftId);
  }

  async createPendingDraft(draft: PendingOperatorDraft): Promise<PendingOperatorDraft> {
    const db = this.db;
    if (!db) {
      this.pending.set(draft.draftId, { ...draft, status: "pending" });
      return { ...draft, status: "pending" };
    }
    const [row] = await withTenant(db, draft.tenantId, async (tx) =>
      tx
        .insert(operatorActionDrafts)
        .values({
          tenantId: draft.tenantId,
          adminId: draft.adminId,
          conversationId: draft.conversationId,
          draftKey: draft.draftId,
          chatId: draft.chatId,
          kind: "client_reply",
          status: "pending",
          text: draft.text,
          metadataJson: JSON.stringify(draft.metadata ?? {}),
          createdAt: draft.createdAt,
          expiresAt: draft.expiresAt,
          updatedAt: draft.createdAt,
        })
        .returning({ id: operatorActionDrafts.id }),
    );
    return {
      ...draft,
      dbId: row?.id,
      status: "pending",
    };
  }

  async findPendingDraft(draftId: string, tenantId: number): Promise<PendingOperatorDraft | null> {
    const db = this.db;
    if (!db) return this.pending.get(draftId) ?? null;
    const [row] = await withTenant(db, tenantId, async (tx) =>
      tx
        .select({
          id: operatorActionDrafts.id,
          tenantId: operatorActionDrafts.tenantId,
          adminId: operatorActionDrafts.adminId,
          conversationId: operatorActionDrafts.conversationId,
          draftKey: operatorActionDrafts.draftKey,
          chatId: operatorActionDrafts.chatId,
          status: operatorActionDrafts.status,
          text: operatorActionDrafts.text,
          metadataJson: operatorActionDrafts.metadataJson,
          createdAt: operatorActionDrafts.createdAt,
          expiresAt: operatorActionDrafts.expiresAt,
        })
        .from(operatorActionDrafts)
        .where(
          and(
            eq(operatorActionDrafts.tenantId, tenantId),
            eq(operatorActionDrafts.draftKey, draftId),
          ),
        )
        .limit(1),
    );
    if (!row || row.adminId === null) return null;
    return {
      draftId: row.draftKey,
      dbId: row.id,
      tenantId: row.tenantId,
      adminId: row.adminId,
      chatId: row.chatId,
      conversationId: row.conversationId,
      text: row.text,
      metadata: parseJsonObject(row.metadataJson),
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  async cancelDraft(draft: PendingOperatorDraft, now: number): Promise<void> {
    await this.markHandled(draft, "cancelled", now);
  }

  async expireDraft(draft: PendingOperatorDraft, now: number): Promise<void> {
    await this.markHandled(draft, "expired", now);
  }

  private async markHandled(
    draft: PendingOperatorDraft,
    status: "cancelled" | "expired",
    now: number,
  ): Promise<void> {
    const db = this.db;
    if (!db || !draft.dbId) {
      this.pending.delete(draft.draftId);
      return;
    }
    await withTenant(db, draft.tenantId, async (tx) => {
      await tx
        .update(operatorActionDrafts)
        .set({ status, handledAt: now, updatedAt: now })
        .where(
          and(
            eq(operatorActionDrafts.id, draft.dbId as number),
            eq(operatorActionDrafts.tenantId, draft.tenantId),
            eq(operatorActionDrafts.status, "pending"),
          ),
        );
    });
  }

  createDraftId(): string {
    for (let i = 0; i < 5; i++) {
      const id =
        globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 16) ??
        Math.random().toString(36).slice(2, 14);
      if (id.length >= 6 && !this.pending.has(id)) return id;
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
}
