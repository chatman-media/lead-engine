import type { Experiment } from "../../sales/ab-router.ts";
import type { Sql } from "../postgres.ts";

export type ExperimentStatus = "draft" | "running" | "paused" | "done";
export type SuccessMetric = "qualified" | "won" | "replied_3+";

export interface ExperimentRow {
  id: number;
  slug: string;
  status: ExperimentStatus;
  allocation_json: string;
  success_metric: SuccessMetric;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export class ExperimentsRepo {
  constructor(private sql: Sql) {}

  async byId(id: number): Promise<ExperimentRow | null> {
    const [row] = await this.sql<ExperimentRow[]>`
      SELECT * FROM experiments WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async bySlug(slug: string): Promise<ExperimentRow | null> {
    const [row] = await this.sql<ExperimentRow[]>`
      SELECT * FROM experiments WHERE slug = ${slug} LIMIT 1
    `;
    return row ?? null;
  }

  async getRunning(): Promise<ExperimentRow | null> {
    const [row] = await this.sql<ExperimentRow[]>`
      SELECT * FROM experiments
      WHERE status = 'running'
      ORDER BY started_at DESC NULLS LAST, id DESC
      LIMIT 1
    `;
    return row ?? null;
  }

  async list(opts: { status?: ExperimentStatus } = {}): Promise<ExperimentRow[]> {
    if (opts.status) {
      return this.sql<ExperimentRow[]>`
        SELECT * FROM experiments WHERE status = ${opts.status} ORDER BY created_at DESC
      `;
    }
    return this.sql<ExperimentRow[]>`
      SELECT * FROM experiments ORDER BY created_at DESC
    `;
  }

  async insert(input: {
    slug: string;
    status?: ExperimentStatus;
    allocation: Record<string, number>;
    successMetric?: SuccessMetric;
    startedAt?: number | null;
  }): Promise<ExperimentRow> {
    const status = input.status ?? "draft";
    const successMetric = input.successMetric ?? "qualified";
    const [row] = await this.sql<ExperimentRow[]>`
      INSERT INTO experiments (slug, status, allocation_json, success_metric, started_at)
      VALUES (${input.slug}, ${status}, ${JSON.stringify(input.allocation)}, ${successMetric}, ${input.startedAt ?? null})
      RETURNING *
    `;
    if (!row) throw new Error(`Failed to insert experiment ${input.slug}`);
    return row;
  }

  async setStatus(id: number, status: ExperimentStatus): Promise<void> {
    if (status === "running") {
      await this.sql`
        UPDATE experiments SET status = 'running', started_at = COALESCE(started_at, EXTRACT(EPOCH FROM NOW())::INTEGER)
        WHERE id = ${id}
      `;
      return;
    }
    if (status === "done") {
      await this.sql`
        UPDATE experiments SET status = 'done', ended_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
      `;
      return;
    }
    await this.sql`UPDATE experiments SET status = ${status} WHERE id = ${id}`;
  }
}

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
