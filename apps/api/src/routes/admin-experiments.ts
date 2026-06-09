import {
  type Db,
  type ExperimentAllocationEntry,
  type ExperimentRow,
  ExperimentsRepo,
  parseAllocation,
  parseStyleConfig,
  StylesRepo,
  withTenant,
} from "@chatman-media/conversation-engine";
import { ABRouter, type Style } from "@chatman-media/kb";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { isUniqueViolation } from "../lib/db-errors.ts";

/**
 * Experiments CRUD — A/B тесты стилей общения.
 *
 * Endpoints:
 *   GET    /api/admin/experiments          — список всех экспериментов тенанта
 *   POST   /api/admin/experiments          — создать эксперимент (status=draft)
 *   PATCH  /api/admin/experiments/:id      — обновить allocationJson / successMetric (только draft/paused)
 *   PUT    /api/admin/experiments/:id/status — сменить статус (running/paused/done)
 */
export interface AdminExperimentsRoutesOpts {
  db: Db;
}

const VALID_METRICS = ["qualified", "won", "replied_3+"] as const;
const VALID_STATUSES = ["running", "paused", "done"] as const;
const DEFAULT_PREVIEW_SAMPLE_SIZE = 20;
const MAX_PREVIEW_SAMPLE_SIZE = 100;

export function makeAdminExperimentsRoutes(opts: AdminExperimentsRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/admin/experiments", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new ExperimentsRepo({ db: tx, tenantId });
      return repo.listAll();
    });
    return c.json({ items: rows });
  });

  app.get("/api/admin/experiments/:id/preview", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    const sampleSize = parsePreviewSampleSize(c.req.query("sampleSize") ?? c.req.query("sample"));
    const preview = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new ExperimentsRepo({ db: tx, tenantId });
      const experiment = await repo.byId(id);
      if (!experiment) return null;
      return buildExperimentPreview({
        experiment,
        sampleSize,
        stylesRepo: new StylesRepo({ db: tx, tenantId }),
      });
    });

    if (!preview) return c.json({ error: "experiment not found" }, 404);
    if ("error" in preview) return c.json({ error: preview.error }, 422);
    return c.json(preview);
  });

  /**
   * POST /api/admin/experiments
   * Body: { slug, allocationJson, successMetric }
   * allocationJson: [{ style_slug, weight }]
   */
  app.post("/api/admin/experiments", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let body: { slug?: unknown; allocationJson?: unknown; successMetric?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      return c.json({ error: "slug required, only a-z 0-9 _ -" }, 400);
    }

    const metric = typeof body.successMetric === "string" ? body.successMetric : "";
    if (!VALID_METRICS.includes(metric as (typeof VALID_METRICS)[number])) {
      return c.json({ error: `successMetric must be one of: ${VALID_METRICS.join(", ")}` }, 400);
    }

    const allocationRaw = typeof body.allocationJson === "string" ? body.allocationJson : "";
    const allocationError = validateAllocationJson(allocationRaw);
    if (allocationError) return c.json({ error: allocationError }, 400);

    let row: Awaited<ReturnType<ExperimentsRepo["create"]>>;
    try {
      row = await withTenant(opts.db, tenantId, async (tx) => {
        const repo = new ExperimentsRepo({ db: tx, tenantId });
        return repo.create({ slug, allocationJson: allocationRaw, successMetric: metric });
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return c.json({ error: "experiment with this slug already exists" }, 409);
      throw err;
    }

    await recordAudit(opts.db, {
      tenantId, adminId, action: "experiment.create",
      targetKind: "experiment", targetId: row.id, details: { slug, metric },
    });

    return c.json(row, 201);
  });

  /**
   * PATCH /api/admin/experiments/:id
   * Body: { allocationJson?, successMetric? }
   * Allowed only when status is 'draft' or 'paused'.
   */
  app.patch("/api/admin/experiments/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { allocationJson?: unknown; successMetric?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const patch: Partial<{ allocationJson: string; successMetric: string }> = {};

    if (typeof body.successMetric === "string") {
      if (!VALID_METRICS.includes(body.successMetric as (typeof VALID_METRICS)[number])) {
        return c.json({ error: `successMetric must be one of: ${VALID_METRICS.join(", ")}` }, 400);
      }
      patch.successMetric = body.successMetric;
    }

    if (typeof body.allocationJson === "string") {
      const allocationError = validateAllocationJson(body.allocationJson);
      if (allocationError) return c.json({ error: allocationError }, 400);
      patch.allocationJson = body.allocationJson;
    }

    if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);

    const updated = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new ExperimentsRepo({ db: tx, tenantId });
      const existing = await repo.byId(id);
      if (!existing) return null;
      if (existing.status !== "draft" && existing.status !== "paused") {
        return { error: `cannot edit experiment in status '${existing.status}'` };
      }
      return repo.update(id, patch);
    });

    if (!updated) return c.json({ error: "experiment not found" }, 404);
    if ("error" in updated) return c.json({ error: updated.error }, 409);

    await recordAudit(opts.db, {
      tenantId, adminId, action: "experiment.update",
      targetKind: "experiment", targetId: id, details: patch,
    });

    return c.json(updated);
  });

  /**
   * PUT /api/admin/experiments/:id/status
   * Body: { status: 'running' | 'paused' | 'done' }
   *
   * Allowed transitions:
   *   draft   → running
   *   running → paused | done
   *   paused  → running | done
   *   done    → (nothing)
   */
  app.put("/api/admin/experiments/:id/status", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid id" }, 400);

    let body: { status?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const newStatus = body.status;
    if (!VALID_STATUSES.includes(newStatus as (typeof VALID_STATUSES)[number])) {
      return c.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
    }

    const TRANSITIONS: Record<string, string[]> = {
      draft: ["running"],
      running: ["paused", "done"],
      paused: ["running", "done"],
      done: [],
    };

    const updated = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new ExperimentsRepo({ db: tx, tenantId });
      const existing = await repo.byId(id);
      if (!existing) return null;
      const allowed = TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(newStatus as string)) {
        return { error: `cannot transition from '${existing.status}' to '${newStatus as string}'` };
      }
      if (newStatus === "running") {
        const preview = await buildExperimentPreview({
          experiment: existing,
          sampleSize: DEFAULT_PREVIEW_SAMPLE_SIZE,
          stylesRepo: new StylesRepo({ db: tx, tenantId }),
        });
        if ("error" in preview) return { error: preview.error };
        if (!preview.canRun) {
          return { error: "experiment needs at least 2 active valid style variants before running" };
        }
      }
      return repo.setStatus(id, newStatus as "running" | "paused" | "done");
    });

    if (!updated) return c.json({ error: "experiment not found" }, 404);
    if ("error" in updated) return c.json({ error: updated.error }, 409);

    await recordAudit(opts.db, {
      tenantId, adminId, action: `experiment.status.${newStatus as string}`,
      targetKind: "experiment", targetId: id, details: { status: newStatus },
    });

    return c.json(updated);
  });

  return app;
}

