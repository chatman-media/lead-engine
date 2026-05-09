/**
 * Shadow evaluation persistence. See migration 020 for schema and lifecycle.
 * Writes happen from a background task in `runShadowEval` (in-process), so
 * the repo provides incremental update methods (`bumpPairResult`, `complete`,
 * `fail`) the runner uses as it progresses.
 */
import type { Database } from "bun:sqlite";

import type { PairwiseWinner } from "../../sales/self-play/pairwise.ts";

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
  constructor(private db: Database) {}

  insert(input: {
    proposalId: number;
    parentStyleSlug: string;
    parentStyleId: number;
    newStyleSlug: string;
    newStyleId: number;
    pairsPlanned: number;
  }): ShadowEvalRow {
    const row = this.db
      .query<ShadowEvalRow, [number, string, number, string, number, number]>(
        `INSERT INTO shadow_evaluations
           (proposal_id, parent_style_slug, parent_style_id,
            new_style_slug, new_style_id, pairs_planned)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.proposalId,
        input.parentStyleSlug,
        input.parentStyleId,
        input.newStyleSlug,
        input.newStyleId,
        input.pairsPlanned,
      );
    if (!row) throw new Error("failed to insert shadow_evaluation");
    return row;
  }

  /** Apply one pairwise verdict. Increments pairs_done + the appropriate
   *  outcome counter atomically. Caller maps "winner=a" → A wins (parent),
   *  "winner=b" → B wins (new fork), "winner=draw" → draws. */
  bumpPairResult(id: number, winner: PairwiseWinner): void {
    const aDelta = winner === "a" ? 1 : 0;
    const bDelta = winner === "b" ? 1 : 0;
    const dDelta = winner === "draw" ? 1 : 0;
    this.db.run(
      `UPDATE shadow_evaluations
       SET pairs_done = pairs_done + 1,
           a_wins = a_wins + ?,
           b_wins = b_wins + ?,
           draws = draws + ?
       WHERE id = ?`,
      [aDelta, bDelta, dDelta, id],
    );
  }

  /** Mark the evaluation complete with the final Wilson LB + decision. */
  complete(id: number, winRateLb: number, decision: ShadowEvalDecision): void {
    this.db.run(
      `UPDATE shadow_evaluations
       SET status = 'complete',
           win_rate_lb = ?,
           decision = ?,
           completed_at = unixepoch()
       WHERE id = ?`,
      [winRateLb, decision, id],
    );
  }

  fail(id: number, errorMessage: string): void {
    this.db.run(
      `UPDATE shadow_evaluations
       SET status = 'failed',
           error_message = ?,
           completed_at = unixepoch()
       WHERE id = ?`,
      [errorMessage, id],
    );
  }

  byId(id: number): ShadowEvalRow | null {
    return (
      this.db
        .query<ShadowEvalRow, [number]>(`SELECT * FROM shadow_evaluations WHERE id = ? LIMIT 1`)
        .get(id) ?? null
    );
  }

  /** Latest eval row for a given proposal (or null). UI polls this. */
  latestForProposal(proposalId: number): ShadowEvalRow | null {
    return (
      this.db
        .query<ShadowEvalRow, [number]>(
          `SELECT * FROM shadow_evaluations WHERE proposal_id = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(proposalId) ?? null
    );
  }
}
