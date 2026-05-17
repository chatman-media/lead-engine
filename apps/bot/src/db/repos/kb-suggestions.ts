import type { Sql } from "../postgres.ts";

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
  constructor(private sql: Sql) {}

  async byId(id: number): Promise<KbSuggestionRow | null> {
    const [row] = await this.sql<KbSuggestionRow[]>`
      SELECT * FROM kb_suggestions WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async create(input: {
    questionText: string;
    sourceConversationId?: number | null;
    sourceMessageId?: number | null;
  }): Promise<KbSuggestionRow> {
    if (input.sourceConversationId) {
      const [existing] = await this.sql<KbSuggestionRow[]>`
        SELECT * FROM kb_suggestions
        WHERE source_conversation_id = ${input.sourceConversationId} AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `;
      if (existing) return existing;
    }
    const [row] = await this.sql<KbSuggestionRow[]>`
      INSERT INTO kb_suggestions (question_text, source_conversation_id, source_message_id)
      VALUES (${input.questionText}, ${input.sourceConversationId ?? null}, ${input.sourceMessageId ?? null}) RETURNING *
    `;
    if (!row) throw new Error("Failed to insert kb_suggestion");
    return row;
  }

  async list(opts: { status?: SuggestionStatus; limit?: number } = {}): Promise<KbSuggestionRow[]> {
    const limit = opts.limit ?? 200;
    if (opts.status) {
      return this.sql<KbSuggestionRow[]>`
        SELECT * FROM kb_suggestions WHERE status = ${opts.status} ORDER BY created_at DESC LIMIT ${limit}
      `;
    }
    return this.sql<KbSuggestionRow[]>`
      SELECT * FROM kb_suggestions ORDER BY created_at DESC LIMIT ${limit}
    `;
  }

  async setDraft(id: number, answerDraft: string): Promise<KbSuggestionRow | null> {
    await this.sql`
      UPDATE kb_suggestions SET answer_draft = ${answerDraft}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
    return this.byId(id);
  }

  async reject(id: number, adminId: number, reason?: string): Promise<KbSuggestionRow | null> {
    await this.sql`
      UPDATE kb_suggestions
      SET status = 'rejected', decided_by_admin_id = ${adminId}, decided_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
          rejected_reason = ${reason ?? null}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id} AND status = 'pending'
    `;
    return this.byId(id);
  }

  async markIngested(
    id: number,
    adminId: number,
    kbDocumentId: number,
  ): Promise<KbSuggestionRow | null> {
    await this.sql`
      UPDATE kb_suggestions
      SET status = 'ingested', decided_by_admin_id = ${adminId}, decided_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
          kb_document_id = ${kbDocumentId}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id}
    `;
    return this.byId(id);
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM kb_suggestions WHERE status = 'pending'
    `;
    return row?.n ?? 0;
  }

  async countByStatus(): Promise<Record<SuggestionStatus, number>> {
    const rows = await this.sql<{ status: SuggestionStatus; count: number }[]>`
      SELECT status, COUNT(*)::INTEGER AS count FROM kb_suggestions GROUP BY status
    `;
    const result: Record<SuggestionStatus, number> = { pending: 0, ingested: 0, rejected: 0 };
    for (const r of rows) result[r.status] = r.count;
    return result;
  }
}
