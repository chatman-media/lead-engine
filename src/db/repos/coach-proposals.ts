import type { CoachProposal } from "../../sales/coach.ts";
import type { Sql } from "../postgres.ts";

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
  constructor(private sql: Sql) {}

  async insert(input: {
    styleSlug: string;
    sampleSize: number;
    personaFilter: string | null;
    proposal: CoachProposal;
  }): Promise<CoachProposalRow> {
    const [row] = await this.sql<CoachProposalRow[]>`
      INSERT INTO coach_proposals
        (style_slug, sample_size, persona_filter, summary, edits_json, rationale_json, raw_output)
      VALUES (${input.styleSlug}, ${input.sampleSize}, ${input.personaFilter},
              ${input.proposal.summary}, ${JSON.stringify(input.proposal.edits)},
              ${JSON.stringify(input.proposal.rationale)}, ${input.proposal.raw ?? null})
      RETURNING *
    `;
    if (!row) throw new Error("failed to insert coach_proposal");
    return row;
  }

  async list(
    opts: { limit?: number; styleSlug?: string; status?: CoachProposalStatus } = {},
  ): Promise<CoachProposalRow[]> {
    const limit = opts.limit ?? 100;
    if (opts.styleSlug && opts.status) {
      return this.sql<CoachProposalRow[]>`
        SELECT * FROM coach_proposals WHERE style_slug = ${opts.styleSlug} AND status = ${opts.status}
        ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.styleSlug) {
      return this.sql<CoachProposalRow[]>`
        SELECT * FROM coach_proposals WHERE style_slug = ${opts.styleSlug} ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.status) {
      return this.sql<CoachProposalRow[]>`
        SELECT * FROM coach_proposals WHERE status = ${opts.status} ORDER BY id DESC LIMIT ${limit}
      `;
    }
    return this.sql<CoachProposalRow[]>`
      SELECT * FROM coach_proposals ORDER BY id DESC LIMIT ${limit}
    `;
  }

  async byId(id: number): Promise<CoachProposalDetail | null> {
    const [row] = await this.sql<CoachProposalRow[]>`
      SELECT * FROM coach_proposals WHERE id = ${id} LIMIT 1
    `;
    if (!row) return null;
    return {
      ...row,
      edits: parseEdits(row.edits_json),
      rationale: parseRationale(row.rationale_json),
    };
  }

  async decide(input: {
    id: number;
    status: "applied" | "dismissed";
    adminId: number;
  }): Promise<boolean> {
    const result = await this.sql`
      UPDATE coach_proposals
      SET status = ${input.status}, decided_at = EXTRACT(EPOCH FROM NOW())::INTEGER, decided_by_admin_id = ${input.adminId}
      WHERE id = ${input.id} AND status = 'pending'
    `;
    return result.count > 0;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM coach_proposals WHERE id = ${id}`;
    return result.count > 0;
  }

  async countPending(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM coach_proposals WHERE status = 'pending'
    `;
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
