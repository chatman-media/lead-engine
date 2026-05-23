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
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Lead pipeline API.
 *
 * GET  /api/admin/leads                — список лидов с фильтром по стадии
 * POST /api/admin/leads                — создать лида вручную
 * GET  /api/admin/leads/:id            — карточка лида с полями и историей
 * PATCH /api/admin/leads/:id/stage     — переместить в стадию
 * DELETE /api/admin/leads/:id          — удалить лида
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
   * Query: ?stageId=<id> | ?state=<slug> | ?contactId=<id> | ?q=<text> | ?limit=N | ?offset=N
   */
  app.get("/api/admin/leads", async (c) => {
    const tenantId = c.var.tenantId;
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
    const stageIdParam = c.req.query("stageId");
    const stateParam = c.req.query("state");
    const contactIdParam = c.req.query("contactId");
    const qParam = c.req.query("q")?.trim();

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const conditions = [eq(leads.tenantId, tenantId)];
      if (stageIdParam) {
        conditions.push(eq(leads.stageDefinitionId, Number(stageIdParam)));
      }
      if (stateParam) {
        conditions.push(eq(leads.state, stateParam));
      }
      if (contactIdParam) {
        conditions.push(eq(leads.userId, Number(contactIdParam)));
      }
      if (qParam) {
        conditions.push(ilike(contacts.displayName, `%${qParam}%`));
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
   * GET /api/admin/leads/export.csv
   * Возвращает всех лидов тенанта в виде CSV-файла
   */
  app.get("/api/admin/leads/export.csv", async (c) => {
    const tenantId = c.var.tenantId;

    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: leads.id,
          state: leads.state,
          contactName: contacts.displayName,
          stageName: stageDefinitions.displayName,
          createdAt: leads.createdAt,
          updatedAt: leads.updatedAt,
          rejectedReason: leads.rejectedReason,
        })
        .from(leads)
        .leftJoin(contacts, eq(leads.userId, contacts.id))
        .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
        .orderBy(desc(leads.updatedAt)),
    );

    // Fetch field values for all leads
    const leadIds = rows.map((r) => r.id);
    const fieldMap = new Map<number, Record<string, string>>();

    if (leadIds.length > 0) {
      const fieldVals = await withTenant(opts.db, tenantId, async (tx) =>
        tx
          .select({
            leadId: leadFieldValues.leadId,
            fieldSlug: stageFields.slug,
            valueJson: leadFieldValues.valueJson,
          })
          .from(leadFieldValues)
          .innerJoin(stageFields, eq(leadFieldValues.fieldId, stageFields.id))
          .where(inArray(leadFieldValues.leadId, leadIds)),
      );

      for (const fv of fieldVals) {
        if (!fieldMap.has(fv.leadId)) fieldMap.set(fv.leadId, {});
        let val = "";
        try {
          const parsed = JSON.parse(fv.valueJson ?? "null");
          val = parsed === null || parsed === undefined ? "" : String(parsed);
        } catch {
          val = fv.valueJson ?? "";
        }
        // biome-ignore lint/style/noNonNullAssertion: just set above
        fieldMap.get(fv.leadId)![fv.fieldSlug] = val;
      }
    }

    // Collect unique field slugs across all leads
    const allSlugs = new Set<string>();
    for (const fields of fieldMap.values()) {
      for (const slug of Object.keys(fields)) allSlugs.add(slug);
    }
    const slugCols = [...allSlugs].sort();

    function csvCell(val: unknown): string {
      const s = val === null || val === undefined ? "" : String(val);
      if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }

    const headers = [
      "id",
      "contactName",
      "state",
      "stageName",
      "createdAt",
      "updatedAt",
      "rejectedReason",
      ...slugCols,
    ];
    const lines: string[] = [headers.map(csvCell).join(",")];

    for (const row of rows) {
      const fields = fieldMap.get(row.id) ?? {};
      const cells = [
        row.id,
        row.contactName,
        row.state,
        row.stageName,
        row.createdAt ? new Date(row.createdAt * 1000).toISOString() : "",
        row.updatedAt ? new Date(row.updatedAt * 1000).toISOString() : "",
        row.rejectedReason,
        ...slugCols.map((s) => fields[s] ?? ""),
      ].map(csvCell);
      lines.push(cells.join(","));
    }

    const csv = `﻿${lines.join("\r\n")}`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="leads.csv"',
      },
    });
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

    const body = await c.req.json<{ stageDefinitionId: number; force?: boolean }>();
    const { stageDefinitionId, force = false } = body;
    if (!stageDefinitionId) return c.json({ error: "stageDefinitionId required" }, 400);

    const now = Math.floor(Date.now() / 1000);
    let transitionBlocked = false;
    await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select({
          id: leads.id,
          state: leads.state,
          stageDefinitionId: leads.stageDefinitionId,
        })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) throw new Error("lead not found");

      const [newStage] = await tx
        .select({ slug: stageDefinitions.slug })
        .from(stageDefinitions)
        .where(and(eq(stageDefinitions.id, stageDefinitionId), eq(stageDefinitions.tenantId, tenantId)));
      if (!newStage) throw new Error("stage not found");

      // Validate transition against current stage's nextStages whitelist.
      // Skip if: no current stage (legacy lead), force override, or same stage.
      if (lead.stageDefinitionId && lead.stageDefinitionId !== stageDefinitionId && !force) {
        const [currentStage] = await tx
          .select({ nextStages: stageDefinitions.nextStages })
          .from(stageDefinitions)
          .where(
            and(
              eq(stageDefinitions.id, lead.stageDefinitionId),
              eq(stageDefinitions.tenantId, tenantId),
            ),
          );
        // If nextStages is non-empty, enforce whitelist.
        if (currentStage && currentStage.nextStages.length > 0) {
          if (!currentStage.nextStages.includes(newStage.slug)) {
            transitionBlocked = true;
            return;
          }
        }
      }

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

    if (transitionBlocked) {
      return c.json(
        { error: "transition_not_allowed", hint: "pass force:true to override" },
        422,
      );
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.stage_change",
      targetKind: "lead",
      targetId: String(id),
      details: { stageDefinitionId, force },
    });

    return c.json({ ok: true });
  });

  /**
   * DELETE /api/admin/leads/:id
   * Удаляет лида вместе с field_values, events и notes.
   */
  app.delete("/api/admin/leads/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) return;

      await tx.delete(leadFieldValues).where(eq(leadFieldValues.leadId, id));
      await tx.delete(leadEvents).where(eq(leadEvents.leadId, id));
      await tx.delete(leadNotes).where(eq(leadNotes.leadId, id));
      await tx.delete(leads).where(eq(leads.id, id));
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.deleted",
      targetKind: "lead",
      targetId: String(id),
      details: {},
    });

    return c.json({ ok: true });
  });

  /**
   * PUT /api/admin/leads/:id/field-values
   * Body: { values: Array<{ fieldId: number, value: unknown }> }
   *
   * После upsert проверяет auto-advance: если стадия имеет
   * autoAdvanceCondition = '{"type":"all_required_fields_filled"}' и все
   * required-поля заполнены — лид автоматически переходит в первую стадию
   * из nextStages. Возвращает { ok, advanced: true|false, newStageSlug? }.
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
    const advanced = await withTenant(opts.db, tenantId, async (tx) => {
      // 1. Upsert field values
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

      // 2. Check auto-advance condition
      const [lead] = await tx
        .select({ id: leads.id, state: leads.state, stageDefinitionId: leads.stageDefinitionId })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead?.stageDefinitionId) return null;

      const [stage] = await tx
        .select({
          id: stageDefinitions.id,
          autoAdvanceCondition: stageDefinitions.autoAdvanceCondition,
          nextStages: stageDefinitions.nextStages,
          kind: stageDefinitions.kind,
        })
        .from(stageDefinitions)
        .where(and(eq(stageDefinitions.id, lead.stageDefinitionId), eq(stageDefinitions.tenantId, tenantId)));
      if (!stage) return null;

      // Only advance non-terminal stages
      if (stage.kind === "terminal_won" || stage.kind === "terminal_lost") return null;
      if (!stage.nextStages.length) return null;

      let condition: { type: string } | null = null;
      try {
        condition = stage.autoAdvanceCondition
          ? (JSON.parse(stage.autoAdvanceCondition) as { type: string })
          : null;
      } catch {
        return null;
      }
      if (condition?.type !== "all_required_fields_filled") return null;

      // Count required fields vs filled values
      const allRequired = await tx
        .select({ id: stageFields.id })
        .from(stageFields)
        .where(and(eq(stageFields.stageId, stage.id), eq(stageFields.required, true)));
      if (allRequired.length === 0) return null;

      const filledRequired = await tx
        .select({ id: leadFieldValues.fieldId })
        .from(leadFieldValues)
        .where(
          and(
            eq(leadFieldValues.leadId, id),
            inArray(leadFieldValues.fieldId, allRequired.map((f) => f.id)),
            sql`${leadFieldValues.valueJson} != 'null' AND ${leadFieldValues.valueJson} != '""' AND ${leadFieldValues.valueJson} != ''`,
          ),
        );
      if (filledRequired.length < allRequired.length) return null;

      // All required fields filled → advance to first allowed next stage
      const nextSlug = stage.nextStages[0]!;
      const [nextStageDef] = await tx
        .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
        .from(stageDefinitions)
        .where(and(eq(stageDefinitions.slug, nextSlug), eq(stageDefinitions.tenantId, tenantId)));
      if (!nextStageDef) return null;

      await tx
        .update(leads)
        .set({ stageDefinitionId: nextStageDef.id, state: nextStageDef.slug, updatedAt: now })
        .where(eq(leads.id, id));

      await tx.insert(leadEvents).values({
        tenantId,
        leadId: id,
        fromState: lead.state,
        toState: nextStageDef.slug,
        byAdminId: undefined,
        createdAt: now,
      });

      return nextStageDef.slug;
    });

    return c.json({ ok: true, advanced: advanced !== null, newStageSlug: advanced });
  });

  /**
   * GET /api/admin/contacts
   * Query: ?q=<search> | ?limit=N | ?offset=N
   * Список контактов для поиска при создании лида.
   */
  app.get("/api/admin/contacts", async (c) => {
    const tenantId = c.var.tenantId;
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
    const q = c.req.query("q")?.trim() ?? "";

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const conditions = [eq(contacts.tenantId, tenantId)];
      if (q.length > 0) {
        conditions.push(
          ilike(contacts.displayName, `%${q}%`) as ReturnType<typeof eq>,
        );
      }
      return tx
        .select({ id: contacts.id, displayName: contacts.displayName })
        .from(contacts)
        .where(and(...conditions))
        .orderBy(desc(contacts.id))
        .limit(limit)
        .offset(offset);
    });

    return c.json({ items: rows, limit, offset });
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
