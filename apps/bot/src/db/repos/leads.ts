import { inc } from "../../metrics.ts";
import type { Sql } from "../postgres.ts";

export type LeadState =
  | "intake_pending"
  | "intake_complete"
  | "approved"
  | "partner_review"
  | "rejected"
  | "docs_pending"
  | "docs_complete"
  | "submitted"
  | "ready_to_work"
  | "closed";

/**
 * Lead-state transition guard. Permissive on purpose — operators
 * routinely skip funnel steps (approve straight from intake_pending,
 * jump directly to docs_complete after an offline submission, etc.).
 * The guard only rejects writes out of terminal states (a bug that
 * teleports a `closed` or `rejected` lead back into intake would be
 * silent without it). "Same state" writes go through an idempotency
 * branch in setState() and don't pass through this check.
 */
const TERMINAL_LEAD_TRANSITIONS: Readonly<Partial<Record<LeadState, ReadonlySet<LeadState>>>> = {
  // After the visa is filed the only forward move is the successful
  // outcome (ready_to_work); otherwise the lead is closed out.
  submitted: new Set<LeadState>(["ready_to_work", "closed"]),
  // ready_to_work is the success terminal — only an archival close follows.
  ready_to_work: new Set<LeadState>(["closed"]),
  // Rejected leads also flow only into closed.
  rejected: new Set<LeadState>(["closed"]),
  // Closed is a sink. Resurrection would erase the audit trail.
  closed: new Set<LeadState>(),
};

function isLegalLeadTransition(from: LeadState, to: LeadState): boolean {
  const allowed = TERMINAL_LEAD_TRANSITIONS[from];
  if (allowed === undefined) return true; // non-terminal: any transition OK
  return allowed.has(to);
}

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
  last_checkin_at: number | null;
  /** Step-by-step visa-anketa interview: the `VisaFields` key the bot is
   *  currently awaiting an answer for. `null` = interview not running. */
  visa_interview_field: string | null;
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
    // Run the read + UPDATE + event-append inside a single transaction with
    // SELECT … FOR UPDATE so a concurrent auto-promote (from webhook) and
    // operator approve (from admin) can't both observe the same `before`
    // state and produce a torn transition / duplicate lead_event row.
    return this.sql.begin(async (tx) => {
      const [before] = await tx<LeadRow[]>`
        SELECT * FROM leads WHERE id = ${id} FOR UPDATE
      `;
      if (!before) return null;
      const sameState = before.state === state;

      // Reject obviously-invalid transitions so a bug elsewhere can't
      // teleport a closed/submitted lead back into intake. Same-state
      // writes are tolerated (idempotent re-calls).
      if (!sameState && !isLegalLeadTransition(before.state, state)) {
        throw new Error(`illegal lead transition: ${before.state} → ${state}`);
      }

      const isDecision = state === "approved" || state === "rejected";
      if (isDecision) {
        await tx`
          UPDATE leads
          SET state = ${state}, decided_by_admin_id = ${opts.adminId ?? null},
              decided_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
              rejected_reason = ${state === "rejected" ? (opts.rejectedReason ?? null) : null},
              updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
          WHERE id = ${id}
        `;
      } else {
        await tx`
          UPDATE leads SET state = ${state}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
        `;
      }
      if (!sameState) {
        await tx`
          INSERT INTO lead_events (lead_id, from_state, to_state, by_admin_id, notes)
          VALUES (${id}, ${before.state}, ${state}, ${opts.adminId ?? null}, ${
            state === "rejected" ? (opts.rejectedReason ?? null) : null
          })
        `;
        inc("lead_transitions_total", 1, { to_state: state });
      }
      const [after] = await tx<LeadRow[]>`SELECT * FROM leads WHERE id = ${id}`;
      return after ?? null;
    });
  }

  async setIntake(id: number, intakeJson: string): Promise<void> {
    await this.sql`
      UPDATE leads SET intake_json = ${intakeJson}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  /**
   * Atomically claim a one-shot flag in `intake_json.media_ack` (e.g.
   * the full-body nudge, or the "запрос в клуб" awaiting-approval note).
   * Returns true exactly once across concurrent callers — a Telegram
   * album fans out into many parallel webhook handlers, so the dedup
   * has to happen in a single conditional UPDATE (row lock) rather than
   * read-modify-write. The caller performs the one-shot side effect
   * (sending the message to the candidate) only when this returns true.
   */
  async claimMediaAck(
    id: number,
    key: "full_body_nudged" | "awaiting_approval_sent",
  ): Promise<boolean> {
    // `jsonb_set` with create_missing does NOT create intermediate objects,
    // so when `media_ack` is absent it would silently no-op. Build the
    // nested object explicitly via `||` merges instead.
    const result = await this.sql`
      UPDATE leads
      SET intake_json = (
            COALESCE(intake_json::jsonb, '{}'::jsonb)
            || jsonb_build_object(
                 'media_ack',
                 COALESCE(intake_json::jsonb -> 'media_ack', '{}'::jsonb)
                   || jsonb_build_object(${key}::text, true)
               )
          )::text,
          updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id}
        AND COALESCE(intake_json::jsonb #>> ARRAY['media_ack', ${key}]::text[], 'false') <> 'true'
    `;
    return result.count > 0;
  }

  async setVisaDocs(id: number, visaDocsJson: string): Promise<void> {
    await this.sql`
      UPDATE leads SET visa_docs_json = ${visaDocsJson}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  /** Set (or clear with `null`) the visa-anketa interview pointer — the
   *  `VisaFields` key the bot is currently asking the candidate about. */
  async setVisaInterviewField(id: number, field: string | null): Promise<void> {
    await this.sql`
      UPDATE leads SET visa_interview_field = ${field}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
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
      partner_review: 0,
      rejected: 0,
      docs_pending: 0,
      docs_complete: 0,
      submitted: 0,
      ready_to_work: 0,
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

  /**
   * Leads parked in a waiting stage, each with the epoch it entered that
   * stage (latest matching `lead_events` row) and its last proactive
   * check-in. The proactive-checkin scheduler decides per-lead whether a
   * nudge is due — this only gathers the inputs.
   */
  async listCheckinCandidates(states: LeadState[]): Promise<
    Array<{
      id: number;
      state: LeadState;
      user_id: number;
      tg_user_id: number;
      tg_username: string | null;
      last_checkin_at: number | null;
      stage_entered_at: number | null;
    }>
  > {
    if (states.length === 0) return [];
    return this.sql`
      SELECT l.id, l.state, l.user_id, u.tg_user_id, u.tg_username,
             l.last_checkin_at,
             (SELECT MAX(e.created_at) FROM lead_events e
               WHERE e.lead_id = l.id AND e.to_state = l.state) AS stage_entered_at
      FROM leads l
      JOIN users u ON u.id = l.user_id
      WHERE l.state = ANY(${states}::text[])
    `;
  }

  /**
   * Record that a proactive check-in DM was sent. Deliberately does NOT
   * bump `updated_at`: a bot-initiated nudge is not lead progression, and
   * resetting `updated_at` would keep a ghosted lead off the stale-sweep
   * radar forever.
   */
  async markCheckinSent(id: number, atEpoch: number): Promise<void> {
    await this.sql`UPDATE leads SET last_checkin_at = ${atEpoch} WHERE id = ${id}`;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM leads WHERE id = ${id}`;
    return result.count > 0;
  }
}
