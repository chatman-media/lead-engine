import type { Database } from "bun:sqlite";

import type { Experiment } from "../../sales/ab-router.ts";

export type ExperimentStatus = "draft" | "running" | "paused" | "done";
export type SuccessMetric = "qualified" | "won" | "replied_3+";

export interface ExperimentRow {
  id: number;
  slug: string;
  status: ExperimentStatus;
  /** JSON object: {styleSlug: weight}. Validated by `parseAllocation`. */
  allocation_json: string;
  success_metric: SuccessMetric;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/**
 * Repository for the `experiments` table. At most one row should be in
 * status='running' at any time — `getRunning()` enforces by returning the
 * most recent one if there's accidental overlap.
 */
export class ExperimentsRepo {
  constructor(private db: Database) {}

  byId(id: number): ExperimentRow | null {
    return (
      this.db
        .query<ExperimentRow, [number]>("SELECT * FROM experiments WHERE id = ? LIMIT 1")
        .get(id) ?? null
    );
  }

  bySlug(slug: string): ExperimentRow | null {
    return (
      this.db
        .query<ExperimentRow, [string]>("SELECT * FROM experiments WHERE slug = ? LIMIT 1")
        .get(slug) ?? null
    );
  }

  /** Returns the most-recently-started running experiment, or null. */
  getRunning(): ExperimentRow | null {
    return (
      this.db
        .query<ExperimentRow, []>(
          `SELECT * FROM experiments
           WHERE status = 'running'
           ORDER BY started_at DESC NULLS LAST, id DESC
           LIMIT 1`,
        )
        .get() ?? null
    );
  }

  list(opts: { status?: ExperimentStatus } = {}): ExperimentRow[] {
    if (opts.status) {
      return this.db
        .query<ExperimentRow, [ExperimentStatus]>(
          "SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC",
        )
        .all(opts.status);
    }
    return this.db
      .query<ExperimentRow, []>(
        "SELECT * FROM experiments ORDER BY created_at DESC",
      )
      .all();
  }

  insert(input: {
    slug: string;
    status?: ExperimentStatus;
    allocation: Record<string, number>;
    successMetric?: SuccessMetric;
    startedAt?: number | null;
  }): ExperimentRow {
    const row = this.db
      .query<
        ExperimentRow,
        [string, ExperimentStatus, string, SuccessMetric, number | null]
      >(
        `INSERT INTO experiments (slug, status, allocation_json, success_metric, started_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.slug,
        input.status ?? "draft",
        JSON.stringify(input.allocation),
        input.successMetric ?? "qualified",
        input.startedAt ?? null,
      );
    if (!row) throw new Error(`Failed to insert experiment ${input.slug}`);
    return row;
  }

  setStatus(id: number, status: ExperimentStatus): void {
    if (status === "running") {
      this.db.run(
        `UPDATE experiments SET status = 'running', started_at = COALESCE(started_at, unixepoch())
         WHERE id = ?`,
        [id],
      );
      return;
    }
    if (status === "done") {
      this.db.run(
        `UPDATE experiments SET status = 'done', ended_at = unixepoch() WHERE id = ?`,
        [id],
      );
      return;
    }
    this.db.run("UPDATE experiments SET status = ? WHERE id = ?", [status, id]);
  }
}

/**
 * Decode an `experiments.allocation_json` blob into the shape that
 * `pickVariant` expects. Returns null when the row is malformed (so the
 * caller can fall back to legacy persona instead of crashing the bot).
 */
export function parseAllocationToExperiment(row: ExperimentRow): Experiment | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.allocation_json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const variants: { styleSlug: string; weight: number }[] = [];
  for (const [styleSlug, weight] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof styleSlug !== "string" || styleSlug.length === 0) return null;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) return null;
    variants.push({ styleSlug, weight });
  }
  if (variants.length === 0) return null;

  return { slug: row.slug, variants };
}
