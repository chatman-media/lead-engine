import { type Db, withTenant, type NotificationService } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  contacts,
  conversations,
  leadEvents,
  leadFieldValues,
  leadNotes,
  leads,
  messages,
  outboundQueue,
  stageDefinitions,
  stageFields,
} from "@chatman-media/storage";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { canAddLead } from "../lib/quota.ts";
import { fireStageWebhooks, type StageChangedPayload } from "./admin-stage-webhooks.ts";
import { adminEventBus } from "../lib/admin-event-bus.ts";
import { advanceLead } from "../lib/advance-lead.ts";

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
  notificationService?: NotificationService;
}

export function makeAdminLeadsRoutes(opts: AdminLeadsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * POST /api/admin/leads/:id/advance
   * Operator-in-the-loop: подтвердить текущую operator-стадию и перейти на
   * следующую (next_stages[0]) прямо со страницы лида. Пишет сообщение в чат
   * клиента, не глушит AI, пингует оператора при входе в awaiting_operator.
   */
  app.post("/api/admin/leads/:id/advance", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const leadId = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return c.json({ error: "invalid lead id" }, 400);
    }
    let note = "";
    try {
      const b = (await c.req.json()) as { text?: unknown };
      if (typeof b.text === "string") note = b.text.trim().slice(0, 2000);
    } catch {
      /* пустое тело допустимо */
    }

    const outcome = await advanceLead({
      db: opts.db,
      tenantId,
      ...(adminId !== undefined ? { adminId } : {}),
      ...(note ? { note } : {}),
      selector: { leadId },
      notifications: opts.notificationService ?? null,
    });

    if (outcome.kind === "no_lead") {
      return c.json({ error: "lead has no funnel stage" }, 409);
    }
    if (outcome.kind === "terminal") {
      return c.json({ error: "lead already at terminal stage", stage: outcome.stage }, 409);
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.advance",
      targetKind: "lead",
      targetId: String(outcome.leadId),
      details: { from: outcome.from, to: outcome.to },
    });
    adminEventBus.emit({
      type: "stage_changed",
      tenantId,
      leadId: outcome.leadId,
      toStage: outcome.to,
      toStageDisplayName: outcome.toDisplayName,
    });

    return c.json({
      ok: true,
      from: outcome.from,
      to: outcome.to,
      toDisplayName: outcome.toDisplayName,
      awaitingOperator: outcome.awaitingOperator,
      terminal: outcome.terminal,
    });
  });

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
          requestType: leads.requestType,
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
          // Стадия (лейбл + фаза + тип + цвет + позиция) — для карточки.
          stageName: stageDefinitions.displayName,
          stagePhase: stageDefinitions.phase,
          stageType: stageDefinitions.stageType,
          stageColor: stageDefinitions.color,
          stagePosition: stageDefinitions.position,
          funnelStageCount: sql<number>`(
            SELECT COUNT(*) FROM stage_definitions sd2 WHERE sd2.funnel_id = ${stageDefinitions.funnelId}
          )`,
          // Последняя активность диалога контакта — превью + время + канал.
          lastMessageText: sql<string | null>`(
            SELECT cv.last_message_text FROM conversations cv
            WHERE cv.tenant_id = ${tenantId} AND cv.user_id = ${leads.userId}
            ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1
          )`,
          lastMessageAt: sql<number | null>`(
            SELECT cv.last_message_at FROM conversations cv
            WHERE cv.tenant_id = ${tenantId} AND cv.user_id = ${leads.userId}
            ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1
          )`,
          source: sql<string | null>`(
            SELECT cv.source FROM conversations cv
            WHERE cv.tenant_id = ${tenantId} AND cv.user_id = ${leads.userId}
            ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1
          )`,
          // Ключевые заполненные поля (лейбл + значение) — суть лида.
          keyFields: sql<Array<{ label: string; value: string }>>`(
            SELECT COALESCE(json_agg(json_build_object('label', sf.display_name, 'value', lfv.value_json) ORDER BY sf.position), '[]'::json)
            FROM lead_field_values lfv
            JOIN stage_fields sf ON lfv.field_id = sf.id
            WHERE lfv.lead_id = ${leads.id}
              AND lfv.value_json NOT IN ('null', '""')
          )`,
        })
        .from(leads)
        .leftJoin(contacts, eq(leads.userId, contacts.id))
        .leftJoin(stageDefinitions, eq(leads.stageDefinitionId, stageDefinitions.id))
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

    const quota = await canAddLead({ db: opts.db, tenantId });
    if (!quota.allowed) {
      return c.json({
        error: "leads_limit_reached",
        upgradeHint: `Лимит лидов на плане ${quota.planLabel}: ${quota.limit}. Повысьте план для продолжения.`,
        current: quota.current,
        limit: quota.limit,
      }, 402);
    }

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
   * POST /api/admin/leads/import
   * Body: text/csv или multipart field "file"
   * Columns (header row required): name, phone, email, stage_slug
   *   - name: отображаемое имя контакта (обязательно)
   *   - phone, email: опционально
   *   - stage_slug: slug стадии воронки (опционально, дефолт — первая стадия)
   * Returns: { imported, skipped, errors: string[] }
   */
  app.post("/api/admin/leads/import", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;

    // Accept either text/csv body or multipart form field "file"
    const ct = c.req.header("content-type") ?? "";
    let csvText: string;
    if (ct.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return c.json({ error: "file field required" }, 400);
      csvText = await (file as File).text();
    } else {
      csvText = await c.req.text();
    }

    // Minimal CSV parser: handles quoted fields with commas/newlines inside.
    function parseCsv(raw: string): string[][] {
      const result: string[][] = [];
      let row: string[] = [];
      let field = "";
      let inQuote = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inQuote) {
          if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
          else if (ch === '"') { inQuote = false; }
          else { field += ch; }
        } else {
          if (ch === '"') { inQuote = true; }
          else if (ch === ',') { row.push(field); field = ""; }
          else if (ch === '\r' && raw[i + 1] === '\n') { row.push(field); field = ""; result.push(row); row = []; i++; }
          else if (ch === '\n') { row.push(field); field = ""; result.push(row); row = []; }
          else { field += ch; }
        }
      }
      if (field || row.length) { row.push(field); result.push(row); }
      return result.filter((r) => r.some((c) => c.trim()));
    }

    const rows = parseCsv(csvText.trim());
    if (rows.length < 2) return c.json({ error: "CSV must have header + at least one data row" }, 400);

    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const colName = header.indexOf("name");
    const colPhone = header.indexOf("phone");
    const colEmail = header.indexOf("email");
    const colStage = header.indexOf("stage_slug");

    if (colName === -1) return c.json({ error: "CSV header must include 'name' column" }, 400);

    // Pre-load stage definitions for slug → id lookup
    const stageDefs = await withTenant(opts.db, tenantId, async (tx) =>
      tx.select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
        .from(stageDefinitions)
        .where(eq(stageDefinitions.tenantId, tenantId)),
    );
    const stageBySlug = new Map(stageDefs.map((s) => [s.slug, s.id]));
    const defaultStageId = stageDefs[0]?.id ?? null;

    const quota = await canAddLead({ db: opts.db, tenantId });
    if (!quota.allowed) {
      return c.json({ error: "leads_limit_reached", limit: quota.limit, current: quota.current }, 402);
    }

    const dataRows = rows.slice(1);
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i];
      if (!cells) { skipped++; continue; }

      const name = colName >= 0 ? (cells[colName] ?? "").trim() : "";
      if (!name) { skipped++; continue; }

      const phone = colPhone >= 0 ? (cells[colPhone] ?? "").trim() || null : null;
      const email = colEmail >= 0 ? (cells[colEmail] ?? "").trim() || null : null;
      const stageSlug = colStage >= 0 ? (cells[colStage] ?? "").trim() || null : null;
      const stageId = stageSlug ? (stageBySlug.get(stageSlug) ?? defaultStageId) : defaultStageId;

      try {
        await withTenant(opts.db, tenantId, async (tx) => {
          const attrs: Record<string, string> = {};
          if (phone) attrs.phone = phone;
          if (email) attrs.email = email;
          const [contact] = await tx
            .insert(contacts)
            .values({
              tenantId,
              displayName: name,
              attributesJson: Object.keys(attrs).length ? JSON.stringify(attrs) : null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: contacts.id });
          if (!contact) throw new Error("contact insert failed");

          await tx.insert(leads).values({
            tenantId,
            userId: contact.id,
            state: "intake_pending",
            stageDefinitionId: stageId,
            createdAt: now,
            updatedAt: now,
          });
        });
        imported++;
      } catch (err) {
        errors.push(`Row ${i + 2}: ${(err as Error).message}`);
        skipped++;
      }
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.import",
      targetKind: "lead",
      details: { imported, skipped, total: dataRows.length },
    });

    return c.json({ imported, skipped, errors }, 200);
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
    let webhookPayload: StageChangedPayload | null = null as StageChangedPayload | null;

    await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select({
          id: leads.id,
          userId: leads.userId,
          state: leads.state,
          stageDefinitionId: leads.stageDefinitionId,
        })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) throw new Error("lead not found");

      const [newStage] = await tx
        .select({ slug: stageDefinitions.slug, displayName: stageDefinitions.displayName })
        .from(stageDefinitions)
        .where(and(eq(stageDefinitions.id, stageDefinitionId), eq(stageDefinitions.tenantId, tenantId)));
      if (!newStage) throw new Error("stage not found");

      // Validate transition against current stage's nextStages whitelist.
      // Skip if: no current stage (legacy lead), force override, or same stage.
      let prevStage: { id: number; slug: string; displayName: string } | null = null;
      if (lead.stageDefinitionId && lead.stageDefinitionId !== stageDefinitionId && !force) {
        const [currentStage] = await tx
          .select({ nextStages: stageDefinitions.nextStages, slug: stageDefinitions.slug, displayName: stageDefinitions.displayName })
          .from(stageDefinitions)
          .where(
            and(
              eq(stageDefinitions.id, lead.stageDefinitionId),
              eq(stageDefinitions.tenantId, tenantId),
            ),
          );
        if (currentStage) {
          prevStage = { id: lead.stageDefinitionId, slug: currentStage.slug, displayName: currentStage.displayName };
          // If nextStages is non-empty, enforce whitelist.
          if (currentStage.nextStages.length > 0 && !currentStage.nextStages.includes(newStage.slug)) {
            transitionBlocked = true;
            return;
          }
        }
      } else if (lead.stageDefinitionId) {
        const [cs] = await tx
          .select({ slug: stageDefinitions.slug, displayName: stageDefinitions.displayName })
          .from(stageDefinitions)
          .where(eq(stageDefinitions.id, lead.stageDefinitionId));
        if (cs) prevStage = { id: lead.stageDefinitionId, slug: cs.slug, displayName: cs.displayName };
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

      const [contact] = await tx
        .select({ displayName: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.id, lead.userId));

      webhookPayload = {
        event: "lead.stage_changed",
        tenantId,
        leadId: id,
        contactId: lead.userId,
        contactName: contact?.displayName ?? null,
        from: prevStage
          ? { stageId: prevStage.id, slug: prevStage.slug, displayName: prevStage.displayName }
          : null,
        to: { stageId: stageDefinitionId, slug: newStage.slug, displayName: newStage.displayName },
        timestamp: now,
      };
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

    if (webhookPayload) {
      const wp = webhookPayload;
      void fireStageWebhooks(opts.db, tenantId, wp);
      adminEventBus.emit({
        type: "stage_changed",
        tenantId,
        leadId: id,
        toStage: wp.to.slug,
        toStageDisplayName: wp.to.displayName,
      });

      if (opts.notificationService) {
        void opts.notificationService.notify({
          tenantId,
          eventType: "stage_changed",
          leadId: id,
          contactId: wp.contactId,
          data: {
            fromStage: wp.from?.displayName ?? "Unknown",
            toStage: wp.to.displayName,
            displayName: wp.contactName || "Без имени",
          },
        });
      }
    }

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

  /**
   * POST /api/admin/leads/:id/send-photo
   * Body: { photoRef: string, caption?: string }
   *
   * Отправляет фото клиенту лида в его активный канал. photoRef — это
   * Telegram file_id ИЛИ публичный HTTPS-URL изображения (Telegram sendPhoto
   * принимает оба варианта в поле photo). Основной кейс: оператор обменки
   * отправляет cardless-withdrawal QR клиенту ("в админку → дальше в чат").
   */
  app.post("/api/admin/leads/:id/send-photo", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    let body: { photoRef?: unknown; caption?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const photoRef = typeof body.photoRef === "string" ? body.photoRef.trim() : "";
    const caption =
      typeof body.caption === "string" ? body.caption.trim().slice(0, 1024) : "";
    if (!photoRef)
      return c.json({ error: "photoRef required (file_id or https URL)" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const outcome = await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select({ id: leads.id, userId: leads.userId })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) return { kind: "not_found" } as const;

      const [identity] = await tx
        .select({
          channelDbId: channels.id,
          channelKind: channels.kind,
          externalUserId: channelIdentities.externalUserId,
        })
        .from(channelIdentities)
        .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
        .where(
          and(
            eq(channelIdentities.contactId, lead.userId),
            eq(channels.status, "active"),
          ),
        )
        .limit(1);
      if (!identity) return { kind: "no_channel" } as const;

      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.userId, lead.userId),
          ),
        )
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1);

      if (conv?.id) {
        await tx.insert(messages).values({
          tenantId,
          conversationId: conv.id,
          role: "human",
          text: caption || "[photo]",
          metaJson: JSON.stringify({ adminId, sentVia: "admin-send-photo", photo: true }),
          createdAt: now,
        });
      }

      const envelope = {
        channelId: String(identity.channelDbId),
        externalUserId: identity.externalUserId,
        parts: [
          {
            kind: "photo",
            mediaRef: { channelId: String(identity.channelDbId), externalRef: photoRef },
            ...(caption ? { caption } : {}),
          },
        ],
      };
      await tx.insert(outboundQueue).values({
        tenantId,
        channelId: identity.channelDbId,
        conversationId: conv?.id ?? null,
        payloadJson: JSON.stringify(envelope),
        idempotencyKey: `admin-photo-${id}-${now}`,
        scheduledAt: now,
        createdAt: now,
      });

      return { kind: "sent", channelKind: identity.channelKind } as const;
    });

    if (outcome.kind === "not_found") return c.json({ error: "lead not found" }, 404);
    if (outcome.kind === "no_channel") {
      return c.json({ error: "no active channel for this contact — cannot deliver" }, 409);
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.send_photo",
      targetKind: "lead",
      targetId: String(id),
      details: { channelKind: outcome.channelKind },
    });

    return c.json({ ok: true, channelKind: outcome.channelKind });
  });

  /**
   * POST /api/admin/leads/:id/send-offer
   * Body: { text: string }
   *
   * Оператор-ассистируемый фулфилмент: отправляет гостю текст (обычно оффер —
   * заполненные оператором цена/время) в активный канал, НЕ переключая разговор
   * в human — AI продолжает вести. Если лид на стадии `awaiting_operator`
   * (концерж offer) — отправка оффера ЗАВЕРШАЕТ стадию: лид двигается по
   * nextStages[0] (offer→fulfill) + fires stage-change нотификации (webhooks /
   * eventBus / informer). Сообщение попадает в историю (role=human → как
   * assistant), так что бот видит оффер в контексте. Парный к send-photo.
   */
  app.post("/api/admin/leads/:id/send-offer", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = (c.var.adminId as number | null) ?? undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    let body: { text?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);
    if (text.length > 4000) return c.json({ error: "text too long (max 4000)" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const outcome = await withTenant(opts.db, tenantId, async (tx) => {
      const [lead] = await tx
        .select({
          id: leads.id,
          userId: leads.userId,
          state: leads.state,
          stageDefinitionId: leads.stageDefinitionId,
        })
        .from(leads)
        .where(and(eq(leads.id, id), eq(leads.tenantId, tenantId)));
      if (!lead) return { kind: "not_found" } as const;

      const [identity] = await tx
        .select({
          channelDbId: channels.id,
          channelKind: channels.kind,
          externalUserId: channelIdentities.externalUserId,
        })
        .from(channelIdentities)
        .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
        .where(
          and(
            eq(channelIdentities.contactId, lead.userId),
            eq(channels.status, "active"),
          ),
        )
        .limit(1);
      if (!identity) return { kind: "no_channel" } as const;

      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.userId, lead.userId),
          ),
        )
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1);

      if (conv?.id) {
        await tx.insert(messages).values({
          tenantId,
          conversationId: conv.id,
          role: "human",
          text,
          metaJson: JSON.stringify({ adminId, sentVia: "operator-offer" }),
          createdAt: now,
        });
        // Превью + lastMessageAt; mode НЕ трогаем — AI продолжает вести.
        await tx
          .update(conversations)
          .set({ lastMessageAt: now, lastMessageText: text.slice(0, 200) })
          .where(eq(conversations.id, conv.id));
      }

      const envelope = {
        channelId: String(identity.channelDbId),
        externalUserId: identity.externalUserId,
        parts: [{ kind: "text", text }],
      };
      await tx.insert(outboundQueue).values({
        tenantId,
        channelId: identity.channelDbId,
        conversationId: conv?.id ?? null,
        payloadJson: JSON.stringify(envelope),
        idempotencyKey: `lead-offer-${id}-${now}`,
        scheduledAt: now,
        createdAt: now,
      });

      // awaiting_operator: отправка оффера = «оператор завершил стадию» → двигаем
      // лид по nextStages[0] (offer→fulfill). Прочие стадии — только отправка.
      let webhookPayload: StageChangedPayload | null = null;
      if (lead.stageDefinitionId) {
        const [curStage] = await tx
          .select({
            slug: stageDefinitions.slug,
            displayName: stageDefinitions.displayName,
            stageType: stageDefinitions.stageType,
            nextStages: stageDefinitions.nextStages,
          })
          .from(stageDefinitions)
          .where(eq(stageDefinitions.id, lead.stageDefinitionId));
        const nextSlug = curStage?.nextStages?.[0];
        if (curStage?.stageType === "awaiting_operator" && nextSlug) {
          const [next] = await tx
            .select({ id: stageDefinitions.id, slug: stageDefinitions.slug, displayName: stageDefinitions.displayName })
            .from(stageDefinitions)
            .where(and(eq(stageDefinitions.slug, nextSlug), eq(stageDefinitions.tenantId, tenantId)));
          if (next) {
            await tx
              .update(leads)
              .set({ stageDefinitionId: next.id, state: next.slug, updatedAt: now })
              .where(eq(leads.id, id));
            await tx.insert(leadEvents).values({
              tenantId,
              leadId: id,
              fromState: lead.state,
              toState: next.slug,
              byAdminId: adminId,
              createdAt: now,
            });
            const [contact] = await tx
              .select({ displayName: contacts.displayName })
              .from(contacts)
              .where(eq(contacts.id, lead.userId));
            webhookPayload = {
              event: "lead.stage_changed",
              tenantId,
              leadId: id,
              contactId: lead.userId,
              contactName: contact?.displayName ?? null,
              from: { stageId: lead.stageDefinitionId, slug: curStage.slug, displayName: curStage.displayName },
              to: { stageId: next.id, slug: next.slug, displayName: next.displayName },
              timestamp: now,
            };
          }
        }
      }

      return {
        kind: "sent",
        channelKind: identity.channelKind,
        webhookPayload,
      } as const;
    });

    if (outcome.kind === "not_found") return c.json({ error: "lead not found" }, 404);
    if (outcome.kind === "no_channel") {
      return c.json({ error: "no active channel for this contact — cannot deliver" }, 409);
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "lead.send_offer",
      targetKind: "lead",
      targetId: String(id),
      details: {
        channelKind: outcome.channelKind,
        textLength: text.length,
        advancedTo: outcome.webhookPayload?.to.slug ?? null,
      },
    });

    // Стадия была awaiting_operator и лид продвинут → нотифицируем как обычный
    // stage-change (webhooks / admin event bus / informer-оператор).
    if (outcome.webhookPayload) {
      const wp = outcome.webhookPayload;
      void fireStageWebhooks(opts.db, tenantId, wp);
      adminEventBus.emit({
        type: "stage_changed",
        tenantId,
        leadId: id,
        toStage: wp.to.slug,
        toStageDisplayName: wp.to.displayName,
      });
      if (opts.notificationService) {
        void opts.notificationService.notify({
          tenantId,
          eventType: "stage_changed",
          leadId: id,
          contactId: wp.contactId,
          data: {
            fromStage: wp.from?.displayName ?? "Unknown",
            toStage: wp.to.displayName,
            displayName: wp.contactName || "Без имени",
          },
        });
      }
    }

    return c.json({
      ok: true,
      channelKind: outcome.channelKind,
      advancedTo: outcome.webhookPayload?.to.slug ?? null,
    });
  });

  return app;
}
