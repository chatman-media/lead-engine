/**
 * Coach proposal persistence. See migration 019. Operator workflow:
 *   1. POST /admin/api/coach/run → proposeStyleEdits + insert (status=pending)
 *   2. Admin reviews on /admin/coach
 *   3. POST /admin/api/coach/:id/decide {status:'applied'|'dismissed'} → audit
 */
import type { Database } from "bun:sqlite";

import type { CoachProposal } from "../../sales/coach.ts";

export type CoachProposalStatus = "pending" | "applied" | "dismissed";

export interface CoachProposalRow {
  id: number;
  style_slug: string;
  sample_size: number;
  persona_filter: string | null;
  summary: string;
  edits_json: string;
  rationale_json: string;
  raw_output: string | null;
  status: CoachProposalStatus;
  created_at: number;
  decided_at: number | null;
  decided_by_admin_id: number | null;
}

export interface CoachProposalDetail extends CoachProposalRow {
  edits: CoachProposal["edits"];
  rationale: string[];
}

export class CoachProposalsRepo {
  constructor(private db: Database) {}

  insert(input: {
    styleSlug: string;
    sampleSize: number;
    personaFilter: string | null;
    proposal: CoachProposal;
  }): CoachProposalRow {
    const row = this.db
      .query<
        CoachProposalRow,
        [string, number, string | null, string, string, string, string | null]
      >(
        `INSERT INTO coach_proposals
           (style_slug, sample_size, persona_filter, summary, edits_json, rationale_json, raw_output)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.styleSlug,
        input.sampleSize,
        input.personaFilter,
        input.proposal.summary,
        JSON.stringify(input.proposal.edits),
        JSON.stringify(input.proposal.rationale),
        input.proposal.raw ?? null,
      );
    if (!row) throw new Error("failed to insert coach_proposal");
    return row;
  }

  list(
    opts: { limit?: number; styleSlug?: string; status?: CoachProposalStatus } = {},
  ): CoachProposalRow[] {
    const wheres: string[] = [];
    const params: (string | number)[] = [];
    if (opts.styleSlug) {
      wheres.push("style_slug = ?");
      params.push(opts.styleSlug);
    }
    if (opts.status) {
      wheres.push("status = ?");
      params.push(opts.status);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    params.push(limit);
    return this.db
      .query<CoachProposalRow, (string | number)[]>(
        `SELECT * FROM coach_proposals ${whereClause} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params);
  }

  byId(id: number): CoachProposalDetail | null {
    const row = this.db
      .query<CoachProposalRow, [number]>(`SELECT * FROM coach_proposals WHERE id = ? LIMIT 1`)
      .get(id);
    if (!row) return null;
    return {
      ...row,
      edits: parseEdits(row.edits_json),
      rationale: parseRationale(row.rationale_json),
    };
  }

  decide(input: { id: number; status: "applied" | "dismissed"; adminId: number }): boolean {
    const r = this.db.run(
      `UPDATE coach_proposals
       SET status = ?, decided_at = unixepoch(), decided_by_admin_id = ?
       WHERE id = ? AND status = 'pending'`,
      [input.status, input.adminId, input.id],
    );
    return r.changes > 0;
  }

  delete(id: number): boolean {
    const r = this.db.run(`DELETE FROM coach_proposals WHERE id = ?`, [id]);
    return r.changes > 0;
  }

  countPending(): number {
    const r = this.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM coach_proposals WHERE status = 'pending'`,
      )
      .get();
    return r?.n ?? 0;
  }
}

function parseEdits(raw: string): CoachProposal["edits"] {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseRationale(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}
