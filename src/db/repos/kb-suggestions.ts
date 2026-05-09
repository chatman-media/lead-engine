import type { Database } from "bun:sqlite";

export type SuggestionStatus = "pending" | "ingested" | "rejected";

export interface KbSuggestionRow {
  id: number;
  question_text: string;
  answer_draft: string | null;
  status: SuggestionStatus;
  source_conversation_id: number | null;
  source_message_id: number | null;
  decided_by_admin_id: number | null;
  decided_at: number | null;
  kb_document_id: number | null;
  rejected_reason: string | null;
  created_at: number;
  updated_at: number;
}

export class KbSuggestionsRepo {
  constructor(private db: Database) {}

  byId(id: number): KbSuggestionRow | null {
    return (
      this.db
        .query<KbSuggestionRow, [number]>("SELECT * FROM kb_suggestions WHERE id = ? LIMIT 1")
        .get(id) ?? null
    );
  }

  /**
   * Create a suggestion. Deduplicates per conversation: if a pending suggestion
   * already exists for the same conversation, returns the existing row without
   * inserting a duplicate.
   */
  create(input: {
    questionText: string;
    sourceConversationId?: number | null;
    sourceMessageId?: number | null;
  }): KbSuggestionRow {
    if (input.sourceConversationId) {
      const existing = this.db
        .query<KbSuggestionRow, [number]>(
          `SELECT * FROM kb_suggestions
           WHERE source_conversation_id = ? AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.sourceConversationId);
      if (existing) return existing;
    }
    const row = this.db
      .query<KbSuggestionRow, [string, number | null, number | null]>(
        `INSERT INTO kb_suggestions (question_text, source_conversation_id, source_message_id)
         VALUES (?, ?, ?) RETURNING *`,
      )
      .get(input.questionText, input.sourceConversationId ?? null, input.sourceMessageId ?? null);
    if (!row) throw new Error("Failed to insert kb_suggestion");
    return row;
  }

  list(opts: { status?: SuggestionStatus; limit?: number } = {}): KbSuggestionRow[] {
    const limit = opts.limit ?? 200;
    if (opts.status) {
      return this.db
        .query<KbSuggestionRow, [SuggestionStatus, number]>(
          `SELECT * FROM kb_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(opts.status, limit);
    }
    return this.db
      .query<KbSuggestionRow, [number]>(
        `SELECT * FROM kb_suggestions ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  setDraft(id: number, answerDraft: string): KbSuggestionRow | null {
    this.db.run(
      `UPDATE kb_suggestions SET answer_draft = ?, updated_at = unixepoch() WHERE id = ?`,
      [answerDraft, id],
    );
    return this.byId(id);
  }

  reject(id: number, adminId: number, reason?: string): KbSuggestionRow | null {
    this.db.run(
      `UPDATE kb_suggestions
       SET status = 'rejected', decided_by_admin_id = ?, decided_at = unixepoch(),
           rejected_reason = ?, updated_at = unixepoch()
       WHERE id = ? AND status = 'pending'`,
      [adminId, reason ?? null, id],
    );
    return this.byId(id);
  }

  markIngested(id: number, adminId: number, kbDocumentId: number): KbSuggestionRow | null {
    this.db.run(
      `UPDATE kb_suggestions
       SET status = 'ingested', decided_by_admin_id = ?, decided_at = unixepoch(),
           kb_document_id = ?, updated_at = unixepoch()
       WHERE id = ?`,
      [adminId, kbDocumentId, id],
    );
    return this.byId(id);
  }

  pendingCount(): number {
    const row = this.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending'`)
      .get();
    return row?.n ?? 0;
  }

  countByStatus(): Record<SuggestionStatus, number> {
    const rows = this.db
      .query<{ status: SuggestionStatus; count: number }, []>(
        `SELECT status, COUNT(*) AS count FROM kb_suggestions GROUP BY status`,
      )
      .all();
    const result: Record<SuggestionStatus, number> = { pending: 0, ingested: 0, rejected: 0 };
    for (const r of rows) result[r.status] = r.count;
    return result;
  }
}
