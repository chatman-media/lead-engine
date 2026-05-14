import { inc } from "../../metrics.ts";
import type { Sql } from "../postgres.ts";

export type LeadState =
  | "intake_pending"
  | "intake_complete"
  | "approved"
  | "rejected"
  | "docs_pending"
  | "docs_complete"
  | "submitted"
  | "closed";

export interface LeadRow {
  id: number;
  user_id: number;
  state: LeadState;
  intake_json: string | null;
  visa_docs_json: string | null;
  application_id: string | null;
  ops_chat_id: number | null;
  ops_message_id: number | null;
  rejected_reason: string | null;
  decided_by_admin_id: number | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LeadEventRow {
  id: number;
  lead_id: number;
  from_state: LeadState | null;
  to_state: LeadState;
  by_admin_id: number | null;
  notes: string | null;
  created_at: number;
}

export interface LeadNoteRow {
  id: number;
  lead_id: number;
  by_admin_id: number | null;
  body: string;
  source: string | null;
  created_at: number;
}

export class LeadsRepo {
  constructor(private sql: Sql) {}

  async byId(id: number): Promise<LeadRow | null> {
    const [row] = await this.sql<LeadRow[]>`
      SELECT * FROM leads WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async byUserId(userId: number): Promise<LeadRow | null> {
    const [row] = await this.sql<LeadRow[]>`
      SELECT * FROM leads WHERE user_id = ${userId} LIMIT 1
    `;
    return row ?? null;
  }

  async byOpsMessage(chatId: number, messageId: number): Promise<LeadRow | null> {
    const [row] = await this.sql<LeadRow[]>`
      SELECT * FROM leads
      WHERE ops_chat_id = ${chatId} AND ops_message_id = ${messageId}
      LIMIT 1
    `;
    return row ?? null;
  }

  async ensureForUser(userId: number): Promise<LeadRow> {
    const existing = await this.byUserId(userId);
    if (existing) return existing;
    const [row] = await this.sql<LeadRow[]>`
      INSERT INTO leads (user_id) VALUES (${userId}) RETURNING *
    `;
    if (!row) throw new Error("Failed to insert lead");
    await this.appendEvent(row.id, {
      fromState: null,
      toState: row.state,
      byAdminId: null,
      notes: null,
    });
    return row;
  }

  async appendEvent(
    leadId: number,
    input: {
      fromState: LeadState | null;
      toState: LeadState;
      byAdminId: number | null;
      notes: string | null;
    },
  ): Promise<void> {
    await this.sql`
      INSERT INTO lead_events (lead_id, from_state, to_state, by_admin_id, notes)
      VALUES (${leadId}, ${input.fromState}, ${input.toState}, ${input.byAdminId}, ${input.notes})
    `;
    inc("lead_transitions_total", 1, { to_state: input.toState });
  }

  async events(leadId: number): Promise<LeadEventRow[]> {
    return this.sql<LeadEventRow[]>`
      SELECT * FROM lead_events
      WHERE lead_id = ${leadId}
      ORDER BY created_at ASC, id ASC
    `;
  }

  async addNote(input: { leadId: number; body: string; byAdminId?: number }): Promise<LeadNoteRow> {
    const trimmed = input.body.trim();
    if (!trimmed) throw new Error("note body is empty");
    const [row] = await this.sql<LeadNoteRow[]>`
      INSERT INTO lead_notes (lead_id, by_admin_id, body)
      VALUES (${input.leadId}, ${input.byAdminId ?? null}, ${trimmed}) RETURNING *
    `;
    if (!row) throw new Error("failed to insert lead note");
    return row;
  }

  async notes(leadId: number): Promise<LeadNoteRow[]> {
    return this.sql<LeadNoteRow[]>`
      SELECT * FROM lead_notes
      WHERE lead_id = ${leadId}
      ORDER BY created_at DESC, id DESC
    `;
  }

  async deleteNote(noteId: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM lead_notes WHERE id = ${noteId}`;
    return result.count > 0;
  }

  async upsertAutoFactsNote(leadId: number, body: string): Promise<void> {
    await this.sql`DELETE FROM lead_notes WHERE lead_id = ${leadId} AND source = 'auto_facts'`;
    await this.sql`
      INSERT INTO lead_notes (lead_id, body, source)
      VALUES (${leadId}, ${body}, 'auto_facts')
    `;
  }

