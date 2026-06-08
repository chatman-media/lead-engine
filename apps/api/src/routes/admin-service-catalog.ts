import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  funnels,
  partners,
  partnerServices,
  serviceCatalogItems,
} from "@chatman-media/storage";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { isUniqueViolation } from "../lib/db-errors.ts";

type RouteType = "manual" | "funnel" | "partner_service" | "webhook";

type CatalogBody = {
  slug?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  routeType?: unknown;
  funnelId?: unknown;
  partnerServiceId?: unknown;
  webhookUrl?: unknown;
  isActive?: unknown;
  sortOrder?: unknown;
  metadataJson?: unknown;
};

type CatalogState = {
  tenantId: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  routeType: RouteType;
  funnelId: number | null;
  partnerServiceId: number | null;
  webhookUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  metadataJson: string;
  createdAt?: number;
  updatedAt: number;
};

export function makeAdminServiceCatalogRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/service-catalog", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .select({
          id: serviceCatalogItems.id,
          tenantId: serviceCatalogItems.tenantId,
          slug: serviceCatalogItems.slug,
          name: serviceCatalogItems.name,
          category: serviceCatalogItems.category,
          description: serviceCatalogItems.description,
          routeType: serviceCatalogItems.routeType,
          funnelId: serviceCatalogItems.funnelId,
          funnelSlug: funnels.slug,
          funnelVerticalTemplateId: funnels.verticalTemplateId,
          partnerServiceId: serviceCatalogItems.partnerServiceId,
          partnerServiceName: partnerServices.name,
          partnerName: partners.name,
          webhookUrl: serviceCatalogItems.webhookUrl,
          isActive: serviceCatalogItems.isActive,
          sortOrder: serviceCatalogItems.sortOrder,
          metadataJson: serviceCatalogItems.metadataJson,
          createdAt: serviceCatalogItems.createdAt,
          updatedAt: serviceCatalogItems.updatedAt,
        })
        .from(serviceCatalogItems)
        .leftJoin(
          funnels,
          and(
            eq(funnels.tenantId, tenantId),
            eq(funnels.id, serviceCatalogItems.funnelId),
          ),
        )
        .leftJoin(
          partnerServices,
          and(
            eq(partnerServices.tenantId, tenantId),
            eq(partnerServices.id, serviceCatalogItems.partnerServiceId),
          ),
        )
        .leftJoin(
          partners,
          and(eq(partners.tenantId, tenantId), eq(partners.id, partnerServices.partnerId)),
        )
        .where(eq(serviceCatalogItems.tenantId, tenantId))
        .orderBy(desc(serviceCatalogItems.isActive), asc(serviceCatalogItems.sortOrder), desc(serviceCatalogItems.id)),
    );

    return c.json({ items: rows });
  });

  app.post("/api/admin/service-catalog/items", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json<CatalogBody>().catch(() => ({} as CatalogBody));
    const now = Math.floor(Date.now() / 1000);
    const built = buildCatalogState({ body, tenantId, now });
    if ("error" in built) return c.json({ error: built.error }, built.status);

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        const targetError = await validateTarget(tx, tenantId, built.state);
        if (targetError) return { error: targetError, status: 400 as const };
        const [row] = await tx.insert(serviceCatalogItems).values(built.state).returning();
        return { item: row };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "service_catalog.create",
        targetKind: "service_catalog_item",
        targetId: String(result.item!.id),
        details: { name: result.item!.name, routeType: result.item!.routeType },
      });
      return c.json({ item: result.item }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "service with this slug already exists" }, 409);
      throw err;
    }
  });

  app.patch("/api/admin/service-catalog/items/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json<CatalogBody>().catch(() => ({} as CatalogBody));
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = await withTenant(opts.db, tenantId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(serviceCatalogItems)
          .where(and(eq(serviceCatalogItems.tenantId, tenantId), eq(serviceCatalogItems.id, id)))
          .limit(1);
        if (!existing) return { error: "service not found", status: 404 as const };

        const built = buildCatalogState({ body, tenantId, now, existing });
        if ("error" in built) return { error: built.error, status: built.status };
        const targetError = await validateTarget(tx, tenantId, built.state);
        if (targetError) return { error: targetError, status: 400 as const };

        const [row] = await tx
          .update(serviceCatalogItems)
          .set(built.state)
          .where(and(eq(serviceCatalogItems.tenantId, tenantId), eq(serviceCatalogItems.id, id)))
          .returning();
        return { item: row };
      });

      if ("error" in result) return c.json({ error: result.error }, result.status);
      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "service_catalog.update",
        targetKind: "service_catalog_item",
        targetId: String(id),
        details: { routeType: result.item!.routeType },
      });
      return c.json({ item: result.item });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "service with this slug already exists" }, 409);
      throw err;
    }
  });

  app.delete("/api/admin/service-catalog/items/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

    const deleted = await withTenant(opts.db, tenantId, async (tx) =>
      tx
        .delete(serviceCatalogItems)
        .where(and(eq(serviceCatalogItems.tenantId, tenantId), eq(serviceCatalogItems.id, id)))
        .returning({ id: serviceCatalogItems.id, name: serviceCatalogItems.name }),
    );
    if (!deleted[0]) return c.json({ error: "service not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "service_catalog.delete",
      targetKind: "service_catalog_item",
      targetId: String(id),
      details: { name: deleted[0].name },
    });
    return c.json({ ok: true });
  });

  return app;
}

