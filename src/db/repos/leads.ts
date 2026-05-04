import type { Database } from "bun:sqlite";

/**
 * Lead pipeline state machine (see migration 009 for state semantics).
 *
 * Keep transitions linear and operator-driven for now: the bot doesn't
 * auto-promote across states, the admin UI does (or callback_query
 * handlers when an inline button is clicked). Auto-promotion (e.g. from
 * intake_pending → intake_complete based on extracted intake fields) is
 * Phase 2 and lives in the webhook, not here.
 */
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

/**
 * Append-only audit-trail row. See migration 010 for the rationale —
 * `leads.state` is the current cursor, `lead_events` is the history
 * the admin timeline panel renders.
 */
export interface LeadEventRow {
  id: number;
  lead_id: number;
  from_state: LeadState | null;
  to_state: LeadState;
  by_admin_id: number | null;
  notes: string | null;
  created_at: number;
}

/** Operator-facing free-form notes on a lead. Migration 011. */
export interface LeadNoteRow {
  id: number;
  lead_id: number;
  by_admin_id: number | null;
  body: string;
  created_at: number;
}

export class LeadsRepo {
  constructor(private db: Database) {}

  byId(id: number): LeadRow | null {
    return (
      this.db
        .query<LeadRow, [number]>("SELECT * FROM leads WHERE id = ? LIMIT 1")
        .get(id) ?? null
    );
  }

  byUserId(userId: number): LeadRow | null {
    return (
      this.db
        .query<LeadRow, [number]>(
          "SELECT * FROM leads WHERE user_id = ? LIMIT 1",
        )
        .get(userId) ?? null
    );
  }

  /**
   * Look up a lead by its ops-chat card message. Used by the relay
   * handler in webhook: when the operator replies to a lead card in
   * the ops chat, Telegram delivers `reply_to_message.message_id` and
   * we need to find which lead that card belongs to.
   */
  byOpsMessage(chatId: number, messageId: number): LeadRow | null {
    return (
      this.db
        .query<LeadRow, [number, number]>(
          `SELECT * FROM leads
           WHERE ops_chat_id = ? AND ops_message_id = ?
           LIMIT 1`,
        )
        .get(chatId, messageId) ?? null
    );
  }

  /**
   * Idempotent — returns existing lead for the user when one exists, else
   * creates a fresh `intake_pending` lead. The `user_id` UNIQUE constraint
   * means at most one lead row per candidate; closed/rejected leads must
   * be hard-deleted before a new lead can begin (operator decision).
   */
  ensureForUser(userId: number): LeadRow {
    const existing = this.byUserId(userId);
    if (existing) return existing;
    const row = this.db
      .query<LeadRow, [number]>(
        `INSERT INTO leads (user_id) VALUES (?) RETURNING *`,
      )
      .get(userId);
    if (!row) throw new Error("Failed to insert lead");
    // Synthetic "created" event — `from_state` NULL, to_state matches
    // the lead's default. Marks the start of the timeline.
    this.appendEvent(row.id, {
      fromState: null,
      toState: row.state,
      byAdminId: null,
      notes: null,
    });
    return row;
  }

