import { type Db, ExperimentsRepo, withTenant } from "@chatman-media/conversation-engine";
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
    try {
      const parsed = JSON.parse(allocationRaw);
      if (!Array.isArray(parsed) || parsed.length < 2) {
        return c.json({ error: "allocationJson must be array with at least 2 variants" }, 400);
      }
    } catch {
      return c.json({ error: "allocationJson must be valid JSON array" }, 400);
    }

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
      try {
        const parsed = JSON.parse(body.allocationJson);
        if (!Array.isArray(parsed) || parsed.length < 2) {
          return c.json({ error: "allocationJson must be array with at least 2 variants" }, 400);
        }
      } catch {
        return c.json({ error: "allocationJson must be valid JSON array" }, 400);
      }
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