function buildCatalogState(input: {
  body: CatalogBody;
  tenantId: number;
  now: number;
  existing?: typeof serviceCatalogItems.$inferSelect;
}): { state: CatalogState } | { error: string; status: 400 } {
  const { body, tenantId, now, existing } = input;
  const name = has(body, "name") ? cleanString(body.name) : (existing?.name ?? "");
  if (!name) return { error: "name required", status: 400 };

  const routeTypeRaw = has(body, "routeType") ? body.routeType : (existing?.routeType ?? "manual");
  const routeType = parseRouteType(routeTypeRaw);
  if (!routeType) return { error: "invalid routeType", status: 400 };

  const slugSource = has(body, "slug") ? cleanString(body.slug) : (existing?.slug ?? name);
  const slug = normalizeSlug(slugSource) || normalizeSlug(name) || `service_${now}`;
  const rawFunnelId = has(body, "funnelId") ? parseOptionalId(body.funnelId) : (existing?.funnelId ?? null);
  const rawPartnerServiceId = has(body, "partnerServiceId")
    ? parseOptionalId(body.partnerServiceId)
    : (existing?.partnerServiceId ?? null);
  const rawWebhookUrl = has(body, "webhookUrl")
    ? cleanString(body.webhookUrl)
    : (existing?.webhookUrl ?? "");
  const webhookUrl = routeType === "webhook" ? normalizeWebhookUrl(rawWebhookUrl) : null;
  const metadataResult = has(body, "metadataJson")
    ? normalizeMetadata(body.metadataJson)
    : { value: existing?.metadataJson ?? "{}" };

  if (routeType === "webhook" && !webhookUrl) {
    return { error: "valid webhookUrl required", status: 400 };
  }
  if ("error" in metadataResult) {
    return { error: metadataResult.error, status: 400 };
  }

  return {
    state: {
      tenantId,
      slug,
      name,
      category: has(body, "category") ? cleanNullableString(body.category) : (existing?.category ?? null),
      description: has(body, "description") ? cleanNullableString(body.description) : (existing?.description ?? null),
      routeType,
      funnelId: routeType === "funnel" ? rawFunnelId : null,
      partnerServiceId: routeType === "partner_service" ? rawPartnerServiceId : null,
      webhookUrl,
      isActive: has(body, "isActive") ? Boolean(body.isActive) : (existing?.isActive ?? true),
      sortOrder: has(body, "sortOrder") ? parseSortOrder(body.sortOrder) : (existing?.sortOrder ?? 0),
      metadataJson: metadataResult.value,
      ...(existing ? {} : { createdAt: now }),
      updatedAt: now,
    },
  };
}

async function validateTarget(
  tx: Db,
  tenantId: number,
  state: CatalogState,
): Promise<string | null> {
  if (state.routeType === "manual") return null;

  if (state.routeType === "funnel") {
    if (!state.funnelId) return "funnelId required";
    const [row] = await tx
      .select({ id: funnels.id })
      .from(funnels)
      .where(and(eq(funnels.tenantId, tenantId), eq(funnels.id, state.funnelId)))
      .limit(1);
    return row ? null : "funnel not found";
  }

  if (state.routeType === "partner_service") {
    if (!state.partnerServiceId) return "partnerServiceId required";
    const [row] = await tx
      .select({ id: partnerServices.id })
      .from(partnerServices)
      .where(and(eq(partnerServices.tenantId, tenantId), eq(partnerServices.id, state.partnerServiceId)))
      .limit(1);
    return row ? null : "partner service not found";
  }

  return state.webhookUrl ? null : "valid webhookUrl required";
}

function has(obj: object, key: keyof CatalogBody): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseRouteType(value: unknown): RouteType | null {
  if (value === "manual" || value === "funnel" || value === "partner_service" || value === "webhook") {
    return value;
  }
  return null;
}

function parseOptionalId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseSortOrder(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNullableString(value: unknown): string | null {
  const str = cleanString(value);
  return str ? str : null;
}

function normalizeWebhookUrl(value: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeMetadata(value: unknown): { value: string } | { error: string } {
  if (value === null || value === undefined) return { value: "{}" };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { value: "{}" };
    try {
      JSON.parse(trimmed);
      return { value: trimmed };
    } catch {
      return { error: "metadataJson must be valid JSON" };
    }
  }
  return { value: JSON.stringify(value) };
}

function normalizeSlug(value: string): string {
  return transliterate(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function transliterate(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
    й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
    у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ы: "y", э: "e",
    ю: "yu", я: "ya", ъ: "", ь: "",
  };
  return value
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}
