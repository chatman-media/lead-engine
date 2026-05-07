import type { Database } from "bun:sqlite";

import {
  SKILL_BY_SLUG,
  SKILL_CATALOGUE,
  type Skill,
  SkillSchema,
} from "../../sales/skills/catalogue.ts";

/**
 * SkillsRepo — CRUD over the skill catalogue, plus the M2M join with
 * styles. The catalogue itself is source-controlled in
 * `src/sales/skills/catalogue.ts`; this repo persists copies + per-style
 * attachments + the operator-toggleable `is_enabled` flag.
 */

export interface SkillRow {
  id: number;
  slug: string;
  family: string;
  display_name: string;
  description: string;
  prompt_fragment: string;
  applicable_stages_json: string;
  intent: string;
  is_enabled: 0 | 1;
  created_at: number;
  updated_at: number;
}

export class SkillsRepo {
  constructor(private db: Database) {}

  list(): SkillRow[] {
    return this.db
      .query<SkillRow, []>(`SELECT * FROM skills ORDER BY family ASC, display_name ASC`)
      .all();
  }

  listEnabled(): SkillRow[] {
    return this.db
      .query<SkillRow, []>(
        `SELECT * FROM skills WHERE is_enabled = 1 ORDER BY family ASC, display_name ASC`,
      )
      .all();
  }

  bySlug(slug: string): SkillRow | null {
    return (
      this.db.query<SkillRow, [string]>(`SELECT * FROM skills WHERE slug = ? LIMIT 1`).get(slug) ??
      null
    );
  }

  byId(id: number): SkillRow | null {
    return (
      this.db.query<SkillRow, [number]>(`SELECT * FROM skills WHERE id = ? LIMIT 1`).get(id) ?? null
    );
  }

  /**
   * Idempotent upsert from a Skill catalogue entry. On second call with
   * the same slug, copy fields are refreshed but `is_enabled` stays as
   * the operator left it. Returns the row (existing or newly inserted).
   */
  upsert(skill: Skill): SkillRow {
    const existing = this.bySlug(skill.slug);
    const stagesJson = JSON.stringify(skill.applicableStages);
    if (existing) {
      this.db.run(
        `UPDATE skills
         SET family = ?, display_name = ?, description = ?, prompt_fragment = ?,
             applicable_stages_json = ?, intent = ?, updated_at = unixepoch()
         WHERE id = ?`,
        [
          skill.family,
          skill.displayName,
          skill.description,
          skill.promptFragment,
          stagesJson,
          skill.intent,
          existing.id,
        ],
      );
      return this.byId(existing.id)!;
    }
    const row = this.db
      .query<SkillRow, [string, string, string, string, string, string, string]>(
        `INSERT INTO skills (slug, family, display_name, description, prompt_fragment, applicable_stages_json, intent)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        skill.slug,
        skill.family,
        skill.displayName,
        skill.description,
        skill.promptFragment,
        stagesJson,
        skill.intent,
      );
    if (!row) throw new Error(`failed to insert skill ${skill.slug}`);
    return row;
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const r = this.db.run(
      `UPDATE skills SET is_enabled = ?, updated_at = unixepoch() WHERE id = ?`,
      [enabled ? 1 : 0, id],
    );
    return r.changes > 0;
  }

  // ─── Style ↔ Skill membership ───────────────────────────────────

  /** Slugs of skills attached to this style (regardless of catalogue's
   *  enabled flag — caller filters at prompt-compose time). */
  skillsForStyle(styleId: number): SkillRow[] {
    return this.db
      .query<SkillRow, [number]>(
        `SELECT s.*
         FROM skills s
         JOIN style_skills ss ON ss.skill_id = s.id
         WHERE ss.style_id = ?
         ORDER BY s.family ASC, s.display_name ASC`,
      )
      .all(styleId);
  }

  /** Replace the set of skills attached to a style with a fresh slug list.
   *  Wraps in a transaction so partial failure leaves the join consistent. */
  setSkillsForStyle(styleId: number, slugs: string[]): { attached: number } {
    // Resolve slugs → ids upfront. Unknown slugs are silently dropped — the
    // caller (HTTP handler) is expected to validate them; this repo stays
    // forgiving so a stale UI doesn't 500 the request.
    const ids = slugs
      .map((slug) => this.bySlug(slug)?.id)
      .filter((id): id is number => typeof id === "number");
    const tx = this.db.transaction((styleIdInner: number, ids: number[]) => {
      this.db.run(`DELETE FROM style_skills WHERE style_id = ?`, [styleIdInner]);
      if (ids.length === 0) return;
      const stmt = this.db.prepare<unknown, [number, number]>(
        `INSERT INTO style_skills (style_id, skill_id) VALUES (?, ?)`,
      );
      for (const id of ids) stmt.run(styleIdInner, id);
    });
    tx(styleId, ids);
    return { attached: ids.length };
  }

  /** Counts of style attachments per skill — for the analytics dashboard. */
  attachmentCounts(): Map<string, number> {
    const rows = this.db
      .query<{ slug: string; n: number }, []>(
        `SELECT s.slug AS slug, COUNT(ss.style_id) AS n
         FROM skills s
         LEFT JOIN style_skills ss ON ss.skill_id = s.id
         GROUP BY s.id`,
      )
      .all();
    return new Map(rows.map((r) => [r.slug, r.n]));
  }
}

/**
 * Boot-time seeder: upserts every skill in the catalogue. Idempotent —
 * safe to call on every server start. Also validates each entry against
 * SkillSchema so a typo in catalogue.ts fails loudly at boot, not on
 * the first prompt that needs it.
 */
export function seedSkillCatalogue(repo: SkillsRepo): {
  inserted: number;
  updated: number;
} {
  let inserted = 0;
  let updated = 0;
  for (const raw of SKILL_CATALOGUE) {
    const skill = SkillSchema.parse(raw);
    const before = repo.bySlug(skill.slug);
    repo.upsert(skill);
    if (before) updated++;
    else inserted++;
  }
  // Defensive: warn if catalogue has dupe slugs at runtime (the Map
  // construction in catalogue.ts would already lose them, but this
  // makes the warning visible).
  if (SKILL_BY_SLUG.size !== SKILL_CATALOGUE.length) {
    console.warn(
      `[skills] duplicate slugs in catalogue: ${SKILL_CATALOGUE.length} entries → ${SKILL_BY_SLUG.size} unique`,
    );
  }
  return { inserted, updated };
}
