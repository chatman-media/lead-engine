import { ELO_BASELINE, type EloOutcome, eloUpdate } from "../../sales/elo.ts";
import type { Sql } from "../postgres.ts";

export interface SkillOutcomeRow {
  id: number;
  lead_id: number;
  conversation_id: number | null;
  message_id: number | null;
  style_slug: string | null;
  skill_slug: string;
  outcome: EloOutcome;
  source: "lead_submitted" | "lead_rejected" | "lead_ghosted" | "manual" | "self_play";
  created_at: number;
}

export interface SkillAggregate {
  skill_slug: string;
  count: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
}

export interface StyleRatingRow {
  style_slug: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  last_outcome_at: number | null;
  updated_at: number;
}

export class SkillOutcomesRepo {
  constructor(private sql: Sql) {}

  async record(input: {
    leadId: number;
    conversationId: number | null;
    messageId: number | null;
    styleSlug: string | null;
    skillSlug: string;
    outcome: EloOutcome;
    source: SkillOutcomeRow["source"];
  }): Promise<boolean> {
    const result = await this.sql`
      INSERT INTO skill_outcomes
        (lead_id, conversation_id, message_id, style_slug, skill_slug, outcome, source)
      VALUES (${input.leadId}, ${input.conversationId}, ${input.messageId}, ${input.styleSlug}, ${input.skillSlug}, ${input.outcome}, ${input.source})
      ON CONFLICT (lead_id, skill_slug, source) DO NOTHING
    `;
    return result.count > 0;
  }

  async aggregate(opts: { sinceUnix?: number } = {}): Promise<SkillAggregate[]> {
    const since = opts.sinceUnix ?? 0;
    const rows = await this.sql<
      {
        skill_slug: string;
        count: number;
        wins: number;
        losses: number;
        draws: number;
      }[]
    >`
      SELECT skill_slug,
             COUNT(*)::INTEGER AS count,
             SUM(CASE WHEN outcome = 'won'  THEN 1 ELSE 0 END)::INTEGER AS wins,
             SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END)::INTEGER AS losses,
             SUM(CASE WHEN outcome = 'draw' THEN 1 ELSE 0 END)::INTEGER AS draws
      FROM skill_outcomes
      WHERE created_at >= ${since}
      GROUP BY skill_slug
      ORDER BY count DESC
    `;
    return rows.map((r) => ({
      ...r,
      win_rate: r.count > 0 ? r.wins / r.count : Number.NaN,
    }));
  }

  async recent(limit = 50): Promise<SkillOutcomeRow[]> {
    return this.sql<SkillOutcomeRow[]>`
      SELECT * FROM skill_outcomes ORDER BY id DESC LIMIT ${limit}
    `;
  }
}

export class StyleRatingsRepo {
  constructor(private sql: Sql) {}

  async bySlug(slug: string): Promise<StyleRatingRow | null> {
    const [row] = await this.sql<StyleRatingRow[]>`
      SELECT * FROM style_ratings WHERE style_slug = ${slug} LIMIT 1
    `;
    return row ?? null;
  }

  async list(): Promise<StyleRatingRow[]> {
    return this.sql<StyleRatingRow[]>`
      SELECT * FROM style_ratings ORDER BY elo DESC, wins DESC
    `;
  }

  async applyOutcome(
    slug: string,
    outcome: EloOutcome,
    opts: { k?: number; opponentRating?: number } = {},
  ): Promise<StyleRatingRow> {
    const existing = await this.bySlug(slug);
    const currentElo = existing?.elo ?? ELO_BASELINE;
    const newElo = eloUpdate(currentElo, outcome, opts);
    const dW = outcome === "won" ? 1 : 0;
    const dL = outcome === "lost" ? 1 : 0;
    const dD = outcome === "draw" ? 1 : 0;
    if (existing) {
      await this.sql`
        UPDATE style_ratings
        SET elo = ${newElo},
            wins = wins + ${dW},
            losses = losses + ${dL},
            draws = draws + ${dD},
            last_outcome_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
            updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE style_slug = ${slug}
      `;
    } else {
      await this.sql`
        INSERT INTO style_ratings (style_slug, elo, wins, losses, draws, last_outcome_at)
        VALUES (${slug}, ${newElo}, ${dW}, ${dL}, ${dD}, EXTRACT(EPOCH FROM NOW())::INTEGER)
      `;
    }
    return (await this.bySlug(slug))!;
  }

  /** Directly set the ELO for a style (used by pairwise to persist precomputed values). */
  async setElo(slug: string, elo: number): Promise<void> {
    await this.sql`
      INSERT INTO style_ratings (style_slug, elo, wins, losses, draws, last_outcome_at)
      VALUES (${slug}, ${elo}, 0, 0, 0, EXTRACT(EPOCH FROM NOW())::INTEGER)
      ON CONFLICT (style_slug) DO UPDATE SET
        elo = ${elo},
        last_outcome_at = EXTRACT(EPOCH FROM NOW())::INTEGER,
        updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
    `;
  }

  async reset(slug: string): Promise<void> {
    await this.sql`
      INSERT INTO style_ratings (style_slug, elo, wins, losses, draws, last_outcome_at, updated_at)
      VALUES (${slug}, ${ELO_BASELINE}, 0, 0, 0, NULL, EXTRACT(EPOCH FROM NOW())::INTEGER)
      ON CONFLICT (style_slug) DO UPDATE SET
        elo = ${ELO_BASELINE},
        wins = 0, losses = 0, draws = 0,
        last_outcome_at = NULL,
        updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
    `;
  }
}
