import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  funnels,
  skills,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Funnel builder + skills list API.
 *
 * GET  /api/admin/funnel                       — активная воронка + все стадии + поля
 * POST /api/admin/funnel/stages                — создать стадию
 * PATCH /api/admin/funnel/stages/:stageId      — обновить стадию
 * DELETE /api/admin/funnel/stages/:stageId     — удалить стадию
 * POST /api/admin/funnel/stages/:stageId/fields — создать поле
 * PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId — обновить поле
 * DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId — удалить поле
 * PATCH /api/admin/funnel/stages/reorder       — переставить позиции
 *
 * GET  /api/admin/skills                       — полный список скилов
 */
export interface AdminFunnelRoutesOpts {
  db: Db;
}

export function makeAdminFunnelRoutes(opts: AdminFunnelRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/funnel
   * Возвращает активную воронку тенанта со всеми стадиями и полями.
   */
  app.get("/api/admin/funnel", async (c) => {
    const tenantId = c.var.tenantId;

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [funnel] = await tx
        .select()
        .from(funnels)
        .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
        .limit(1);

      if (!funnel) return null;

      const stages = await tx
        .select()
        .from(stageDefinitions)
        .where(eq(stageDefinitions.funnelId, funnel.id))
        .orderBy(asc(stageDefinitions.position));

      const fields = stages.length > 0
        ? await tx
            .select()
            .from(stageFields)
            .where(eq(stageFields.tenantId, tenantId))
            .orderBy(asc(stageFields.position))
        : [];

      // группируем поля по stageId
      const fieldsByStage = fields.reduce<Record<number, typeof fields>>(
        (acc, f) => {
          (acc[f.stageId] ??= []).push(f);
          return acc;
        },
        {},
      );

      return {
        funnel: { id: funnel.id, slug: funnel.slug, isActive: funnel.isActive },
        stages: stages.map((s) => ({
          ...s,
          fields: fieldsByStage[s.id] ?? [],
        })),
      };
    });

    if (!result) return c.json({ funnel: null, stages: [] });
    return c.json(result);
  });

  /**
   * POST /api/admin/funnel/stages
   * Body: { funnelId, slug, displayName, kind, stageType, position?, color?, icon?,
   *         description?, staleTimeoutDays?, checkinIntervalDays?, supportMode? }
   */
  app.post("/api/admin/funnel/stages", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const body = await c.req.json<{
      funnelId: number;
      slug: string;
      displayName: string;
      kind?: string;
      stageType?: string;
      position?: number;
      color?: string;
      icon?: string;
      description?: string;
      staleTimeoutDays?: number;
      checkinIntervalDays?: number;
      supportMode?: boolean;
      nextStages?: string[];
    }>();

    if (!body.funnelId || !body.slug || !body.displayName) {
      return c.json({ error: "funnelId, slug, displayName required" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const [stage] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(stageDefinitions)
        .values({
          tenantId,
          funnelId: body.funnelId,
          slug: body.slug,
          displayName: body.displayName,
          description: body.description ?? undefined,
          position: body.position ?? 0,
          kind: body.kind ?? "active",
          stageType: body.stageType ?? "form_fill",
          color: body.color ?? undefined,
          icon: body.icon ?? undefined,
          staleTimeoutDays: body.staleTimeoutDays ?? undefined,
          checkinIntervalDays: body.checkinIntervalDays ?? undefined,
          supportMode: body.supportMode ?? false,
          nextStages: body.nextStages ?? [],
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage.create",
      targetKind: "stage_definition",
      targetId: String(stage?.id),
      details: { slug: body.slug },
    });

    return c.json(stage, 201);
  });

  /**
   * PATCH /api/admin/funnel/stages/:stageId
   */
  app.patch("/api/admin/funnel/stages/:stageId", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const stageId = Number(c.req.param("stageId"));
    if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

    const body = await c.req.json<Partial<{
      displayName: string;
      description: string;
      kind: string;
      stageType: string;
      position: number;
      color: string;
      icon: string;
      staleTimeoutDays: number;
      checkinIntervalDays: number;
      supportMode: boolean;
      nextStages: string[];
      configJson: string;
    }>>();

    const now = Math.floor(Date.now() / 1000);
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.description !== undefined) patch.description = body.description;
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.stageType !== undefined) patch.stageType = body.stageType;
    if (body.position !== undefined) patch.position = body.position;
    if (body.color !== undefined) patch.color = body.color;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.staleTimeoutDays !== undefined) patch.staleTimeoutDays = body.staleTimeoutDays;
    if (body.checkinIntervalDays !== undefined) patch.checkinIntervalDays = body.checkinIntervalDays;
    if (body.supportMode !== undefined) patch.supportMode = body.supportMode;
    if (body.nextStages !== undefined) patch.nextStages = body.nextStages;
    if (body.configJson !== undefined) patch.configJson = body.configJson;

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(stageDefinitions)
        // biome-ignore lint/suspicious/noExplicitAny: dynamic patch object
        .set(patch as any)
        .where(and(eq(stageDefinitions.id, stageId), eq(stageDefinitions.tenantId, tenantId))),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage.update",
      targetKind: "stage_definition",
      targetId: String(stageId),
    });

    return c.json({ ok: true });
  });

  /**
   * DELETE /api/admin/funnel/stages/:stageId
   */
  app.delete("/api/admin/funnel/stages/:stageId", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const stageId = Number(c.req.param("stageId"));
    if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(stageDefinitions)
        .where(and(eq(stageDefinitions.id, stageId), eq(stageDefinitions.tenantId, tenantId))),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage.delete",
      targetKind: "stage_definition",
      targetId: String(stageId),
    });

    return c.json({ ok: true });
  });

  /**
   * PATCH /api/admin/funnel/stages/reorder
   * Body: { order: Array<{ id: number, position: number }> }
   */
  app.patch("/api/admin/funnel/stages/reorder", async (c) => {
    const tenantId = c.var.tenantId;
    const { order } = await c.req.json<{ order: Array<{ id: number; position: number }> }>();
    if (!Array.isArray(order)) return c.json({ error: "order array required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      for (const { id, position } of order) {
        await tx
          .update(stageDefinitions)
          .set({ position, updatedAt: now })
          .where(and(eq(stageDefinitions.id, id), eq(stageDefinitions.tenantId, tenantId)));
      }
    });

    return c.json({ ok: true });
  });

  // ── Stage fields ──────────────────────────────────────────────────────────

  /**
   * POST /api/admin/funnel/stages/:stageId/fields
   */
  app.post("/api/admin/funnel/stages/:stageId/fields", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const stageId = Number(c.req.param("stageId"));
    if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

    const body = await c.req.json<{
      slug: string;
      displayName: string;
      fieldType?: string;
      required?: boolean;
      position?: number;
      hint?: string;
      aiExtractable?: boolean;
      optionsJson?: string;
      validationJson?: string;
    }>();

    if (!body.slug || !body.displayName) {
      return c.json({ error: "slug, displayName required" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const [field] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(stageFields)
        .values({
          stageId,
          tenantId,
          slug: body.slug,
          displayName: body.displayName,
          fieldType: body.fieldType ?? "text",
          required: body.required ?? false,
          position: body.position ?? 0,
          hint: body.hint ?? null,
          aiExtractable: body.aiExtractable ?? false,
          optionsJson: body.optionsJson ?? "[]",
          validationJson: body.validationJson ?? "{}",
          createdAt: now,
        })
        .returning(),
    );

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "stage_field.create",
      targetKind: "stage_field",
      targetId: String(field?.id),
    });

    return c.json(field, 201);
  });

  /**
   * PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId
   */
  app.patch("/api/admin/funnel/stages/:stageId/fields/:fieldId", async (c) => {
    const tenantId = c.var.tenantId;
    const fieldId = Number(c.req.param("fieldId"));
    if (!Number.isFinite(fieldId)) return c.json({ error: "bad fieldId" }, 400);

    const body = await c.req.json<Partial<{
      displayName: string;
      fieldType: string;
      required: boolean;
      position: number;
      hint: string;
      aiExtractable: boolean;
      optionsJson: string;
      validationJson: string;
    }>>();

    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.fieldType !== undefined) patch.fieldType = body.fieldType;
    if (body.required !== undefined) patch.required = body.required;
    if (body.position !== undefined) patch.position = body.position;
    if (body.hint !== undefined) patch.hint = body.hint;
    if (body.aiExtractable !== undefined) patch.aiExtractable = body.aiExtractable;
    if (body.optionsJson !== undefined) patch.optionsJson = body.optionsJson;
    if (body.validationJson !== undefined) patch.validationJson = body.validationJson;

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(stageFields)
        // biome-ignore lint/suspicious/noExplicitAny: dynamic patch
        .set(patch as any)
        .where(and(eq(stageFields.id, fieldId), eq(stageFields.tenantId, tenantId))),
    );

    return c.json({ ok: true });
  });

  /**
   * DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId
   */
  app.delete("/api/admin/funnel/stages/:stageId/fields/:fieldId", async (c) => {
    const tenantId = c.var.tenantId;
    const fieldId = Number(c.req.param("fieldId"));
    if (!Number.isFinite(fieldId)) return c.json({ error: "bad fieldId" }, 400);

    await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(stageFields)
        .where(and(eq(stageFields.id, fieldId), eq(stageFields.tenantId, tenantId))),
    );

    return c.json({ ok: true });
  });

  // ── Skills ────────────────────────────────────────────────────────────────

  /**
   * GET /api/admin/skills
   * Полный список скилов тенанта с ELO-рейтингами.
   */
  app.get("/api/admin/skills", async (c) => {
    const tenantId = c.var.tenantId;

    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select()
        .from(skills)
        .where(eq(skills.tenantId, tenantId))
        .orderBy(asc(skills.family), asc(skills.displayName)),
    );

    return c.json({ items: rows });
  });

  return app;
}
