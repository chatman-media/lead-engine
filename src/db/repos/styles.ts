import { type Style, StyleSchema } from "../../sales/types.ts";
import type { Sql } from "../postgres.ts";

export interface StyleRow {
  id: number;
  slug: string;
  display_name: string;
  config_json: string;
  is_active: boolean;
  version: number;
  parent_id: number | null;
  created_at: number;
  deleted_at: number | null;
}

export class StylesRepo {
  constructor(private sql: Sql) {}

  parseRow(row: StyleRow): Style {
    let raw: unknown;
    try {
      raw = JSON.parse(row.config_json);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `styles.id=${row.id} (slug=${row.slug}): config_json is not valid JSON — ${cause}`,
      );
    }
    const result = StyleSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `styles.id=${row.id} (slug=${row.slug}): config_json fails StyleSchema:\n` +
          result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    }
    return result.data;
  }

  async byId(id: number): Promise<StyleRow | null> {
    const [row] = await this.sql<StyleRow[]>`
      SELECT * FROM styles WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async bySlug(slug: string): Promise<StyleRow | null> {
    const [row] = await this.sql<StyleRow[]>`
      SELECT * FROM styles WHERE slug = ${slug} AND is_active = TRUE LIMIT 1
    `;
    return row ?? null;
  }

  async listActive(): Promise<StyleRow[]> {
    return this.sql<StyleRow[]>`
      SELECT * FROM styles WHERE is_active = TRUE ORDER BY display_name
    `;
  }

  async insert(input: {
    slug: string;
    displayName: string;
    config: Style;
    version?: number;
    parentId?: number | null;
  }): Promise<StyleRow> {
    const [row] = await this.sql<StyleRow[]>`
      INSERT INTO styles (slug, display_name, config_json, version, parent_id)
      VALUES (${input.slug}, ${input.displayName}, ${JSON.stringify(input.config)}, ${input.version ?? 1}, ${input.parentId ?? null})
      RETURNING *
    `;
    if (!row) throw new Error(`Failed to insert style ${input.slug}`);
    return row;
  }

  async upsertBuiltin(style: Style): Promise<"inserted" | "updated" | "skipped"> {
    const existing = await this.bySlug(style.slug);
    if (!existing) {
      await this.insert({ slug: style.slug, displayName: style.displayName, config: style });
      return "inserted";
    }
    const newJson = JSON.stringify(style);
    if (existing.config_json === newJson) return "skipped";
    await this.sql`
      UPDATE styles SET config_json = ${newJson} WHERE slug = ${style.slug} AND is_active = TRUE
    `;
    return "updated";
  }

  /**
   * Operator-initiated removal. Sets `deleted_at` AND `is_active = FALSE` so
   * the row stops appearing in `listActive` / `bySlug` and the slug becomes
   * reusable. Distinguished from version-chain succession (which only flips
   * `is_active = FALSE`) by the populated timestamp. Historical versions in
   * the same chain are left alone — `byId` still returns them so pinned
   * conversations keep working, and `versionHistory` still surfaces the
   * whole audit trail.
   */
  async softDelete(id: number): Promise<boolean> {
    const result = await this.sql`
      UPDATE styles
      SET is_active = FALSE,
          deleted_at = EXTRACT(EPOCH FROM NOW())::INTEGER
      WHERE id = ${id}
    `;
    return result.count > 0;
  }

  async editAsNewVersion(currentId: number, newConfig: Style): Promise<StyleRow> {
    const current = await this.byId(currentId);
    if (!current) {
      throw new Error(`styles.id=${currentId} not found`);
    }
    if (!current.is_active) {
      throw new Error(
        `styles.id=${currentId} (slug=${current.slug}) is not active — refusing to fork from a historical version. Edit the current active version instead.`,
      );
    }
    if (newConfig.slug !== current.slug) {
      throw new Error(
        `slug mismatch: current row has "${current.slug}" but new config has "${newConfig.slug}" — slug is immutable across the version chain`,
      );
    }

    const [inserted] = await this.sql.begin(async (sql) => {
      await sql`UPDATE styles SET is_active = FALSE WHERE id = ${currentId}`;
      return sql<StyleRow[]>`
        INSERT INTO styles (slug, display_name, config_json, version, parent_id)
        VALUES (${current.slug}, ${newConfig.displayName}, ${JSON.stringify(newConfig)}, ${current.version + 1}, ${currentId})
        RETURNING *
      `;
    });
    if (!inserted) throw new Error("editAsNewVersion: INSERT returned no row");
    return inserted;
  }

  async versionHistory(slug: string): Promise<StyleRow[]> {
    return this.sql<StyleRow[]>`
      SELECT * FROM styles WHERE slug = ${slug} ORDER BY version ASC
    `;
  }
}

export async function seedBuiltinStyles(
  repo: StylesRepo,
  builtins: readonly Style[],
): Promise<{
  inserted: string[];
  updated: string[];
  skipped: string[];
}> {
  const inserted: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const s of builtins) {
    const r = await repo.upsertBuiltin(s);
    if (r === "inserted") inserted.push(s.slug);
    else if (r === "updated") updated.push(s.slug);
    else skipped.push(s.slug);
  }
  return { inserted, updated, skipped };
}