function validateAllocationJson(allocationJson: string): string | null {
  let entries: ExperimentAllocationEntry[];
  try {
    entries = parseAllocation(allocationJson);
  } catch {
    return "allocationJson must be valid JSON array";
  }
  if (entries.length < 2) return "allocationJson must include at least 2 valid variants";
  const uniqueSlugs = new Set(entries.map((entry) => entry.styleSlug));
  if (uniqueSlugs.size < entries.length) return "allocationJson variants must use unique style slugs";
  return null;
}

function parsePreviewSampleSize(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_PREVIEW_SAMPLE_SIZE;
  if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_SAMPLE_SIZE;
  return Math.min(MAX_PREVIEW_SAMPLE_SIZE, Math.max(1, parsed));
}

interface BuildExperimentPreviewOpts {
  experiment: ExperimentRow;
  sampleSize: number;
  stylesRepo: StylesRepo;
}

interface ValidPreviewVariant {
  style: Style;
  weight: number;
}

async function buildExperimentPreview(opts: BuildExperimentPreviewOpts) {
  let entries: ExperimentAllocationEntry[];
  try {
    entries = parseAllocation(opts.experiment.allocationJson);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "allocationJson is invalid" };
  }

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const variants: Array<{
    styleSlug: string;
    displayName: string | null;
    weight: number;
    targetPct: number;
    status: "valid" | "missing" | "invalid_config";
  }> = [];
  const validVariants: ValidPreviewVariant[] = [];

  for (const entry of entries) {
    const row = await opts.stylesRepo.findActiveBySlug(entry.styleSlug);
    if (!row) {
      variants.push({
        styleSlug: entry.styleSlug,
        displayName: null,
        weight: entry.weight,
        targetPct: percent(entry.weight, totalWeight),
        status: "missing",
      });
      continue;
    }

    const style = parseStyleConfig(row.configJson);
    if (!style) {
      variants.push({
        styleSlug: entry.styleSlug,
        displayName: row.displayName,
        weight: entry.weight,
        targetPct: percent(entry.weight, totalWeight),
        status: "invalid_config",
      });
      continue;
    }

    validVariants.push({ style, weight: entry.weight });
    variants.push({
      styleSlug: entry.styleSlug,
      displayName: row.displayName,
      weight: entry.weight,
      targetPct: percent(entry.weight, totalWeight),
      status: "valid",
    });
  }

  const router = validVariants.length > 0 ? new ABRouter({ variants: validVariants, salt: opts.experiment.slug }) : null;
  const assignments = router
    ? Array.from({ length: opts.sampleSize }, (_, index) => {
        const userId = `preview-${index + 1}`;
        const assigned = router.assign(userId);
        return { userId, styleSlug: assigned.variantSlug };
      })
    : [];
  const counts = countAssignments(assignments, opts.sampleSize);

  return {
    experiment: {
      id: opts.experiment.id,
      slug: opts.experiment.slug,
      status: opts.experiment.status,
      successMetric: opts.experiment.successMetric,
    },
    sampleSize: opts.sampleSize,
    canRun: validVariants.length >= 2,
    variants,
    assignments,
    counts,
  };
}

function countAssignments(assignments: Array<{ styleSlug: string }>, sampleSize: number) {
  const counts = new Map<string, number>();
  for (const assignment of assignments) {
    counts.set(assignment.styleSlug, (counts.get(assignment.styleSlug) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([styleSlug, count]) => ({
      styleSlug,
      count,
      observedPct: percent(count, sampleSize),
    }))
    .sort((a, b) => b.count - a.count || a.styleSlug.localeCompare(b.styleSlug));
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}
