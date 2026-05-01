import type { Database } from "bun:sqlite";

import { StyleSchema, type Style } from "../../sales/types.ts";

export interface StyleRow {
  id: number;
  slug: string;
  display_name: string;
  config_json: string;
  is_active: number; // SQLite has no boolean — 1/0
  version: number;
  parent_id: number | null;
  created_at: number;
}

/**
 * Repository for the `styles` table — the DB-backed registry for the sales
 * engine. Each row stores a full `Style` as JSON in `config_json`; we parse
 * it through the Zod schema on every read so a malformed row from a partial
 * admin-UI write fails loudly instead of poisoning the prompt downstream.
 */
export class StylesRepo {
  constructor(private db: Database) {}

  /** Decode a row's config_json through StyleSchema. Throws on malformed JSON
   *  or schema mismatch — callers should prefer `tryParse` when graceful
   *  degradation is desired (e.g. boot-time seed checks). */
  parseRow(row: StyleRow): Style {
    let raw: unknown;
    try {
      raw = JSON.parse(row.config_json);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`styles.id=${row.id} (slug=${row.slug}): config_json is not valid JSON — ${cause}`);
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

  byId(id: number): StyleRow | null {
    return (
      this.db
        .query<StyleRow, [number]>("SELECT * FROM styles WHERE id = ? LIMIT 1")
        .get(id) ?? null
    );
  }

  bySlug(slug: string): StyleRow | null {
    return (
      this.db
        .query<StyleRow, [string]>(
          "SELECT * FROM styles WHERE slug = ? AND is_active = 1 LIMIT 1",
        )
        .get(slug) ?? null
    );
  }

  /** All active styles, ordered by display name — useful for admin UI lists. */
  listActive(): StyleRow[] {
    return this.db
      .query<StyleRow, []>(
        "SELECT * FROM styles WHERE is_active = 1 ORDER BY display_name",
      )
      .all();
  }

  /**
   * Insert a new style. Throws on slug conflict (UNIQUE constraint) — caller
   * should either dedupe upstream or use `upsertBuiltin` for boot-time seeding.
   */
  insert(input: {
    slug: string;
    displayName: string;
    config: Style;
    version?: number;
    parentId?: number | null;
  }): StyleRow {
    const row = this.db
      .query<StyleRow, [string, string, string, number, number | null]>(
        `INSERT INTO styles (slug, display_name, config_json, version, parent_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.slug,
        input.displayName,
        JSON.stringify(input.config),
        input.version ?? 1,
        input.parentId ?? null,
      );
    if (!row) throw new Error(`Failed to insert style ${input.slug}`);
    return row;
  }

  /**
   * Idempotent boot-time seeder. If a row with `slug` already exists, do
   * nothing — admin's edits in the DB always win over hard-coded source.
   * Returns true if a new row was inserted, false if it was already present.
   */
  upsertBuiltin(style: Style): boolean {
    if (this.bySlug(style.slug)) return false;
    this.insert({
      slug: style.slug,
      displayName: style.displayName,
      config: style,
    });
    return true;
  }

  /** Soft-delete: mark inactive instead of removing. Conversations that
   *  reference this style_id continue working — the row is still readable. */
  deactivate(id: number): boolean {
    const res = this.db.run("UPDATE styles SET is_active = 0 WHERE id = ?", [id]);
    return res.changes > 0;
  }
}

/**
 * Boot-time seeder — call once after migrations. Inserts each built-in style
 * into the DB if its slug is missing. Edits in the DB persist; the seed is
 * a safety net for fresh installs / new deployments only.
 */
export function seedBuiltinStyles(repo: StylesRepo, builtins: readonly Style[]): {
  inserted: string[];
  skipped: string[];
} {
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const s of builtins) {
    if (repo.upsertBuiltin(s)) inserted.push(s.slug);
    else skipped.push(s.slug);
  }
  return { inserted, skipped };
}
