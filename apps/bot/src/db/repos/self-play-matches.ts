import type { EloOutcome } from "../../sales/elo.ts";
import type { Sql } from "../postgres.ts";

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
  fabrications_caught: number;
  created_at: number;
}

export interface SelfPlayMatchSummary {
  id: number;
  style_slug: string;
  persona_slug: string;
  outcome: EloOutcome;
  judge_reason: string | null;
  turns: number;
  skills_count: number;
  lead_id: number | null;
  fabrications_caught: number;
  created_at: number;
}

export interface SelfPlayMatchDetail extends SelfPlayMatchRow {
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
  skills: string[];
}

export class SelfPlayMatchesRepo {
  constructor(private sql: Sql) {}

  async insert(input: {
    styleSlug: string;
    personaSlug: string;
    outcome: EloOutcome;
    judgeReason: string | null;
    transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
    turns: number;
    skills: string[];
    leadId: number | null;
    fabricationsCaught?: number;
  }): Promise<SelfPlayMatchRow> {
    const [row] = await this.sql<SelfPlayMatchRow[]>`
      INSERT INTO self_play_matches
        (style_slug, persona_slug, outcome, judge_reason, transcript_json, turns, skills_json, lead_id, fabrications_caught)
      VALUES (${input.styleSlug}, ${input.personaSlug}, ${input.outcome}, ${input.judgeReason},
              ${JSON.stringify(input.transcript)}, ${input.turns}, ${JSON.stringify(input.skills)},
              ${input.leadId}, ${input.fabricationsCaught ?? 0})
      RETURNING *
    `;
    if (!row) throw new Error("failed to insert self_play_match");
    return row;
  }

  async list(
    opts: { limit?: number; styleSlug?: string; personaSlug?: string; outcome?: EloOutcome } = {},
  ): Promise<SelfPlayMatchSummary[]> {
    let rows: SelfPlayMatchRow[];
    const limit = opts.limit ?? 100;

    if (opts.styleSlug && opts.personaSlug && opts.outcome) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches
        WHERE style_slug = ${opts.styleSlug} AND persona_slug = ${opts.personaSlug} AND outcome = ${opts.outcome}
        ORDER BY id DESC LIMIT ${limit}
      `;
    } else if (opts.styleSlug && opts.personaSlug) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches
        WHERE style_slug = ${opts.styleSlug} AND persona_slug = ${opts.personaSlug}
        ORDER BY id DESC LIMIT ${limit}
      `;
    } else if (opts.styleSlug && opts.outcome) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches
        WHERE style_slug = ${opts.styleSlug} AND outcome = ${opts.outcome}
        ORDER BY id DESC LIMIT ${limit}
      `;
    } else if (opts.personaSlug && opts.outcome) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches
        WHERE persona_slug = ${opts.personaSlug} AND outcome = ${opts.outcome}
        ORDER BY id DESC LIMIT ${limit}
      `;
    } else if (opts.styleSlug) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches WHERE style_slug = ${opts.styleSlug} ORDER BY id DESC LIMIT ${limit}
      `;
    } else if (opts.personaSlug) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches WHERE persona_slug = ${opts.personaSlug} ORDER BY id DESC LIMIT ${limit}
      `;
    } else if (opts.outcome) {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches WHERE outcome = ${opts.outcome} ORDER BY id DESC LIMIT ${limit}
      `;
    } else {
      rows = await this.sql<SelfPlayMatchRow[]>`
        SELECT * FROM self_play_matches ORDER BY id DESC LIMIT ${limit}
      `;
    }

    return rows.map((r) => ({
      id: r.id,
      style_slug: r.style_slug,
      persona_slug: r.persona_slug,
      outcome: r.outcome,
      judge_reason: r.judge_reason,
      turns: r.turns,
      skills_count: parseSkills(r.skills_json).length,
      lead_id: r.lead_id,
      fabrications_caught: r.fabrications_caught ?? 0,
      created_at: r.created_at,
    }));
  }

  async byId(id: number): Promise<SelfPlayMatchDetail | null> {
    const [row] = await this.sql<SelfPlayMatchRow[]>`
      SELECT * FROM self_play_matches WHERE id = ${id} LIMIT 1
    `;
    if (!row) return null;
    return {
      ...row,
      transcript: parseTranscript(row.transcript_json),
      skills: parseSkills(row.skills_json),
    };
  }

  async matrix(): Promise<
    Array<{
      style_slug: string;
      persona_slug: string;
      won: number;
      lost: number;
      draw: number;
      total: number;
    }>
  > {
    return this.sql<
      {
        style_slug: string;
        persona_slug: string;
        won: number;
        lost: number;
        draw: number;
        total: number;
      }[]
    >`
      SELECT style_slug, persona_slug,
             SUM(CASE WHEN outcome = 'won'  THEN 1 ELSE 0 END)::INTEGER AS won,
             SUM(CASE WHEN outcome = 'lost' THEN 1 ELSE 0 END)::INTEGER AS lost,
             SUM(CASE WHEN outcome = 'draw' THEN 1 ELSE 0 END)::INTEGER AS draw,
             COUNT(*)::INTEGER AS total
      FROM self_play_matches
      GROUP BY style_slug, persona_slug
      ORDER BY style_slug, persona_slug
    `;
  }

  async count(): Promise<number> {
    const [r] = await this.sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM self_play_matches`;
    return r?.n ?? 0;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.sql`DELETE FROM self_play_matches WHERE id = ${id}`;
    return result.count > 0;
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
