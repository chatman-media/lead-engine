import type { Database } from "bun:sqlite";

/**
 * Operationally-mutable list of currently-open job offers, managed from
 * the admin UI. See migration 008 for the design rationale (fast-changing
 * data that should NOT live in the embedded KB).
 *
 * `is_active = 0` rows are kept (not deleted) so operators can re-enable
 * a previously-closed vacancy without re-typing it. Hard delete is also
 * supported for actual cleanup.
 */
export interface VacancyRow {
  id: number;
  title: string;
  body: string;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

export class VacanciesRepo {
  constructor(private db: Database) {}

  /** All active vacancies, freshest first. Used by the webhook on every
   *  inbound message to build the prompt block — keep it cheap. */
  listActive(): VacancyRow[] {
    return this.db
      .query<VacancyRow, []>(
        `SELECT * FROM vacancies WHERE is_active = 1 ORDER BY updated_at DESC`,
      )
      .all();
  }

  /** All vacancies, regardless of active state. Used by the admin list
   *  view — operators want to see closed ones too (to re-enable). */
  listAll(): VacancyRow[] {
    return this.db
      .query<VacancyRow, []>(
        `SELECT * FROM vacancies ORDER BY is_active DESC, updated_at DESC`,
      )
      .all();
  }

  byId(id: number): VacancyRow | null {
    return (
      this.db
        .query<VacancyRow, [number]>("SELECT * FROM vacancies WHERE id = ? LIMIT 1")
        .get(id) ?? null
    );
  }

  create(input: { title: string; body: string; isActive?: boolean }): VacancyRow {
    const isActive = input.isActive === false ? 0 : 1;
    const row = this.db
      .query<VacancyRow, [string, string, number]>(
        `INSERT INTO vacancies (title, body, is_active)
         VALUES (?, ?, ?) RETURNING *`,
      )
      .get(input.title.trim(), input.body.trim(), isActive);
    if (!row) throw new Error("Failed to insert vacancy");
    return row;
  }

  /**
   * Patches any subset of mutable fields. Always bumps `updated_at` so the
   * webhook's freshest-first ordering reflects the operator's edit.
   * Returns null when the row doesn't exist (UI handles 404).
   */
  update(
    id: number,
    patch: { title?: string; body?: string; isActive?: boolean },
  ): VacancyRow | null {
    const existing = this.byId(id);
    if (!existing) return null;
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    const body = patch.body !== undefined ? patch.body.trim() : existing.body;
    const isActive =
      patch.isActive === undefined
        ? existing.is_active
        : patch.isActive
          ? 1
          : 0;
    this.db.run(
      `UPDATE vacancies
       SET title = ?, body = ?, is_active = ?, updated_at = unixepoch()
       WHERE id = ?`,
      [title, body, isActive, id],
    );
    return this.byId(id);
  }

  /** Hard delete. Closed-but-archived vacancies are kept via is_active=0;
   *  this is for actual cleanup of mistaken entries. */
  delete(id: number): boolean {
    const res = this.db.run("DELETE FROM vacancies WHERE id = ?", [id]);
    return res.changes > 0;
  }

  countActive(): number {
    const r = this.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM vacancies WHERE is_active = 1",
      )
      .get();
    return r?.n ?? 0;
  }
}

/**
 * Render active vacancies into the prompt-friendly block prepended to
 * the RAG CONTEXT. Returns "" when no active vacancies — caller skips
 * adding the heading entirely. Exported separately so unit tests can
 * verify formatting without touching the DB.
 */
export function renderVacanciesBlock(vacancies: VacancyRow[]): string {
  const active = vacancies.filter((v) => v.is_active === 1);
  if (active.length === 0) return "";
  const items = active
    .map((v, i) => `[В${i + 1}] ${v.title}\n${v.body}`)
    .join("\n\n");
  return (
    `АКТУАЛЬНЫЕ ВАКАНСИИ (свежие, из админки — отвечай по ним в первую очередь):\n` +
    items
  );
}
