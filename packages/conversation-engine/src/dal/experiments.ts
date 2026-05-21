import { experiments as experimentsTable } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface ExperimentRow {
  id: number;
  tenantId: number;
  slug: string;
  status: string;
  allocationJson: string;
  successMetric: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

/**
 * Experiments repo. allocation_json — TEXT с JSON-массивом
 *   [{ "style_slug": "alina-infinity-v1", "weight": 2 }, ...]
 * status — enum 'draft|running|paused|done' (storage CHECK).
 */
export class ExperimentsRepo {
  constructor(private readonly ctx: RepoCtx) {}

  async byId(id: number): Promise<ExperimentRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(experimentsTable)
      .where(
        and(
          eq(experimentsTable.id, id),
          eq(experimentsTable.tenantId, this.ctx.tenantId),
        ),
      );
    return (row as ExperimentRow) ?? null;
  }

  async findRunningBySlug(slug: string): Promise<ExperimentRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(experimentsTable)
      .where(
        and(
          eq(experimentsTable.tenantId, this.ctx.tenantId),
          eq(experimentsTable.slug, slug),
          eq(experimentsTable.status, "running"),
        ),
      );
    return (row as ExperimentRow) ?? null;
  }
}

/**
 * Parsed единица allocation_json. Weight default 1 если не указан.
 */
export interface ExperimentAllocationEntry {
  styleSlug: string;
  weight: number;
}

export function parseAllocation(allocationJson: string): ExperimentAllocationEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(allocationJson);
  } catch {
    throw new Error(`experiments.allocation_json invalid: not JSON`);
  }
  if (!Array.isArray(raw)) {
    throw new Error("experiments.allocation_json must be array");
  }
  const out: ExperimentAllocationEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const slug = obj.style_slug ?? obj.styleSlug;
    if (typeof slug !== "string") continue;
    const weight = typeof obj.weight === "number" && obj.weight > 0 ? obj.weight : 1;
    out.push({ styleSlug: slug, weight });
  }
  if (out.length === 0) {
    throw new Error("experiments.allocation_json contains no valid entries");
  }
  return out;
}
