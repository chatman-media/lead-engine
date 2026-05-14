import {
  type ExperimentStatus,
  ExperimentsRepo,
  parseAllocationToExperiment,
  type SuccessMetric,
} from "../../db/repos/experiments.ts";
import { StylesRepo } from "../../db/repos/styles.ts";
import { json, type RouteHandler } from "../../router.ts";
import { requireAdmin } from "../auth.ts";
import { type AdminApiDeps, safeJson } from "../shared.ts";

const VALID_EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  "draft",
  "running",
  "paused",
  "done",
];
const VALID_SUCCESS_METRICS: readonly SuccessMetric[] = ["qualified", "won", "replied_3+"];

export function createListExperimentsHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.sql);
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const rows = (await experiments.list()).map((row) => ({
      id: row.id,
      slug: row.slug,
      status: row.status,
      success_metric: row.success_metric,
      // Surface the allocation as an object so the UI doesn't have to parse JSON.
      allocation: safeJson(row.allocation_json),
      started_at: row.started_at,
      ended_at: row.ended_at,
      created_at: row.created_at,
    }));
    return json({ experiments: rows });
  };
}

interface CreateExperimentBody {
  slug?: unknown;
  status?: unknown;
  successMetric?: unknown;
  allocation?: unknown;
}

export function createCreateExperimentHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.sql);
  const styles = new StylesRepo(deps.sql);
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    let body: CreateExperimentBody;
    try {
      body = (await req.json()) as CreateExperimentBody;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }

    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) return json({ error: "slug is required" }, { status: 400 });
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return json({ error: "slug must be kebab-case" }, { status: 400 });
    }

    const status: ExperimentStatus =
      typeof body.status === "string" &&
      (VALID_EXPERIMENT_STATUSES as readonly string[]).includes(body.status)
        ? (body.status as ExperimentStatus)
        : "draft";

    const successMetric: SuccessMetric =
      typeof body.successMetric === "string" &&
      (VALID_SUCCESS_METRICS as readonly string[]).includes(body.successMetric)
        ? (body.successMetric as SuccessMetric)
        : "qualified";

    if (typeof body.allocation !== "object" || body.allocation === null) {
      return json({ error: "allocation must be an object {styleSlug: weight}" }, { status: 400 });
    }
    const allocation: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.allocation as Record<string, unknown>)) {
      if (typeof k !== "string" || k.length === 0) {
        return json({ error: `bad allocation key: ${k}` }, { status: 400 });
      }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return json({ error: `weight for "${k}" must be a non-negative number` }, { status: 400 });
      }
      // Verify the referenced style exists & is active. Otherwise the
      // experiment will silently allocate to a missing slug and graceful-
      // fallback to the legacy persona — nasty surprise during a real test.
      if (!(await styles.bySlug(k))) {
        return json(
          { error: `referenced style slug "${k}" not found or inactive` },
          { status: 400 },
        );
      }
      allocation[k] = v;
    }
    if (Object.keys(allocation).length === 0) {
      return json({ error: "allocation must have at least one variant" }, { status: 400 });
    }
    const totalWeight = Object.values(allocation).reduce((s, n) => s + n, 0);
    if (totalWeight <= 0) {
      return json({ error: "total allocation weight must be > 0" }, { status: 400 });
    }

    if (await experiments.bySlug(slug)) {
      return json({ error: "experiment with this slug already exists" }, { status: 409 });
    }

    // Only one experiment may run at a time. If we're creating a 'running'
    // one and another is live, refuse — admin must pause/done the existing
    // one first.
    if (status === "running" && (await experiments.getRunning())) {
      return json(
        { error: "another experiment is already running; pause it first" },
        { status: 409 },
      );
    }

    const row = await experiments.insert({ slug, status, allocation, successMetric });
    return json(
      {
        experiment: {
          id: row.id,
          slug: row.slug,
          status: row.status,
          success_metric: row.success_metric,
          allocation: safeJson(row.allocation_json),
          started_at: row.started_at,
          ended_at: row.ended_at,
          created_at: row.created_at,
        },
      },
      { status: 201 },
    );
  };
}

