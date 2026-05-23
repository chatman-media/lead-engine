import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  contacts,
  leadEvents,
  leadFieldValues,
  leadNotes,
  leads,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Lead pipeline API.
 *
 * GET  /api/admin/leads                — список лидов с фильтром по стадии
 * POST /api/admin/leads                — создать лида вручную
 * GET  /api/admin/leads/:id            — карточка лида с полями и историей
 * PATCH /api/admin/leads/:id/stage     — переместить в стадию
 * GET  /api/admin/leads/:id/field-values — значения полей
 * PUT  /api/admin/leads/:id/field-values — bulk upsert значений полей
 */
export interface AdminLeadsRoutesOpts {
  db: Db;
}

export function makeAdminLeadsRoutes(opts: AdminLeadsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/leads
   * Query: ?stageId=<id> | ?state=<slug> | ?limit=N | ?offset=N
   */
  app.get("/api/admin/leads", async (c) => {
    const tenantId = c.var.tenantId;
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
    const stageIdParam = c.req.query("stageId");
    const stateParam = c.req.query("state");

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const conditions = [eq(leads.tenantId, tenantId)];
      if (stageIdParam) {
        conditions.push(eq(leads.stageDefinitionId, Number(stageIdParam)));
      }
      if (stateParam) {
        conditions.push(eq(leads.state, stateParam));
      }

      return tx
        .select({
          id: leads.id,
          state: leads.state,
          stageDefinitionId: leads.stageDefinitionId,
          applicationId: leads.applicationId,
          createdAt: leads.createdAt,
          updatedAt: leads.updatedAt,
          rejectedReason: leads.rejectedReason,
          contactId: leads.userId,
          contactName: contacts.displayName,
          // процент заполненности: filled required fields / total required fields
          requiredFieldsTotal: sql<number>`(
            SELECT COUNT(*) FROM stage_fields sf
            JOIN stage_definitions sd ON sf.stage_id = sd.id
            WHERE sd.id = ${leads.stageDefinitionId}
              AND sf.required = TRUE
          )`,
          requiredFieldsFilled: sql<number>`(
            SELECT COUNT(*) FROM lead_field_values lfv
            JOIN stage_fields sf ON lfv.field_id = sf.id
            JOIN stage_definitions sd ON sf.stage_id = sd.id
            WHERE lfv.lead_id = ${leads.id}
              AND sd.id = ${leads.stageDefinitionId}
              AND sf.required = TRUE
              AND lfv.value_json != 'null'
              AND lfv.value_json != '""'
          )`,
        })
        .from(leads)
        .leftJoin(contacts, eq(leads.userId, contacts.id))
        .where(and(...conditions))
        .orderBy(desc(leads.updatedAt))
        .limit(limit)
        .offset(offset);
    });

    return c.json({ items: rows, limit, offset });
  });

  /**
   * POST /api/admin/leads
   * Body: { contactId: number, stageDefinitionId?: number, state?: string }
   */
  app.post("/api/admin/leads", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const body = await c.req.json<{
      contactId: number;
      stageDefinitionId?: number;
      state?: string;
    }>();

    if (!body.contactId) return c.json({ error: "contactId required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const row = await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .insert(leads)
        .values({
          tenantId,
          userId: body.contactId,
          state: body.state ?? "intake_pending",
          stageDefinitionId: body.stageDefinitionId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return lead;
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.create",
      targetKind: "lead",
      targetId: String(row?.id),
    });

    return c.json(row, 201);
  });

  /**
   * GET /api/admin/leads/:id
   * Возвращает лид + stage definition + field values + recent events + notes
   */
  app.get("/api/admin/leads/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select()
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) return null;

      const [stageDef] = lead.stageDefinitionId
        ? await tx.select().from(stageDefinitions).where(eq(stageDefinitions.id, lead.stageDefinitionId))
        : [null];

      const fields = stageDef
        ? await tx.select().from(stageFields).where(eq(stageFields.stageId, stageDef.id))
        : [];

      const fieldValues = fields.length > 0
        ? await tx
            .select()
            .from(leadFieldValues)
            .where(and(
              eq(leadFieldValues.leadId, id),
              inArray(leadFieldValues.fieldId, fields.map((f) => f.id)),
            ))
        : [];

      const events = await tx
        .select()
        .from(leadEvents)
        .where(eq(leadEvents.leadId, id))
        .orderBy(desc(leadEvents.createdAt))
        .limit(20);

      const notes = await tx
        .select()
        .from(leadNotes)
        .where(eq(leadNotes.leadId, id))
        .orderBy(desc(leadNotes.createdAt))
        .limit(10);

      const [contact] = await tx
        .select({ id: contacts.id, displayName: contacts.displayName, attributesJson: contacts.attributesJson })
        .from(contacts)
        .where(eq(contacts.id, lead.userId));

      return { lead, stageDef, fields, fieldValues, events, notes, contact };
    });

    if (!result) return c.json({ error: "lead not found" }, 404);
    return c.json(result);
  });

  /**
   * PATCH /api/admin/leads/:id/stage
   * Body: { stageDefinitionId: number } — переход в указанную стадию
   */
  app.patch("/api/admin/leads/:id/stage", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const { stageDefinitionId } = await c.req.json<{ stageDefinitionId: number }>();
    if (!stageDefinitionId) return c.json({ error: "stageDefinitionId required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select({ id: leads.id, state: leads.state, stageDefinitionId: leads.stageDefinitionId })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) throw new Error("lead not found");

      const [newStage] = await tx
        .select({ slug: stageDefinitions.slug })
        .from(stageDefinitions)
        .where(and(eq(stageDefinitions.id, stageDefinitionId), eq(stageDefinitions.tenantId, tenantId)));
      if (!newStage) throw new Error("stage not found");

      await tx
        .update(leads)
        .set({ stageDefinitionId, state: newStage.slug, updatedAt: now })
        .where(eq(leads.id, id));

      await tx.insert(leadEvents).values({
        tenantId,
        leadId: id,
        fromState: lead.state,
        toState: newStage.slug,
        byAdminId: adminId,
        createdAt: now,
      });
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.stage_change",
      targetKind: "lead",
      targetId: String(id),
      details: { stageDefinitionId },
    });

    return c.json({ ok: true });
  });

  /**
   * PUT /api/admin/leads/:id/field-values
   * Body: { values: Array<{ fieldId: number, value: unknown }> }
   */
  app.put("/api/admin/leads/:id/field-values", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const { values } = await c.req.json<{
      values: Array<{ fieldId: number; value: unknown }>;
    }>();
    if (!Array.isArray(values) || values.length === 0) {
      return c.json({ error: "values array required" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      for (const { fieldId, value } of values) {
        await tx
          .insert(leadFieldValues)
          .values({
            leadId: id,
            fieldId,
            tenantId,
            valueJson: JSON.stringify(value),
            updatedAt: now,
            updatedByAdminId: adminId,
          })
          .onConflictDoUpdate({
            target: [leadFieldValues.leadId, leadFieldValues.fieldId],
            set: {
              valueJson: JSON.stringify(value),
              updatedAt: now,
              updatedByAdminId: adminId,
            },
          });
      }
    });

    return c.json({ ok: true });
  });

  /**
   * POST /api/admin/leads/:id/notes
   * Body: { body: string }
   */
  app.post("/api/admin/leads/:id/notes", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const { body: noteBody } = await c.req.json<{ body: string }>();
    if (!noteBody?.trim()) return c.json({ error: "body required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const [note] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(leadNotes)
        .values({ tenantId, leadId: id, byAdminId: adminId, body: noteBody.trim(), source: "admin", createdAt: now })
        .returning(),
    );

    return c.json(note, 201);
  });

  return app;
}