  /**
   * Append a row to `lead_events`. Internal helper — prefer the
   * higher-level mutation methods (`setState`, `allocateApplicationId`,
   * `ensureForUser`) which call this automatically. Made public so
   * tests can inject events without going through a transition.
   */
  appendEvent(
    leadId: number,
    input: {
      fromState: LeadState | null;
      toState: LeadState;
      byAdminId: number | null;
      notes: string | null;
    },
  ): void {
    this.db.run(
      `INSERT INTO lead_events (lead_id, from_state, to_state, by_admin_id, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [leadId, input.fromState, input.toState, input.byAdminId, input.notes],
    );
  }

  /** Timeline for one lead, oldest first. */
  events(leadId: number): LeadEventRow[] {
    return this.db
      .query<LeadEventRow, [number]>(
        `SELECT * FROM lead_events
         WHERE lead_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(leadId);
  }

  /**
   * Operator-typed note on a lead. Body is required; whitespace-only
   * input is rejected to keep the notes panel clean. Returns the
   * inserted row so the caller can echo it back to the UI without
   * a re-fetch.
   */
  addNote(input: {
    leadId: number;
    body: string;
    byAdminId?: number;
  }): LeadNoteRow {
    const trimmed = input.body.trim();
    if (!trimmed) throw new Error("note body is empty");
    const row = this.db
      .query<LeadNoteRow, [number, number | null, string]>(
        `INSERT INTO lead_notes (lead_id, by_admin_id, body)
         VALUES (?, ?, ?) RETURNING *`,
      )
      .get(input.leadId, input.byAdminId ?? null, trimmed);
    if (!row) throw new Error("failed to insert lead note");
    return row;
  }

  /** All notes for a lead, freshest first. */
  notes(leadId: number): LeadNoteRow[] {
    return this.db
      .query<LeadNoteRow, [number]>(
        `SELECT * FROM lead_notes
         WHERE lead_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(leadId);
  }

  deleteNote(noteId: number): boolean {
    const res = this.db.run("DELETE FROM lead_notes WHERE id = ?", [noteId]);
    return res.changes > 0;
  }

  /**
   * Atomic state transition. Updates `updated_at` and (when the new state
   * is a terminal operator decision) `decided_by_admin_id` + `decided_at`.
   * The caller is responsible for sending any side-effect messages.
   */
  setState(
    id: number,
    state: LeadState,
    opts: { adminId?: number; rejectedReason?: string } = {},
  ): LeadRow | null {
    // Capture the prior state for the audit-trail row. When the lead
    // doesn't exist, return null without writing anything.
    const before = this.byId(id);
    if (!before) return null;
    // No-op transitions (re-emitting the same state) skip the event
    // log to keep the timeline meaningful — operators don't want to
    // see "intake_pending → intake_pending" rows.
    const sameState = before.state === state;

    const isDecision = state === "approved" || state === "rejected";
    if (isDecision) {
      this.db.run(
        `UPDATE leads
         SET state = ?, decided_by_admin_id = ?, decided_at = unixepoch(),
             rejected_reason = ?, updated_at = unixepoch()
         WHERE id = ?`,
        [
          state,
          opts.adminId ?? null,
          state === "rejected" ? opts.rejectedReason ?? null : null,
          id,
        ],
      );
    } else {
      this.db.run(
        `UPDATE leads SET state = ?, updated_at = unixepoch() WHERE id = ?`,
        [state, id],
      );
    }
    if (!sameState) {
      this.appendEvent(id, {
        fromState: before.state,
        toState: state,
        byAdminId: opts.adminId ?? null,
        // Only carry the rejection reason on the rejected event;
        // approved leads have no operator-typed note.
        notes: state === "rejected" ? opts.rejectedReason ?? null : null,
      });
    }
    return this.byId(id);
  }

  /** Stores the parsed intake fields. Caller serializes to JSON. */
  setIntake(id: number, intakeJson: string): void {
    this.db.run(
      `UPDATE leads SET intake_json = ?, updated_at = unixepoch() WHERE id = ?`,
      [intakeJson, id],
    );
  }

  setVisaDocs(id: number, visaDocsJson: string): void {
    this.db.run(
      `UPDATE leads SET visa_docs_json = ?, updated_at = unixepoch() WHERE id = ?`,
      [visaDocsJson, id],
    );
  }

  /**
   * Records the Telegram message id of the lead card we posted to the ops
   * chat, so callback_query handlers (and approve/reject UI actions) can
   * edit the card in place to show the new state.
   */
  setOpsCardMessage(id: number, chatId: number, messageId: number): void {
    this.db.run(
      `UPDATE leads SET ops_chat_id = ?, ops_message_id = ?, updated_at = unixepoch() WHERE id = ?`,
      [chatId, messageId, id],
    );
  }

  /**
   * Allocates the next sequential application id in the form
   * "VS-YYYY-NNNN" and assigns it to the lead. Idempotent on the lead's
   * existing application_id (returns it if already set).
   */
  allocateApplicationId(id: number): string {
    const existing = this.byId(id);
    if (existing?.application_id) return existing.application_id;
    const year = new Date().getFullYear();
    const prefix = `VS-${year}-`;
    const row = this.db
      .query<{ next_seq: number }, [number, string]>(
        `SELECT COALESCE(
           MAX(CAST(SUBSTR(application_id, ?) AS INTEGER)),
           0
         ) + 1 AS next_seq
         FROM leads
         WHERE application_id LIKE ? || '%'`,
      )
      .get(prefix.length + 1, prefix);
    const seq = row?.next_seq ?? 1;
    const applicationId = `${prefix}${String(seq).padStart(4, "0")}`;
    this.db.run(
      `UPDATE leads SET application_id = ?, updated_at = unixepoch() WHERE id = ?`,
      [applicationId, id],
    );
    // Surface the allocation in the timeline. The lead's state
    // doesn't change (the caller transitions to `docs_complete`
    // separately and that emits its own event), so we use a self-
    // loop pseudo-event with the current state on both sides and
    // the application id in `notes` — distinct from a state-change
    // event because from===to.
    const current = this.byId(id);
    if (current) {
      this.appendEvent(id, {
        fromState: current.state,
        toState: current.state,
        byAdminId: null,
        notes: `application_id=${applicationId}`,
      });
    }
    return applicationId;
  }

  list(opts: { state?: LeadState | null; limit?: number } = {}): Array<
    LeadRow & { tg_user_id: number; tg_username: string | null }
  > {
    const limit = opts.limit ?? 200;
    if (opts.state) {
      return this.db
        .query<
          LeadRow & { tg_user_id: number; tg_username: string | null },
          [LeadState, number]
        >(
          `SELECT l.*, u.tg_user_id, u.tg_username
           FROM leads l
           JOIN users u ON u.id = l.user_id
           WHERE l.state = ?
           ORDER BY l.updated_at DESC
           LIMIT ?`,
        )
        .all(opts.state, limit);
    }
    return this.db
      .query<
        LeadRow & { tg_user_id: number; tg_username: string | null },
        [number]
      >(
        `SELECT l.*, u.tg_user_id, u.tg_username
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
         LIMIT ?`,
      )
      .all(limit);
  }

  countByState(): Record<LeadState, number> {
    const rows = this.db
      .query<{ state: LeadState; count: number }, []>(
        `SELECT state, COUNT(*) AS count FROM leads GROUP BY state`,
      )
      .all();
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

  delete(id: number): boolean {
    const res = this.db.run("DELETE FROM leads WHERE id = ?", [id]);
    return res.changes > 0;
  }
}
