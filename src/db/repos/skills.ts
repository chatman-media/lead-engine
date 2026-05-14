import {
  SKILL_BY_SLUG,
  SKILL_CATALOGUE,
  type Skill,
  SkillSchema,
} from "../../sales/skills/catalogue.ts";
import type { Sql } from "../postgres.ts";

export interface SkillRow {
  id: number;
  slug: string;
  family: string;
  display_name: string;
  description: string;
  prompt_fragment: string;
  applicable_stages_json: string;
  intent: string;
  is_enabled: boolean;
  created_at: number;
  updated_at: number;
}

export class SkillsRepo {
  constructor(private sql: Sql) {}

  async list(): Promise<SkillRow[]> {
    return this.sql<SkillRow[]>`
      SELECT * FROM skills ORDER BY family ASC, display_name ASC
    `;
  }

  async listEnabled(): Promise<SkillRow[]> {
    return this.sql<SkillRow[]>`
      SELECT * FROM skills WHERE is_enabled = TRUE ORDER BY family ASC, display_name ASC
    `;
  }

  async bySlug(slug: string): Promise<SkillRow | null> {
    const [row] = await this.sql<SkillRow[]>`
      SELECT * FROM skills WHERE slug = ${slug} LIMIT 1
    `;
    return row ?? null;
  }

  async byId(id: number): Promise<SkillRow | null> {
    const [row] = await this.sql<SkillRow[]>`
      SELECT * FROM skills WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async upsert(skill: Skill): Promise<SkillRow> {
    const existing = await this.bySlug(skill.slug);
    const stagesJson = JSON.stringify(skill.applicableStages);
    if (existing) {
      await this.sql`
        UPDATE skills
        SET family = ${skill.family}, display_name = ${skill.displayName}, description = ${skill.description},
            prompt_fragment = ${skill.promptFragment}, applicable_stages_json = ${stagesJson},
            intent = ${skill.intent}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE id = ${existing.id}
      `;
      return (await this.byId(existing.id))!;
    }
    const [row] = await this.sql<SkillRow[]>`
      INSERT INTO skills (slug, family, display_name, description, prompt_fragment, applicable_stages_json, intent)
      VALUES (${skill.slug}, ${skill.family}, ${skill.displayName}, ${skill.description}, ${skill.promptFragment}, ${stagesJson}, ${skill.intent})
      RETURNING *
    `;
    if (!row) throw new Error(`failed to insert skill ${skill.slug}`);
    return row;
  }

  async setEnabled(id: number, enabled: boolean): Promise<boolean> {
    const result = await this.sql`
      UPDATE skills SET is_enabled = ${enabled}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
    return result.count > 0;
  }

  async skillsForStyle(styleId: number): Promise<SkillRow[]> {
    return this.sql<SkillRow[]>`
      SELECT s.*
      FROM skills s
      JOIN style_skills ss ON ss.skill_id = s.id
      WHERE ss.style_id = ${styleId}
      ORDER BY s.family ASC, s.display_name ASC
    `;
  }

  async setSkillsForStyle(styleId: number, slugs: string[]): Promise<{ attached: number }> {
    // Resolve slugs → ids upfront
    const ids: number[] = [];
    for (const slug of slugs) {
      const row = await this.bySlug(slug);
      if (row) ids.push(row.id);
    }

    await this.sql.begin(async (sql) => {
      await sql`DELETE FROM style_skills WHERE style_id = ${styleId}`;
      if (ids.length === 0) return;
      for (const id of ids) {
        await sql`INSERT INTO style_skills (style_id, skill_id) VALUES (${styleId}, ${id})`;
      }
    });
    return { attached: ids.length };
  }

  async attachmentCounts(): Promise<Map<string, number>> {
    const rows = await this.sql<{ slug: string; n: number }[]>`
      SELECT s.slug AS slug, COUNT(ss.style_id)::INTEGER AS n
      FROM skills s
      LEFT JOIN style_skills ss ON ss.skill_id = s.id
      GROUP BY s.id, s.slug
    `;
    return new Map(rows.map((r) => [r.slug, r.n]));
  }
}

export async function seedSkillCatalogue(repo: SkillsRepo): Promise<{
  inserted: number;
  updated: number;
}> {
  let inserted = 0;
  let updated = 0;
  for (const raw of SKILL_CATALOGUE) {
    const skill = SkillSchema.parse(raw);
    const before = await repo.bySlug(skill.slug);
    await repo.upsert(skill);
    if (before) updated++;
    else inserted++;
  }
  if (SKILL_BY_SLUG.size !== SKILL_CATALOGUE.length) {
    console.warn(
      `[skills] duplicate slugs in catalogue: ${SKILL_CATALOGUE.length} entries → ${SKILL_BY_SLUG.size} unique`,
    );
  }
  return { inserted, updated };
}