  async setState(
    id: number,
    state: LeadState,
    opts: { adminId?: number; rejectedReason?: string } = {},
  ): Promise<LeadRow | null> {
    const before = await this.byId(id);
    if (!before) return null;
    const sameState = before.state === state;

    const isDecision = state === "approved" || state === "rejected";
    if (isDecision) {
      await this.sql`
        UPDATE leads
        SET state = ${state}, decided_by_admin_id = ${opts.adminId ?? null},
            decided_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
            rejected_reason = ${state === "rejected" ? (opts.rejectedReason ?? null) : null},
            updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE id = ${id}
      `;
    } else {
      await this.sql`
        UPDATE leads SET state = ${state}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
      `;
    }
    if (!sameState) {
      await this.appendEvent(id, {
        fromState: before.state,
        toState: state,
        byAdminId: opts.adminId ?? null,
        notes: state === "rejected" ? (opts.rejectedReason ?? null) : null,
      });
    }
    return this.byId(id);
  }

  async setIntake(id: number, intakeJson: string): Promise<void> {
    await this.sql`
      UPDATE leads SET intake_json = ${intakeJson}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  async setVisaDocs(id: number, visaDocsJson: string): Promise<void> {
    await this.sql`
      UPDATE leads SET visa_docs_json = ${visaDocsJson}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  async setOpsCardMessage(id: number, chatId: number, messageId: number): Promise<void> {
    await this.sql`
      UPDATE leads SET ops_chat_id = ${chatId}, ops_message_id = ${messageId}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  async allocateApplicationId(id: number): Promise<string> {
    const existing = await this.byId(id);
    if (existing?.application_id) return existing.application_id;
    const year = new Date().getFullYear();
    const prefix = `VS-${year}-`;
    // Get max sequence number
    const [row] = await this.sql<{ next_seq: number }[]>`
      SELECT COALESCE(
        MAX(CAST(SUBSTR(application_id, ${prefix.length + 1}) AS INTEGER)),
        0
      ) + 1 AS next_seq
      FROM leads
      WHERE application_id LIKE ${`${prefix}%`}
    `;
    const seq = row?.next_seq ?? 1;
    const applicationId = `${prefix}${String(seq).padStart(4, "0")}`;
    await this.sql`
      UPDATE leads SET application_id = ${applicationId}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
    const current = await this.byId(id);
    if (current) {
      await this.appendEvent(id, {
        fromState: current.state,
        toState: current.state,
        byAdminId: null,
        notes: `application_id=${applicationId}`,
      });
    }
    return applicationId;
  }

  async list(
    opts: { state?: LeadState | null; limit?: number } = {},
  ): Promise<Array<LeadRow & { tg_user_id: number; tg_username: string | null }>> {
    const limit = opts.limit ?? 200;
    if (opts.state) {
      return this.sql<Array<LeadRow & { tg_user_id: number; tg_username: string | null }>>`
        SELECT l.*, u.tg_user_id, u.tg_username
        FROM leads l
        JOIN users u ON u.id = l.user_id
        WHERE l.state = ${opts.state}
        ORDER BY l.updated_at DESC
        LIMIT ${limit}
      `;
    }
    return this.sql<Array<LeadRow & { tg_user_id: number; tg_username: string | null }>>`
      SELECT l.*, u.tg_user_id, u.tg_username
      FROM leads l
      JOIN users u ON u.id = l.user_id
      ORDER BY
        CASE l.state
          WHEN 'intake_complete' THEN 0
          WHEN 'docs_complete' THEN 1
          WHEN 'approved' THEN 2
          WHEN 'docs_pending' THEN 3
          WHEN 'intake_pending' THEN 4
          ELSE 5
        END,
        l.updated_at DESC
      LIMIT ${limit}
    `;
  }

  async countByState(): Promise<Record<LeadState, number>> {
    const rows = await this.sql<{ state: LeadState; count: number }[]>`
      SELECT state, COUNT(*)::INTEGER AS count FROM leads GROUP BY state
    `;
    const result: Record<LeadState, number> = {
      intake_pending: 0,
      intake_complete: 0,
      approved: 0,
      rejected: 0,
      docs_pending: 0,
      docs_complete: 0,
      submitted: 0,
      closed: 0,
    };
    for (const r of rows) result[r.state] = r.count;
    return result;
  }

  /**
   * Return leads in non-terminal states whose `updated_at` is older than
   * `cutoffEpoch` (seconds since Unix epoch). Used by the stale-sweep job.
   */
  async listStale(
    states: LeadState[],
    cutoffEpoch: number,
  ): Promise<Array<{ id: number; state: LeadState; updated_at: number }>> {
    if (states.length === 0) return [];
    return this.sql<Array<{ id: number; state: LeadState; updated_at: number }>>`
      SELECT id, state, updated_at
      FROM leads
      WHERE state = ANY(${states}::text[])
        AND updated_at < ${cutoffEpoch}
    `;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM leads WHERE id = ${id}`;
    return result.count > 0;
  }
}
