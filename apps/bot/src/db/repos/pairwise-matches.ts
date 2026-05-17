import type { PairwiseWinner } from "../../sales/self-play/pairwise.ts";
import type { Sql } from "../postgres.ts";

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
  constructor(private sql: Sql) {}

  async insert(input: {
    styleASlug: string;
    styleBSlug: string;
    personaSlug: string;
    winner: PairwiseWinner;
    judgeReason: string | null;
    matchAId: number | null;
    matchBId: number | null;
    eloAAfter: number;
    eloBAfter: number;
  }): Promise<PairwiseMatchRow> {
    const [row] = await this.sql<PairwiseMatchRow[]>`
      INSERT INTO pairwise_matches
        (style_a_slug, style_b_slug, persona_slug, winner, judge_reason,
         match_a_id, match_b_id, elo_a_after, elo_b_after)
      VALUES (${input.styleASlug}, ${input.styleBSlug}, ${input.personaSlug}, ${input.winner},
              ${input.judgeReason}, ${input.matchAId}, ${input.matchBId}, ${input.eloAAfter}, ${input.eloBAfter})
      RETURNING *
    `;
    if (!row) throw new Error("failed to insert pairwise_match");
    return row;
  }

  async list(
    opts: {
      limit?: number;
      styleASlug?: string;
      styleBSlug?: string;
      personaSlug?: string;
      winner?: PairwiseWinner;
    } = {},
  ): Promise<PairwiseMatchSummary[]> {
    const limit = opts.limit ?? 100;
    // Build filter combinations
    if (opts.styleASlug && opts.styleBSlug && opts.personaSlug && opts.winner) {
      return this.sql<PairwiseMatchRow[]>`
        SELECT * FROM pairwise_matches
        WHERE style_a_slug = ${opts.styleASlug} AND style_b_slug = ${opts.styleBSlug}
          AND persona_slug = ${opts.personaSlug} AND winner = ${opts.winner}
        ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.styleASlug && opts.styleBSlug) {
      return this.sql<PairwiseMatchRow[]>`
        SELECT * FROM pairwise_matches
        WHERE style_a_slug = ${opts.styleASlug} AND style_b_slug = ${opts.styleBSlug}
        ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.styleASlug) {
      return this.sql<PairwiseMatchRow[]>`
        SELECT * FROM pairwise_matches WHERE style_a_slug = ${opts.styleASlug} ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.styleBSlug) {
      return this.sql<PairwiseMatchRow[]>`
        SELECT * FROM pairwise_matches WHERE style_b_slug = ${opts.styleBSlug} ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.personaSlug) {
      return this.sql<PairwiseMatchRow[]>`
        SELECT * FROM pairwise_matches WHERE persona_slug = ${opts.personaSlug} ORDER BY id DESC LIMIT ${limit}
      `;
    }
    if (opts.winner) {
      return this.sql<PairwiseMatchRow[]>`
        SELECT * FROM pairwise_matches WHERE winner = ${opts.winner} ORDER BY id DESC LIMIT ${limit}
      `;
    }
    return this.sql<PairwiseMatchRow[]>`
      SELECT * FROM pairwise_matches ORDER BY id DESC LIMIT ${limit}
    `;
  }

  async byId(id: number): Promise<PairwiseMatchRow | null> {
    const [row] = await this.sql<PairwiseMatchRow[]>`
      SELECT * FROM pairwise_matches WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async matrix(): Promise<PairwiseMatchAggRow[]> {
    return this.sql<PairwiseMatchAggRow[]>`
      SELECT style_a_slug, style_b_slug,
             SUM(CASE WHEN winner = 'a'    THEN 1 ELSE 0 END)::INTEGER AS a_wins,
             SUM(CASE WHEN winner = 'b'    THEN 1 ELSE 0 END)::INTEGER AS b_wins,
             SUM(CASE WHEN winner = 'draw' THEN 1 ELSE 0 END)::INTEGER AS draws,
             COUNT(*)::INTEGER AS total
      FROM pairwise_matches
      GROUP BY style_a_slug, style_b_slug
      ORDER BY style_a_slug, style_b_slug
    `;
  }

  async count(): Promise<number> {
    const [r] = await this.sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM pairwise_matches`;
    return r?.n ?? 0;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM pairwise_matches WHERE id = ${id}`;
    return result.count > 0;
  }
}
