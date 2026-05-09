import type { Database } from "bun:sqlite";

import type { EloOutcome } from "../../sales/elo.ts";

/**
 * Persist + query self-play match transcripts. See migration 016 for
 * schema rationale. The repo is read-mostly: writes happen once per
 * match in the orchestrator's finalize step.
 */

export interface SelfPlayMatchRow {
  id: number;
  style_slug: string;
  persona_slug: string;
  outcome: EloOutcome;
  judge_reason: string | null;
  transcript_json: string;
  turns: number;
  skills_json: string;
  lead_id: number | null;
  created_at: number;
}

/** A summary row for the listing page — same shape as the table row but
 *  without the heavy transcript blob (saves bandwidth on the listing). */
export interface SelfPlayMatchSummary {
  id: number;
  style_slug: string;
  persona_slug: string;
  outcome: EloOutcome;
  judge_reason: string | null;
  turns: number;
  skills_count: number;
  lead_id: number | null;
  created_at: number;
}

export interface SelfPlayMatchDetail extends SelfPlayMatchRow {
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
  skills: string[];
}

export class SelfPlayMatchesRepo {
  constructor(private db: Database) {}

  insert(input: {
    styleSlug: string;
    personaSlug: string;
    outcome: EloOutcome;
    judgeReason: string | null;
    transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
    turns: number;
    skills: string[];
    leadId: number | null;
  }): SelfPlayMatchRow {
    const row = this.db
      .query<
        SelfPlayMatchRow,
        [string, string, string, string | null, string, number, string, number | null]
      >(
        `INSERT INTO self_play_matches
           (style_slug, persona_slug, outcome, judge_reason, transcript_json, turns, skills_json, lead_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.styleSlug,
        input.personaSlug,
        input.outcome,
        input.judgeReason,
        JSON.stringify(input.transcript),
        input.turns,
        JSON.stringify(input.skills),
        input.leadId,
      );
    if (!row) throw new Error("failed to insert self_play_match");
    return row;
  }

  /** Recent matches — listing page. Filters optional. */
  list(
    opts: { limit?: number; styleSlug?: string; personaSlug?: string; outcome?: EloOutcome } = {},
  ): SelfPlayMatchSummary[] {
    const wheres: string[] = [];
    const params: (string | number)[] = [];
    if (opts.styleSlug) {
      wheres.push("style_slug = ?");
      params.push(opts.styleSlug);
    }
    if (opts.personaSlug) {
      wheres.push("persona_slug = ?");
      params.push(opts.personaSlug);
    }
    if (opts.outcome) {
      wheres.push("outcome = ?");
      params.push(opts.outcome);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    params.push(limit);
    const rows = this.db
      .query<SelfPlayMatchRow, (string | number)[]>(
        `SELECT * FROM self_play_matches
         ${whereClause}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((r) => ({
      id: r.id,
      style_slug: r.style_slug,
      persona_slug: r.persona_slug,
      outcome: r.outcome,
      judge_reason: r.judge_reason,
      turns: r.turns,
      skills_count: parseSkills(r.skills_json).length,
      lead_id: r.lead_id,
      created_at: r.created_at,
    }));
  }

  /** Full match detail with parsed transcript + skills. Returns null when
   *  the row doesn't exist. */
  byId(id: number): SelfPlayMatchDetail | null {
    const row = this.db
      .query<SelfPlayMatchRow, [number]>(`SELECT * FROM self_play_matches WHERE id = ? LIMIT 1`)
      .get(id);
    if (!row) return null;
    return {
      ...row,
      transcript: parseTranscript(row.transcript_json),
      skills: parseSkills(row.skills_json),
    };
  }

  /** Aggregate win-rate per (style, persona). Used by the dashboard so
   *  operators can see which personas the style struggles with. */
  matrix(): Array<{
    style_slug: string;
    persona_slug: string;
    won: number;
    lost: number;
    draw: number;
    total: number;
  }> {
    return this.db
      .query<
        {
          style_slug: string;
          persona_slug: string;
          won: number;
          lost: number;
          draw: number;
          total: number;
        },
        []
      >(
        `SELECT style_slug, persona_slug,
                SUM(CASE WHEN outcome = 'won'  THEN 1 ELSE 0 END) AS won,
                SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END) AS lost,
                SUM(CASE WHEN outcome = 'draw' THEN 1 ELSE 0 END) AS draw,
                COUNT(*) AS total
         FROM self_play_matches
         GROUP BY style_slug, persona_slug
         ORDER BY style_slug, persona_slug`,
      )
      .all();
  }

  /** Total matches count — for empty-state messaging. */
  count(): number {
    const r = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM self_play_matches`).get();
    return r?.n ?? 0;
  }

  delete(id: number): boolean {
    const r = this.db.run(`DELETE FROM self_play_matches WHERE id = ?`, [id]);
    return r.changes > 0;
  }
}

function parseTranscript(raw: string): SelfPlayMatchDetail["transcript"] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is { role: "candidate" | "salesperson"; text: string } =>
        m &&
        typeof m === "object" &&
        (m.role === "candidate" || m.role === "salesperson") &&
        typeof m.text === "string",
    );
  } catch {
    return [];
  }
}

function parseSkills(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}
