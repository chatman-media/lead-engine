import type { Database } from "bun:sqlite";

import { ELO_BASELINE, type EloOutcome, eloUpdate } from "../../sales/elo.ts";

/**
 * Phase 2 attribution + ratings storage. See migration 014 for schema
 * comments. This repo is read-mostly: writes happen on lead state
 * transitions to terminal states (and in the nightly stale-lead sweep);
 * reads power the /admin/skills win-rate column and the style-rating
 * dashboard.
 */

export interface SkillOutcomeRow {
  id: number;
  lead_id: number;
  conversation_id: number | null;
  message_id: number | null;
  style_slug: string | null;
  skill_slug: string;
  outcome: EloOutcome;
  source: "lead_submitted" | "lead_rejected" | "lead_ghosted" | "manual";
  created_at: number;
}

export interface SkillAggregate {
  skill_slug: string;
  count: number;
  wins: number;
  losses: number;
  draws: number;
  /** wins / count, 0..1. NaN when count == 0 — caller renders "—". */
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
  constructor(private db: Database) {}

  /**
   * Record a (skill, outcome) attribution. Idempotent on the
   * (lead_id, skill_slug, source) triple — re-running attribution after
   * a state hop won't double-count. Returns true if a fresh row was
   * actually inserted.
   */
  record(input: {
    leadId: number;
    conversationId: number | null;
    messageId: number | null;
    styleSlug: string | null;
    skillSlug: string;
    outcome: EloOutcome;
    source: SkillOutcomeRow["source"];
  }): boolean {
    const r = this.db.run(
      `INSERT INTO skill_outcomes
         (lead_id, conversation_id, message_id, style_slug, skill_slug, outcome, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (lead_id, skill_slug, source) DO NOTHING`,
      [
        input.leadId,
        input.conversationId,
        input.messageId,
        input.styleSlug,
        input.skillSlug,
        input.outcome,
        input.source,
      ],
    );
    return r.changes > 0;
  }

  /** Per-skill rollup over the full history (or a rolling window if
   *  `sinceUnix` is set). Used by /admin/skills + ranking dashboard. */
  aggregate(opts: { sinceUnix?: number } = {}): SkillAggregate[] {
    const since = opts.sinceUnix ?? 0;
    const rows = this.db
      .query<
        {
          skill_slug: string;
          count: number;
          wins: number;
          losses: number;
          draws: number;
        },
        [number]
      >(
        `SELECT skill_slug,
                COUNT(*) AS count,
                SUM(CASE WHEN outcome = 'won'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN outcome = 'draw' THEN 1 ELSE 0 END) AS draws
         FROM skill_outcomes
         WHERE created_at >= ?
         GROUP BY skill_slug
         ORDER BY count DESC`,
      )
      .all(since);
    return rows.map((r) => ({
      ...r,
      win_rate: r.count > 0 ? r.wins / r.count : Number.NaN,
    }));
  }

  /** Last N events (debug / admin-page event feed). */
  recent(limit = 50): SkillOutcomeRow[] {
    return this.db
      .query<SkillOutcomeRow, [number]>(`SELECT * FROM skill_outcomes ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }
}

export class StyleRatingsRepo {
  constructor(private db: Database) {}

  bySlug(slug: string): StyleRatingRow | null {
    return (
      this.db
        .query<StyleRatingRow, [string]>(`SELECT * FROM style_ratings WHERE style_slug = ? LIMIT 1`)
        .get(slug) ?? null
    );
  }

  list(): StyleRatingRow[] {
    return this.db
      .query<StyleRatingRow, []>(`SELECT * FROM style_ratings ORDER BY elo DESC, wins DESC`)
      .all();
  }

  /**
   * Apply one outcome to the style's ELO + W/L/D counters. Inserts a
   * fresh row at baseline ELO if the slug hasn't been seen yet. Returns
   * the after-update row.
   */
  applyOutcome(
    slug: string,
    outcome: EloOutcome,
    opts: { k?: number; opponentRating?: number } = {},
  ): StyleRatingRow {
    const existing = this.bySlug(slug);
    const currentElo = existing?.elo ?? ELO_BASELINE;
    const newElo = eloUpdate(currentElo, outcome, opts);
    const dW = outcome === "won" ? 1 : 0;
    const dL = outcome === "lost" ? 1 : 0;
    const dD = outcome === "draw" ? 1 : 0;
    if (existing) {
      this.db.run(
        `UPDATE style_ratings
         SET elo = ?,
             wins = wins + ?,
             losses = losses + ?,
             draws = draws + ?,
             last_outcome_at = unixepoch(),
             updated_at = unixepoch()
         WHERE style_slug = ?`,
        [newElo, dW, dL, dD, slug],
      );
    } else {
      this.db.run(
        `INSERT INTO style_ratings
           (style_slug, elo, wins, losses, draws, last_outcome_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())`,
        [slug, newElo, dW, dL, dD],
      );
    }
    return this.bySlug(slug)!;
  }

  /** Reset a style's record. Useful when re-running attribution from
   *  scratch on historical data. Does NOT delete skill_outcomes. */
  reset(slug: string): void {
    this.db.run(
      `INSERT INTO style_ratings (style_slug)
       VALUES (?)
       ON CONFLICT(style_slug) DO UPDATE SET
         elo = ${ELO_BASELINE},
         wins = 0, losses = 0, draws = 0,
         last_outcome_at = NULL,
         updated_at = unixepoch()`,
      [slug],
    );
  }
}
