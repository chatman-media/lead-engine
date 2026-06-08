import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  partnerDeals,
  partners,
  partnerServices,
  stageDefinitions,
} from "@chatman-media/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

export function makeAdminPartnersRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/partners", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const items = await tx
        .select()
        .from(partners)
        .where(eq(partners.tenantId, tenantId))
        .orderBy(desc(partners.id));

      const stats = await tx
        .select({
          partnerId: partnerDeals.partnerId,
          dealsCount: sql<number>`count(${partnerDeals.id})`,
          completedCount: sql<number>`count(CASE WHEN ${partnerDeals.status} = 'completed' THEN 1 END)`,
          commissionTotal: sql<number>`coalesce(sum(CASE WHEN ${partnerDeals.status} IN ('completed','settled') THEN ${partnerDeals.commissionAmount} ELSE 0 END), 0)`,
        })
        .from(partnerDeals)
        .where(eq(partnerDeals.tenantId, tenantId))
        .groupBy(partnerDeals.partnerId);
      const statByPartner = new Map(stats.map((s) => [s.partnerId, s]));

      const serviceStats = await tx
        .select({
          partnerId: partnerServices.partnerId,
          servicesCount: sql<number>`count(${partnerServices.id})`,
        })
        .from(partnerServices)
        .where(eq(partnerServices.tenantId, tenantId))
        .groupBy(partnerServices.partnerId);
      const servicesByPartner = new Map(serviceStats.map((s) => [s.partnerId, Number(s.servicesCount)]));

      return items.map((p) => {
        const st = statByPartner.get(p.id);
        return {
          ...p,
          servicesCount: servicesByPartner.get(p.id) ?? 0,
          dealsCount: st ? Number(st.dealsCount) : 0,
          completedCount: st ? Number(st.completedCount) : 0,
          commissionTotal: st ? Number(st.commissionTotal) : 0,
        };
      });
    });
    return c.json({ items: rows });
  });

  app.post("/api/admin/partners", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    type CreatePartnerBody = {
      name?: string;
      contactName?: string | null;
      contactChannel?: string | null;
      contactValue?: string | null;
      defaultCommissionPct?: number;
      settlementCurrency?: string;
      notes?: string | null;
    };
    const body = await c.req.json<CreatePartnerBody>().catch(() => ({} as CreatePartnerBody));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name required" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(partners)
        .values({
          tenantId,
          name,
          contactName: body.contactName ?? null,
          contactChannel: body.contactChannel ?? null,
          contactValue: body.contactValue ?? null,
          defaultCommissionPct: Number(body.defaultCommissionPct ?? 0),
          settlementCurrency: body.settlementCurrency ?? "THB",
          notes: body.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner.create",
      targetKind: "partner",
      targetId: String(row!.id),
      details: { name },
    });
    return c.json({ item: row }, 201);
  });

  app.patch("/api/admin/partners/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json<Partial<typeof partners.$inferInsert>>().catch(() => ({} as Partial<typeof partners.$inferInsert>));
    const patch: Partial<typeof partners.$inferInsert> = { updatedAt: Math.floor(Date.now() / 1000) };
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (typeof body.status === "string") patch.status = body.status;
    if ("contactName" in body) patch.contactName = body.contactName ?? null;
    if ("contactChannel" in body) patch.contactChannel = body.contactChannel ?? null;
    if ("contactValue" in body) patch.contactValue = body.contactValue ?? null;
    if (typeof body.defaultCommissionPct === "number") patch.defaultCommissionPct = body.defaultCommissionPct;
    if (typeof body.settlementCurrency === "string") patch.settlementCurrency = body.settlementCurrency;
    if ("notes" in body) patch.notes = body.notes ?? null;
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(partners)
        .set(patch)
        .where(and(eq(partners.tenantId, tenantId), eq(partners.id, id)))
        .returning(),
    );
    if (!row) return c.json({ error: "partner not found" }, 404);
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner.update",
      targetKind: "partner",
      targetId: String(id),
      details: patch,
    });
    return c.json({ item: row });
  });

  app.get("/api/admin/partner-services", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: partnerServices.id,
          tenantId: partnerServices.tenantId,
          partnerId: partnerServices.partnerId,
          partnerName: partners.name,
          name: partnerServices.name,
          category: partnerServices.category,
          funnelId: partnerServices.funnelId,
          stageDefinitionId: partnerServices.stageDefinitionId,
          stageName: stageDefinitions.displayName,
          commissionPct: partnerServices.commissionPct,
          isActive: partnerServices.isActive,
          notes: partnerServices.notes,
          createdAt: partnerServices.createdAt,
          updatedAt: partnerServices.updatedAt,
        })
        .from(partnerServices)
        .innerJoin(partners, eq(partners.id, partnerServices.partnerId))
        .leftJoin(stageDefinitions, eq(stageDefinitions.id, partnerServices.stageDefinitionId))
        .where(eq(partnerServices.tenantId, tenantId))
        .orderBy(desc(partnerServices.id)),
    );
    return c.json({ items: rows });
  });

  app.post("/api/admin/partner-services", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    type CreateServiceBody = {
      partnerId?: number;
      name?: string;
      category?: string | null;
      funnelId?: number | null;
      stageDefinitionId?: number | null;
      commissionPct?: number;
      notes?: string | null;
    };
    const body = await c.req.json<CreateServiceBody>().catch(() => ({} as CreateServiceBody));
    if (!body.partnerId || !body.name?.trim()) return c.json({ error: "partnerId and name required" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(partnerServices)
        .values({
          tenantId,
          partnerId: body.partnerId!,
          name: body.name!.trim(),
          category: body.category ?? null,
          funnelId: body.funnelId ?? null,
          stageDefinitionId: body.stageDefinitionId ?? null,
          commissionPct: Number(body.commissionPct ?? 0),
          notes: body.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner_service.create",
      targetKind: "partner_service",
      targetId: String(row!.id),
      details: { partnerId: body.partnerId, name: body.name },
    });
    return c.json({ item: row }, 201);
  });

  app.get("/api/admin/partner-deals", async (c) => {
    const tenantId = c.var.tenantId;
    const status = c.req.query("status");
    const leadIdRaw = c.req.query("leadId");
    const leadId = leadIdRaw ? Number(leadIdRaw) : null;
    const where = and(
      eq(partnerDeals.tenantId, tenantId),
      ...(status ? [eq(partnerDeals.status, status)] : []),
      ...(leadId ? [eq(partnerDeals.leadId, leadId)] : []),
    );
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: partnerDeals.id,
          tenantId: partnerDeals.tenantId,
          partnerId: partnerDeals.partnerId,
          partnerName: partners.name,
          serviceId: partnerDeals.serviceId,
          serviceName: partnerServices.name,
          leadId: partnerDeals.leadId,
          stageDefinitionId: partnerDeals.stageDefinitionId,
          stageName: stageDefinitions.displayName,
          status: partnerDeals.status,
          handoffUrl: partnerDeals.handoffUrl,
          handoffMode: partnerDeals.handoffMode,
          grossAmount: partnerDeals.grossAmount,
          currency: partnerDeals.currency,
          commissionPct: partnerDeals.commissionPct,
          commissionAmount: partnerDeals.commissionAmount,
          notes: partnerDeals.notes,
          sentAt: partnerDeals.sentAt,
          acceptedAt: partnerDeals.acceptedAt,
          completedAt: partnerDeals.completedAt,
          cancelledAt: partnerDeals.cancelledAt,
          settledAt: partnerDeals.settledAt,
          createdAt: partnerDeals.createdAt,
          updatedAt: partnerDeals.updatedAt,
        })
        .from(partnerDeals)
        .leftJoin(partners, eq(partners.id, partnerDeals.partnerId))
        .leftJoin(partnerServices, eq(partnerServices.id, partnerDeals.serviceId))
        .leftJoin(stageDefinitions, eq(stageDefinitions.id, partnerDeals.stageDefinitionId))
        .where(where)
        .orderBy(desc(partnerDeals.id)),
    );
    return c.json({ items: rows });
  });

  app.post("/api/admin/partner-deals", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    type CreateDealBody = {
      partnerId?: number | null;
      serviceId?: number | null;
      leadId?: number | null;
      stageDefinitionId?: number | null;
      grossAmount?: number | null;
      currency?: string;
      commissionPct?: number;
      notes?: string | null;
    };
    const body = await c.req.json<CreateDealBody>().catch(() => ({} as CreateDealBody));
    const now = Math.floor(Date.now() / 1000);
    const gross = body.grossAmount == null ? null : Number(body.grossAmount);
    const pct = Number(body.commissionPct ?? 0);
    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .insert(partnerDeals)
        .values({
          tenantId,
          partnerId: body.partnerId ?? null,
          serviceId: body.serviceId ?? null,
          leadId: body.leadId ?? null,
          stageDefinitionId: body.stageDefinitionId ?? null,
          status: "sent",
          grossAmount: gross,
          currency: body.currency ?? "THB",
          commissionPct: pct,
          commissionAmount: gross == null ? null : roundMoney((gross * pct) / 100),
          notes: body.notes ?? null,
          sentAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner_deal.create",
      targetKind: "partner_deal",
      targetId: String(row!.id),
      details: { partnerId: body.partnerId, leadId: body.leadId },
    });
    return c.json({ item: row }, 201);
  });

  app.patch("/api/admin/partner-deals/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json<Partial<typeof partnerDeals.$inferInsert>>().catch(() => ({} as Partial<typeof partnerDeals.$inferInsert>));
    const now = Math.floor(Date.now() / 1000);
    const patch: Partial<typeof partnerDeals.$inferInsert> = { updatedAt: now };
    if (typeof body.status === "string") patch.status = body.status;
    if ("partnerId" in body) patch.partnerId = body.partnerId ?? null;
    if ("serviceId" in body) patch.serviceId = body.serviceId ?? null;
    if ("grossAmount" in body) patch.grossAmount = body.grossAmount == null ? null : Number(body.grossAmount);
    if (typeof body.currency === "string") patch.currency = body.currency;
    if (typeof body.commissionPct === "number") patch.commissionPct = body.commissionPct;
    if ("notes" in body) patch.notes = body.notes ?? null;
    if ("proofJson" in body) patch.proofJson = body.proofJson ?? null;

    const [existing] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({ grossAmount: partnerDeals.grossAmount, commissionPct: partnerDeals.commissionPct })
        .from(partnerDeals)
        .where(and(eq(partnerDeals.tenantId, tenantId), eq(partnerDeals.id, id))),
    );
    if (!existing) return c.json({ error: "deal not found" }, 404);

    const gross = patch.grossAmount ?? existing.grossAmount;
    const pct = patch.commissionPct ?? existing.commissionPct;
    patch.commissionAmount = gross == null ? null : roundMoney((Number(gross) * Number(pct ?? 0)) / 100);
    if (patch.status === "accepted") patch.acceptedAt = now;
    if (patch.status === "completed") patch.completedAt = now;
    if (patch.status === "cancelled" || patch.status === "rejected") patch.cancelledAt = now;
    if (patch.status === "settled") patch.settledAt = now;

    const [row] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .update(partnerDeals)
        .set(patch)
        .where(and(eq(partnerDeals.tenantId, tenantId), eq(partnerDeals.id, id)))
        .returning(),
    );
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner_deal.update",
      targetKind: "partner_deal",
      targetId: String(id),
      details: patch,
    });
    return c.json({ item: row });
  });

  return app;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
