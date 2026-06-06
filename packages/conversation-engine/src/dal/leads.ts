import { leads as leadsTable } from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface LeadRow {
  id: number;
  tenantId: number;
  userId: number;
  state: string;
  /** Тип запроса (concierge): exchange | transfer | … . NULL для одно-воронных вертикалей. */
  requestType: string | null;
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
 * docstring о legacy-имени). UNIQUE(user_id) снят в migration 0032 — concierge
 * держит несколько лидов на контакт (по одному на request_type). Для одно-
 * воронных вертикалей лид по-прежнему один (гарантия на уровне приложения),
 * поэтому find-методы детерминированы (самый свежий по updated_at).
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

  /** Самый свежий лид контакта. Для одно-воронных вертикалей он единственный. */
  async findByContactId(contactId: number): Promise<LeadRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.tenantId, this.ctx.tenantId), eq(leadsTable.userId, contactId)),
      )
      .orderBy(desc(leadsTable.updatedAt))
      .limit(1);
    return (row as LeadRow) ?? null;
  }

  /** Все лиды контакта (concierge: N запросов на гостя), свежие первыми. */
  async findAllByContact(contactId: number): Promise<LeadRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.tenantId, this.ctx.tenantId), eq(leadsTable.userId, contactId)),
      )
      .orderBy(desc(leadsTable.updatedAt));
    return rows as LeadRow[];
  }

  /** Самый свежий лид контакта заданного request_type (concierge). */
  async findByContactAndType(
    contactId: number,
    requestType: string,
  ): Promise<LeadRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.tenantId, this.ctx.tenantId),
          eq(leadsTable.userId, contactId),
          eq(leadsTable.requestType, requestType),
        ),
      )
      .orderBy(desc(leadsTable.updatedAt))
      .limit(1);
    return (row as LeadRow) ?? null;
  }

  async create(opts: {
    contactId: number;
    state: string;
    requestType?: string | null;
    nowEpoch: number;
  }): Promise<LeadRow> {
    const [row] = await this.ctx.db
      .insert(leadsTable)
      .values({
        tenantId: this.ctx.tenantId,
        userId: opts.contactId,
        state: opts.state,
        requestType: opts.requestType ?? null,
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
