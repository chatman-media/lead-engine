/**
 * Кампании капельной рассылки.
 *   POST   /api/admin/outreach-campaigns            — создать (+ опц. leadIds)
 *   GET    /api/admin/outreach-campaigns            — список со сводкой статусов
 *   GET    /api/admin/outreach-campaigns/:id        — кампания + разбивка по лидам
 *   PATCH  /api/admin/outreach-campaigns/:id        — статус (activate/pause) и параметры
 *   POST   /api/admin/outreach-campaigns/:id/leads  — добавить лидов
 *
 * Сама выдача (drip) идёт фоном через drip-dispatcher → outbound_queue.
 */
import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { leads, outreachCampaignLeads, outreachCampaigns } from "@chatman-media/storage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

const STATUSES = ["draft", "active", "paused", "completed"];

export function makeAdminOutreachCampaignsRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  async function addLeads(
    tx: Db,
    tenantId: number,
    campaignId: number,
    leadIds: number[],
    nowSec: number,
  ): Promise<number> {
    if (leadIds.length === 0) return 0;
    const valid = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), inArray(leads.id, leadIds)));
    let added = 0;
    for (const l of valid) {
      const ins = await tx
        .insert(outreachCampaignLeads)
        .values({
          campaignId,
          leadId: l.id,
          tenantId,
          status: "pending",
          createdAt: nowSec,
          updatedAt: nowSec,
        })
        .onConflictDoNothing()
        .returning({ id: outreachCampaignLeads.id });
      added += ins.length;
    }
    return added;
  }

  app.post("/api/admin/outreach-campaigns", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const greetingText = typeof body.greetingText === "string" ? body.greetingText.trim() : "";
    if (!name) return c.json({ error: "name required" }, 400);
    if (!greetingText) return c.json({ error: "greetingText required" }, 400);
    const dripPerTick =
      typeof body.dripPerTick === "number" && body.dripPerTick > 0
        ? Math.floor(body.dripPerTick)
        : 1;
    const dripIntervalSec =
      typeof body.dripIntervalSec === "number" && body.dripIntervalSec >= 0
        ? Math.floor(body.dripIntervalSec)
        : 60;
    const leadIds = Array.isArray(body.leadIds)
      ? body.leadIds.filter((x: unknown): x is number => typeof x === "number")
      : [];
    const now = Math.floor(Date.now() / 1000);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [camp] = await tx
        .insert(outreachCampaigns)
        .values({
          tenantId,
          name,
          greetingText,
          dripPerTick,
          dripIntervalSec,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: outreachCampaigns.id });
      const added = await addLeads(tx, tenantId, camp!.id, leadIds, now);
      return { id: camp!.id, added };
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "outreach_campaign.create",
      targetKind: "outreach_campaign",
      targetId: String(result.id),
      details: { name, leads: result.added },
    });
    return c.json({ ok: true, id: result.id, leadsAdded: result.added, status: "draft" });
  });

  app.get("/api/admin/outreach-campaigns", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: outreachCampaigns.id,
          name: outreachCampaigns.name,
          status: outreachCampaigns.status,
          dripPerTick: outreachCampaigns.dripPerTick,
          dripIntervalSec: outreachCampaigns.dripIntervalSec,
          createdAt: outreachCampaigns.createdAt,
          total: sql<number>`count(${outreachCampaignLeads.id})`,
          sent: sql<number>`count(*) filter (where ${outreachCampaignLeads.status} in ('enqueued','sent'))`,
          skipped: sql<number>`count(*) filter (where ${outreachCampaignLeads.status} = 'skipped')`,
          pending: sql<number>`count(*) filter (where ${outreachCampaignLeads.status} = 'pending')`,
        })
        .from(outreachCampaigns)
        .leftJoin(outreachCampaignLeads, eq(outreachCampaignLeads.campaignId, outreachCampaigns.id))
        .where(eq(outreachCampaigns.tenantId, tenantId))
        .groupBy(outreachCampaigns.id)
        .orderBy(sql`${outreachCampaigns.id} DESC`),
    );
    return c.json({ campaigns: rows });
  });

  app.patch("/api/admin/outreach-campaigns/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const now = Math.floor(Date.now() / 1000);
    const patch: Record<string, unknown> = { updatedAt: now };
    if (typeof body.status === "string") {
      if (!STATUSES.includes(body.status)) return c.json({ error: "bad status" }, 400);
      patch.status = body.status;
    }
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.greetingText === "string" && body.greetingText.trim())
      patch.greetingText = body.greetingText.trim();
    if (typeof body.dripPerTick === "number" && body.dripPerTick > 0)
      patch.dripPerTick = Math.floor(body.dripPerTick);
    if (typeof body.dripIntervalSec === "number" && body.dripIntervalSec >= 0)
      patch.dripIntervalSec = Math.floor(body.dripIntervalSec);

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(outreachCampaigns)
        .set(patch)
        .where(and(eq(outreachCampaigns.tenantId, tenantId), eq(outreachCampaigns.id, id)))
        .returning(),
    );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, campaign: row });
  });

  app.post("/api/admin/outreach-campaigns/:id/leads", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const leadIds = Array.isArray(body.leadIds)
      ? body.leadIds.filter((x: unknown): x is number => typeof x === "number")
      : [];
    if (leadIds.length === 0) return c.json({ error: "leadIds required" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const added = await withTenant(opts.db, tenantId, async (tx) => {
      const [camp] = await tx
        .select({ id: outreachCampaigns.id })
        .from(outreachCampaigns)
        .where(and(eq(outreachCampaigns.tenantId, tenantId), eq(outreachCampaigns.id, id)))
        .limit(1);
      if (!camp) return -1;
      return addLeads(tx, tenantId, id, leadIds, now);
    });
    if (added < 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, leadsAdded: added });
  });

  return app;
}