interface PatchExperimentBody {
  status?: unknown;
}

export function createSetExperimentStatusHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.sql);
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const row = await experiments.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });

    let body: PatchExperimentBody;
    try {
      body = (await req.json()) as PatchExperimentBody;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const status = typeof body.status === "string" ? body.status : "";
    if (!(VALID_EXPERIMENT_STATUSES as readonly string[]).includes(status)) {
      return json(
        { error: `status must be one of ${VALID_EXPERIMENT_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    const newStatus = status as ExperimentStatus;
    if (newStatus === "running" && row.status !== "running") {
      const conflicting = await experiments.getRunning();
      if (conflicting && conflicting.id !== id) {
        return json(
          {
            error: `another experiment is already running (id=${conflicting.id} slug=${conflicting.slug}); pause it first`,
          },
          { status: 409 },
        );
      }
      // Validate allocation before going live — saves a confusing fallback later.
      if (!parseAllocationToExperiment(row)) {
        return json(
          { error: "allocation_json is malformed; fix it before starting" },
          { status: 422 },
        );
      }
    }

    await experiments.setStatus(id, newStatus);
    const updated = (await experiments.byId(id))!;
    return json({
      experiment: {
        id: updated.id,
        slug: updated.slug,
        status: updated.status,
        success_metric: updated.success_metric,
        allocation: safeJson(updated.allocation_json),
        started_at: updated.started_at,
        ended_at: updated.ended_at,
        created_at: updated.created_at,
      },
    });
  };
}

interface FunnelRow {
  style_id: number;
  slug: string;
  display_name: string;
  conversations: number;
  qualified: number;
  won: number;
  lost: number;
  pending: number;
  escalated_to_human: number;
}

export function createExperimentFunnelHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.sql);
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const row = await experiments.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });

    // Per-style aggregate. LEFT JOIN on conversations so styles that haven't
    // received any traffic yet still appear with zero counts (helps the UI
    // distinguish "nobody assigned" from "assigned, didn't qualify").
    const funnel = await deps.sql<FunnelRow[]>`
      SELECT
        s.id AS style_id,
        s.slug AS slug,
        s.display_name AS display_name,
        COUNT(c.id)::INTEGER AS conversations,
        COALESCE(SUM(CASE WHEN u.status = 'qualified' THEN 1 ELSE 0 END), 0)::INTEGER AS qualified,
        COALESCE(SUM(CASE WHEN u.status = 'won' THEN 1 ELSE 0 END), 0)::INTEGER AS won,
        COALESCE(SUM(CASE WHEN u.status = 'lost' THEN 1 ELSE 0 END), 0)::INTEGER AS lost,
        COALESCE(SUM(CASE WHEN u.status IN ('new','questionnaire_pending') THEN 1 ELSE 0 END), 0)::INTEGER AS pending,
        COALESCE(SUM(CASE WHEN c.mode = 'human' THEN 1 ELSE 0 END), 0)::INTEGER AS escalated_to_human
      FROM styles s
      LEFT JOIN conversations c
        ON c.style_id = s.id AND c.experiment_id = ${id}
      LEFT JOIN users u ON u.id = c.user_id
      WHERE s.id IN (
        SELECT DISTINCT style_id FROM conversations WHERE experiment_id = ${id}
        UNION
        SELECT s2.id FROM styles s2 WHERE s2.is_active = TRUE
      )
      GROUP BY s.id, s.slug, s.display_name
      ORDER BY conversations DESC, s.display_name
    `;

    return json({
      experiment_id: id,
      success_metric: row.success_metric,
      // Surface every active style in the funnel (even zero-traffic ones) so
      // the UI can show "this branch never got a chance" rather than hiding
      // it. The repo query already restricts to styles relevant to the
      // experiment, so no extra filtering is needed here.
      funnel,
    });
  };
}
