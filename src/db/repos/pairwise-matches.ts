/**
 * Pairwise match persistence. See migration 018 for schema. Same
 * read-mostly pattern as `self-play-matches.ts` — writes happen once
 * per pair, reads are dashboard queries.
 */
import type { Database } from "bun:sqlite";

import type { PairwiseWinner } from "../../sales/self-play/pairwise.ts";

export interface PairwiseMatchRow {
  id: number;
  style_a_slug: string;
  style_b_slug: string;
  persona_slug: string;
  winner: PairwiseWinner;
  judge_reason: string | null;
  match_a_id: number | null;
  match_b_id: number | null;
  elo_a_after: number;
  elo_b_after: number;
  created_at: number;
}

export interface PairwiseMatchSummary extends PairwiseMatchRow {}

export interface PairwiseMatchAggRow {
  style_a_slug: string;
  style_b_slug: string;
  a_wins: number;
  b_wins: number;
  draws: number;
  total: number;
}

export class PairwiseMatchesRepo {
  constructor(private db: Database) {}

  insert(input: {
    styleASlug: string;
    styleBSlug: string;
    personaSlug: string;
    winner: PairwiseWinner;
    judgeReason: string | null;
    matchAId: number | null;
    matchBId: number | null;
    eloAAfter: number;
    eloBAfter: number;
  }): PairwiseMatchRow {
    const row = this.db
      .query<
        PairwiseMatchRow,
        [
          string,
          string,
          string,
          string,
          string | null,
          number | null,
          number | null,
          number,
          number,
        ]
      >(
        `INSERT INTO pairwise_matches
           (style_a_slug, style_b_slug, persona_slug, winner, judge_reason,
            match_a_id, match_b_id, elo_a_after, elo_b_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.styleASlug,
        input.styleBSlug,
        input.personaSlug,
        input.winner,
        input.judgeReason,
        input.matchAId,
        input.matchBId,
        input.eloAAfter,
        input.eloBAfter,
      );
    if (!row) throw new Error("failed to insert pairwise_match");
    return row;
  }

  list(
    opts: {
      limit?: number;
      styleASlug?: string;
      styleBSlug?: string;
      personaSlug?: string;
      winner?: PairwiseWinner;
    } = {},
  ): PairwiseMatchSummary[] {
    const wheres: string[] = [];
    const params: (string | number)[] = [];
    if (opts.styleASlug) {
      wheres.push("style_a_slug = ?");
      params.push(opts.styleASlug);
    }
    if (opts.styleBSlug) {
      wheres.push("style_b_slug = ?");
      params.push(opts.styleBSlug);
    }
    if (opts.personaSlug) {
      wheres.push("persona_slug = ?");
      params.push(opts.personaSlug);
    }
    if (opts.winner) {
      wheres.push("winner = ?");
      params.push(opts.winner);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    params.push(limit);
    return this.db
      .query<PairwiseMatchRow, (string | number)[]>(
        `SELECT * FROM pairwise_matches
         ${whereClause}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...params);
  }

  byId(id: number): PairwiseMatchRow | null {
    return (
      this.db
        .query<PairwiseMatchRow, [number]>(`SELECT * FROM pairwise_matches WHERE id = ? LIMIT 1`)
        .get(id) ?? null
    );
  }

  /** Aggregate head-to-head outcomes for the dashboard table.
   *  Note: a row "(A=alina, B=flirty)" and "(A=flirty, B=alina)" are
   *  separate buckets — caller decides whether to symmetrize them. */
  matrix(): PairwiseMatchAggRow[] {
    return this.db
      .query<PairwiseMatchAggRow, []>(
        `SELECT style_a_slug, style_b_slug,
                SUM(CASE WHEN winner = 'a'    THEN 1 ELSE 0 END) AS a_wins,
                SUM(CASE WHEN winner = 'b'    THEN 1 ELSE 0 END) AS b_wins,
                SUM(CASE WHEN winner = 'draw' THEN 1 ELSE 0 END) AS draws,
                COUNT(*) AS total
         FROM pairwise_matches
         GROUP BY style_a_slug, style_b_slug
         ORDER BY style_a_slug, style_b_slug`,
      )
      .all();
  }

  count(): number {
    const r = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM pairwise_matches`).get();
    return r?.n ?? 0;
  }

  delete(id: number): boolean {
    const r = this.db.run(`DELETE FROM pairwise_matches WHERE id = ?`, [id]);
    return r.changes > 0;
  }
}
