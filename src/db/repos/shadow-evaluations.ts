import type { PairwiseWinner } from "../../sales/self-play/pairwise.ts";
import type { Sql } from "../postgres.ts";

export type ShadowEvalStatus = "running" | "complete" | "failed";
export type ShadowEvalDecision = "keep" | "rollback" | "inconclusive";

export interface ShadowEvalRow {
  id: number;
  proposal_id: number;
  parent_style_slug: string;
  parent_style_id: number;
  new_style_slug: string;
  new_style_id: number;
  pairs_planned: number;
  pairs_done: number;
  a_wins: number;
  b_wins: number;
  draws: number;
  win_rate_lb: number | null;
  status: ShadowEvalStatus;
  decision: ShadowEvalDecision | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

export class ShadowEvaluationsRepo {
  constructor(private sql: Sql) {}

  async insert(input: {
    proposalId: number;
    parentStyleSlug: string;
    parentStyleId: number;
    newStyleSlug: string;
    newStyleId: number;
    pairsPlanned: number;
  }): Promise<ShadowEvalRow> {
    const [row] = await this.sql<ShadowEvalRow[]>`
      INSERT INTO shadow_evaluations
        (proposal_id, parent_style_slug, parent_style_id,
         new_style_slug, new_style_id, pairs_planned)
      VALUES (${input.proposalId}, ${input.parentStyleSlug}, ${input.parentStyleId},
              ${input.newStyleSlug}, ${input.newStyleId}, ${input.pairsPlanned})
      RETURNING *
    `;
    if (!row) throw new Error("failed to insert shadow_evaluation");
    return row;
  }

  async bumpPairResult(id: number, winner: PairwiseWinner): Promise<void> {
    const aDelta = winner === "a" ? 1 : 0;
    const bDelta = winner === "b" ? 1 : 0;
    const dDelta = winner === "draw" ? 1 : 0;
    await this.sql`
      UPDATE shadow_evaluations
      SET pairs_done = pairs_done + 1,
          a_wins = a_wins + ${aDelta},
          b_wins = b_wins + ${bDelta},
          draws = draws + ${dDelta}
      WHERE id = ${id}
    `;
  }

  async complete(id: number, winRateLb: number, decision: ShadowEvalDecision): Promise<void> {
    await this.sql`
      UPDATE shadow_evaluations
      SET status = 'complete',
          win_rate_lb = ${winRateLb},
          decision = ${decision},
          completed_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id}
    `;
  }

  async fail(id: number, errorMessage: string): Promise<void> {
    await this.sql`
      UPDATE shadow_evaluations
      SET status = 'failed',
          error_message = ${errorMessage},
          completed_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id}
    `;
  }

  async byId(id: number): Promise<ShadowEvalRow | null> {
    const [row] = await this.sql<ShadowEvalRow[]>`
      SELECT * FROM shadow_evaluations WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async latestForProposal(proposalId: number): Promise<ShadowEvalRow | null> {
    const [row] = await this.sql<ShadowEvalRow[]>`
      SELECT * FROM shadow_evaluations WHERE proposal_id = ${proposalId}
      ORDER BY id DESC LIMIT 1
    `;
    return row ?? null;
  }
}
