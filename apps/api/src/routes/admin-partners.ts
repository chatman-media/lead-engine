import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  partnerDeals,
  partners,
  partnerServices,
  partnerSettlements,
  stageDefinitions,
} from "@chatman-media/storage";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
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
      const servicesByPartner = new Map(
        serviceStats.map((s) => [s.partnerId, Number(s.servicesCount)]),
      );

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
    const body = await c.req.json<CreatePartnerBody>().catch(() => ({}) as CreatePartnerBody);
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
    const body = await c.req
      .json<Partial<typeof partners.$inferInsert>>()
      .catch(() => ({}) as Partial<typeof partners.$inferInsert>);
    const patch: Partial<typeof partners.$inferInsert> = {
      updatedAt: Math.floor(Date.now() / 1000),
    };
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (typeof body.status === "string") patch.status = body.status;
    if ("contactName" in body) patch.contactName = body.contactName ?? null;
    if ("contactChannel" in body) patch.contactChannel = body.contactChannel ?? null;
    if ("contactValue" in body) patch.contactValue = body.contactValue ?? null;
    if (typeof body.defaultCommissionPct === "number")
      patch.defaultCommissionPct = body.defaultCommissionPct;
    if (typeof body.settlementCurrency === "string")
      patch.settlementCurrency = body.settlementCurrency;
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
    const body = await c.req.json<CreateServiceBody>().catch(() => ({}) as CreateServiceBody);
    if (!body.partnerId || !body.name?.trim())
      return c.json({ error: "partnerId and name required" }, 400);
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
          partnerServiceNotes: partnerServices.notes,
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
    const body = await c.req.json<CreateDealBody>().catch(() => ({}) as CreateDealBody);
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
    const body = await c.req
      .json<Partial<typeof partnerDeals.$inferInsert>>()
      .catch(() => ({}) as Partial<typeof partnerDeals.$inferInsert>);
    const now = Math.floor(Date.now() / 1000);
    const patch: Partial<typeof partnerDeals.$inferInsert> = { updatedAt: now };
    if (typeof body.status === "string") patch.status = body.status;
    if ("partnerId" in body) patch.partnerId = body.partnerId ?? null;
    if ("serviceId" in body) patch.serviceId = body.serviceId ?? null;
    if ("grossAmount" in body)
      patch.grossAmount = body.grossAmount == null ? null : Number(body.grossAmount);
    if (typeof body.currency === "string") patch.currency = body.currency;
    if (typeof body.commissionPct === "number") patch.commissionPct = body.commissionPct;
    if ("notes" in body) patch.notes = body.notes ?? null;
    if ("proofJson" in body) patch.proofJson = body.proofJson ?? null;

    const [existing] = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          grossAmount: partnerDeals.grossAmount,
          commissionPct: partnerDeals.commissionPct,
        })
        .from(partnerDeals)
        .where(and(eq(partnerDeals.tenantId, tenantId), eq(partnerDeals.id, id))),
    );
    if (!existing) return c.json({ error: "deal not found" }, 404);

    const gross = patch.grossAmount ?? existing.grossAmount;
    const pct = patch.commissionPct ?? existing.commissionPct;
    patch.commissionAmount =
      gross == null ? null : roundMoney((Number(gross) * Number(pct ?? 0)) / 100);
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

  app.get("/api/admin/partner-settlements", async (c) => {
    const tenantId = c.var.tenantId;
    const partnerIdRaw = c.req.query("partnerId");
    const partnerId = partnerIdRaw ? Number(partnerIdRaw) : null;
    const status = c.req.query("status");
    const where = and(
      eq(partnerSettlements.tenantId, tenantId),
      ...(partnerId ? [eq(partnerSettlements.partnerId, partnerId)] : []),
      ...(status ? [eq(partnerSettlements.status, status)] : []),
    );
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const items = await tx
        .select({
          id: partnerSettlements.id,
          tenantId: partnerSettlements.tenantId,
          partnerId: partnerSettlements.partnerId,
          partnerName: partners.name,
          periodStart: partnerSettlements.periodStart,
          periodEnd: partnerSettlements.periodEnd,
          status: partnerSettlements.status,
          totalGross: partnerSettlements.totalGross,
          totalCommission: partnerSettlements.totalCommission,
          currency: partnerSettlements.currency,
          paidAt: partnerSettlements.paidAt,
          notes: partnerSettlements.notes,
          createdAt: partnerSettlements.createdAt,
          updatedAt: partnerSettlements.updatedAt,
        })
        .from(partnerSettlements)
        .innerJoin(partners, eq(partners.id, partnerSettlements.partnerId))
        .where(where)
        .orderBy(desc(partnerSettlements.id));

      const counts = await tx
        .select({
          settlementId: partnerDeals.settlementId,
          dealsCount: sql<number>`count(${partnerDeals.id})`,
        })
        .from(partnerDeals)
        .where(and(eq(partnerDeals.tenantId, tenantId), isNotNull(partnerDeals.settlementId)))
        .groupBy(partnerDeals.settlementId);
      const countBySettlement = new Map(counts.map((r) => [r.settlementId, Number(r.dealsCount)]));

      return items.map((s) => ({ ...s, dealsCount: countBySettlement.get(s.id) ?? 0 }));
    });
    return c.json({ items: rows });
  });

  app.post("/api/admin/partner-settlements", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    type CreateSettlementBody = {
      partnerId?: number;
      periodStart?: number;
      periodEnd?: number;
      notes?: string | null;
    };
    const body = await c.req.json<CreateSettlementBody>().catch(() => ({}) as CreateSettlementBody);
    const partnerId = Number(body.partnerId);
    const periodStart = Number(body.periodStart);
    const periodEnd = Number(body.periodEnd);
    if (!Number.isInteger(partnerId) || partnerId <= 0) {
      return c.json({ error: "partnerId required" }, 400);
    }
    if (
      !Number.isInteger(periodStart) ||
      !Number.isInteger(periodEnd) ||
      periodStart >= periodEnd
    ) {
      return c.json(
        { error: "periodStart/periodEnd must be epoch seconds, periodStart < periodEnd" },
        400,
      );
    }
    const now = Math.floor(Date.now() / 1000);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [partner] = await tx
        .select({ id: partners.id })
        .from(partners)
        .where(and(eq(partners.tenantId, tenantId), eq(partners.id, partnerId)));
      if (!partner) return { kind: "partner_not_found" as const };

      // Деньги к выплате = завершённые сделки периода, ещё не включённые
      // в другой settlement (settlement_id защищает от двойного счёта
      // при пересекающихся периодах).
      const deals = await tx
        .select({
          id: partnerDeals.id,
          grossAmount: partnerDeals.grossAmount,
          commissionAmount: partnerDeals.commissionAmount,
          currency: partnerDeals.currency,
        })
        .from(partnerDeals)
        .where(
          and(
            eq(partnerDeals.tenantId, tenantId),
            eq(partnerDeals.partnerId, partnerId),
            eq(partnerDeals.status, "completed"),
            isNull(partnerDeals.settlementId),
            gte(partnerDeals.completedAt, periodStart),
            lt(partnerDeals.completedAt, periodEnd),
          ),
        );
      if (deals.length === 0) return { kind: "no_deals" as const };

      const currencies = [...new Set(deals.map((d) => d.currency))];
      if (currencies.length > 1) return { kind: "mixed_currencies" as const, currencies };

      const totalGross = roundMoney(deals.reduce((acc, d) => acc + (d.grossAmount ?? 0), 0));
      const totalCommission = roundMoney(
        deals.reduce((acc, d) => acc + (d.commissionAmount ?? 0), 0),
      );
      const [row] = await tx
        .insert(partnerSettlements)
        .values({
          tenantId,
          partnerId,
          periodStart,
          periodEnd,
          status: "draft",
          totalGross,
          totalCommission,
          currency: currencies[0]!,
          notes: body.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx
        .update(partnerDeals)
        .set({ settlementId: row!.id, updatedAt: now })
        .where(
          and(
            eq(partnerDeals.tenantId, tenantId),
            inArray(
              partnerDeals.id,
              deals.map((d) => d.id),
            ),
          ),
        );
      return { kind: "ok" as const, row: row!, dealsCount: deals.length };
    });

    if (result.kind === "partner_not_found") return c.json({ error: "partner not found" }, 404);
    if (result.kind === "no_deals") {
      return c.json({ error: "no unsettled completed deals in period" }, 409);
    }
    if (result.kind === "mixed_currencies") {
      return c.json({ error: "deals have mixed currencies", currencies: result.currencies }, 409);
    }
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner_settlement.create",
      targetKind: "partner_settlement",
      targetId: String(result.row.id),
      details: { partnerId, periodStart, periodEnd, dealsCount: result.dealsCount },
    });
    return c.json({ item: result.row, dealsCount: result.dealsCount }, 201);
  });

  app.patch("/api/admin/partner-settlements/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    type PatchSettlementBody = { status?: string; notes?: string | null };
    const body = await c.req.json<PatchSettlementBody>().catch(() => ({}) as PatchSettlementBody);
    const nextStatus = typeof body.status === "string" ? body.status : null;
    const now = Math.floor(Date.now() / 1000);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: partnerSettlements.id, status: partnerSettlements.status })
        .from(partnerSettlements)
        .where(and(eq(partnerSettlements.tenantId, tenantId), eq(partnerSettlements.id, id)));
      if (!existing) return { kind: "not_found" as const };

      const patch: Partial<typeof partnerSettlements.$inferInsert> = { updatedAt: now };
      if ("notes" in body) patch.notes = body.notes ?? null;
      if (nextStatus) {
        const allowed = SETTLEMENT_TRANSITIONS[existing.status] ?? [];
        if (!allowed.includes(nextStatus)) {
          return { kind: "invalid_transition" as const, from: existing.status, to: nextStatus };
        }
        patch.status = nextStatus;
        if (nextStatus === "paid") patch.paidAt = now;
      }

      const [row] = await tx
        .update(partnerSettlements)
        .set(patch)
        .where(and(eq(partnerSettlements.tenantId, tenantId), eq(partnerSettlements.id, id)))
        .returning();

      if (nextStatus === "paid") {
        await tx
          .update(partnerDeals)
          .set({ status: "settled", settledAt: now, updatedAt: now })
          .where(
            and(
              eq(partnerDeals.tenantId, tenantId),
              eq(partnerDeals.settlementId, id),
              eq(partnerDeals.status, "completed"),
            ),
          );
      } else if (nextStatus === "cancelled") {
        // Отменённый settlement отпускает сделки обратно в пул —
        // их сможет подобрать следующий период.
        await tx
          .update(partnerDeals)
          .set({ settlementId: null, updatedAt: now })
          .where(and(eq(partnerDeals.tenantId, tenantId), eq(partnerDeals.settlementId, id)));
      }
      return { kind: "ok" as const, row: row! };
    });

    if (result.kind === "not_found") return c.json({ error: "settlement not found" }, 404);
    if (result.kind === "invalid_transition") {
      return c.json({ error: `cannot transition ${result.from} -> ${result.to}` }, 409);
    }
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "partner_settlement.update",
      targetKind: "partner_settlement",
      targetId: String(id),
      details: { status: nextStatus ?? undefined, notesUpdated: "notes" in body },
    });
    return c.json({ item: result.row });
  });

  return app;
}

const SETTLEMENT_TRANSITIONS: Record<string, string[]> = {
  draft: ["issued", "paid", "cancelled"],
  issued: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
