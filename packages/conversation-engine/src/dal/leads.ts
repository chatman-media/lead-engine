import { leads as leadsTable } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface LeadRow {
  id: number;
  tenantId: number;
  userId: number;
  state: string;
  assignedAdminId?: number | null;
  intakeJson: string | null;
  visaDocsJson: string | null;
  applicationId: string | null;
  opsChatId: number | null;
  opsMessageId: number | null;
  rejectedReason: string | null;
  decidedByAdminId: number | null;
  decidedAt: number | null;
  lastCheckinAt: number | null;
  visaInterviewField: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Leads repo. Schema-колонка user_id хранит contact.id (см. ConversationsRepo
 * docstring о legacy-имени). UNIQUE(user_id) гарантирует один лид на контакт
 * — даже при нескольких conversations (bot + userbot) лид всё ещё один.
 */
export class LeadsRepo {
  constructor(private readonly ctx: RepoCtx) {}

  async byId(id: number): Promise<LeadRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, id), eq(leadsTable.tenantId, this.ctx.tenantId)));
    return (row as LeadRow) ?? null;
  }

  async findByContactId(contactId: number): Promise<LeadRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.tenantId, this.ctx.tenantId), eq(leadsTable.userId, contactId)),
      );
    return (row as LeadRow) ?? null;
  }

  async create(opts: { contactId: number; state: string; nowEpoch: number }): Promise<LeadRow> {
    const [row] = await this.ctx.db
      .insert(leadsTable)
      .values({
        tenantId: this.ctx.tenantId,
        userId: opts.contactId,
        state: opts.state,
        createdAt: opts.nowEpoch,
        updatedAt: opts.nowEpoch,
      })
      .returning();
    if (!row) throw new Error("leads.create: insert returned no row");
    return row as LeadRow;
  }

  async updateState(leadId: number, newState: string, nowEpoch: number): Promise<void> {
    await this.ctx.db
      .update(leadsTable)
      .set({ state: newState, updatedAt: nowEpoch })
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.tenantId, this.ctx.tenantId)));
  }
}
