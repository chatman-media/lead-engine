import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  contacts,
  providerProfiles,
  providerServices,
  serviceOrders,
} from "@chatman-media/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

const PROVIDER_STATUSES = new Set(["active", "paused", "archived"]);

type RouteErrorStatus = 400 | 404 | 409;

class RouteError extends Error {
  constructor(
    public readonly status: RouteErrorStatus,
    message: string,
  ) {
    super(message);
  }
}

interface ProviderIdentityInput {
  channelId?: number;
  externalUserId?: string;
}

interface ProviderServiceInput {
  serviceType?: string;
  name?: string;
  serviceArea?: string | null;
  pricingPolicyJson?: string | Record<string, unknown> | null;
  commissionPct?: number | null;
  isActive?: boolean;
  metadataJson?: string | Record<string, unknown> | null;
}

interface ProviderWhatsAppOptInInput {
  source?: string;
  acceptedAt?: number;
  categories?: string[];
}

interface ProviderWhatsAppTemplateInput {
  name?: string;
  languageCode?: string;
  category?: string;
  approved?: boolean;
  components?: unknown[];
}

interface CreateProviderBody {
  name?: string;
  category?: string | null;
  serviceArea?: string | null;
  defaultCommissionPct?: number;
  notes?: string | null;
  metadataJson?: string | Record<string, unknown> | null;
  whatsappOptIn?: ProviderWhatsAppOptInInput | null;
  whatsappProviderRequestTemplate?: ProviderWhatsAppTemplateInput | null;
  identity?: ProviderIdentityInput | null;
  services?: ProviderServiceInput[];
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function jsonText(value: unknown, fallback = "{}"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return fallback;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function providerMetadataText(
  body: {
    metadataJson?: string | Record<string, unknown> | null;
    whatsappOptIn?: ProviderWhatsAppOptInInput | null;
    whatsappProviderRequestTemplate?: ProviderWhatsAppTemplateInput | null;
  },
  fallback = "{}",
): string {
  const metadata = jsonObject(body.metadataJson ?? fallback);
  const optInSource = cleanText(body.whatsappOptIn?.source);
  const optInAcceptedAt = body.whatsappOptIn?.acceptedAt;
  if (
    optInSource &&
    typeof optInAcceptedAt === "number" &&
    Number.isInteger(optInAcceptedAt) &&
    optInAcceptedAt > 0
  ) {
    metadata.whatsappOptIn = {
      source: optInSource,
      acceptedAt: optInAcceptedAt,
      ...(Array.isArray(body.whatsappOptIn?.categories)
        ? { categories: body.whatsappOptIn.categories.filter((x) => typeof x === "string") }
        : {}),
    };
  }
  const templateName = cleanText(body.whatsappProviderRequestTemplate?.name);
  const languageCode = cleanText(body.whatsappProviderRequestTemplate?.languageCode);
  if (templateName && languageCode) {
    metadata.whatsappProviderRequestTemplate = {
      name: templateName,
      languageCode,
      ...(cleanText(body.whatsappProviderRequestTemplate?.category)
        ? { category: cleanText(body.whatsappProviderRequestTemplate?.category) }
        : {}),
      approved: body.whatsappProviderRequestTemplate?.approved === true,
      ...(Array.isArray(body.whatsappProviderRequestTemplate?.components)
        ? { components: body.whatsappProviderRequestTemplate.components }
        : {}),
    };
  }
  return JSON.stringify(metadata);
}

function parsePositiveId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function loadProviderItems(db: Db, tenantId: number, providerId?: number) {
  const where = providerId
    ? and(eq(providerProfiles.tenantId, tenantId), eq(providerProfiles.id, providerId))
    : eq(providerProfiles.tenantId, tenantId);

  const providers = await db
    .select({
      id: providerProfiles.id,
      tenantId: providerProfiles.tenantId,
      contactId: providerProfiles.contactId,
      name: providerProfiles.name,
      category: providerProfiles.category,
      status: providerProfiles.status,
      serviceArea: providerProfiles.serviceArea,
      defaultCommissionPct: providerProfiles.defaultCommissionPct,
      notes: providerProfiles.notes,
      metadataJson: providerProfiles.metadataJson,
      createdAt: providerProfiles.createdAt,
      updatedAt: providerProfiles.updatedAt,
      contactDisplayName: contacts.displayName,
      contactAttributesJson: contacts.attributesJson,
    })
    .from(providerProfiles)
    .innerJoin(contacts, eq(contacts.id, providerProfiles.contactId))
    .where(where)
    .orderBy(desc(providerProfiles.id));

  if (providers.length === 0) return [];

  const providerIds = providers.map((p) => p.id);
  const contactIds = providers.map((p) => p.contactId);

  const identities = await db
    .select({
      id: channelIdentities.id,
      contactId: channelIdentities.contactId,
      channelId: channelIdentities.channelId,
      externalUserId: channelIdentities.externalUserId,
      createdAt: channelIdentities.createdAt,
      channelKind: channels.kind,
      channelExternalId: channels.externalId,
      channelStatus: channels.status,
    })
    .from(channelIdentities)
    .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
    .where(and(eq(channels.tenantId, tenantId), inArray(channelIdentities.contactId, contactIds)))
    .orderBy(desc(channelIdentities.id));

  const services = await db
    .select()
    .from(providerServices)
    .where(
      and(
        eq(providerServices.tenantId, tenantId),
        inArray(providerServices.providerId, providerIds),
      ),
    )
    .orderBy(desc(providerServices.id));

  const orderStats = await db
    .select({
      providerId: serviceOrders.assignedProviderId,
      activeOrdersCount: sql<number>`count(CASE WHEN ${serviceOrders.status} NOT IN ('fulfilled','cancelled','failed') THEN 1 END)`,
    })
    .from(serviceOrders)
    .where(
      and(
        eq(serviceOrders.tenantId, tenantId),
        inArray(serviceOrders.assignedProviderId, providerIds),
      ),
    )
    .groupBy(serviceOrders.assignedProviderId);

  const identitiesByContact = new Map<number, typeof identities>();
  for (const identity of identities) {
    const list = identitiesByContact.get(identity.contactId) ?? [];
    list.push(identity);
    identitiesByContact.set(identity.contactId, list);
  }

  const servicesByProvider = new Map<number, typeof services>();
  for (const service of services) {
    const list = servicesByProvider.get(service.providerId) ?? [];
    list.push(service);
    servicesByProvider.set(service.providerId, list);
  }

  const ordersByProvider = new Map(
    orderStats
      .filter((stat) => stat.providerId !== null)
      .map((stat) => [stat.providerId as number, Number(stat.activeOrdersCount)]),
  );

  return providers.map((provider) => {
    const providerServicesList = servicesByProvider.get(provider.id) ?? [];
    return {
      ...provider,
      identities: identitiesByContact.get(provider.contactId) ?? [],
      services: providerServicesList,
      servicesCount: providerServicesList.length,
      activeServicesCount: providerServicesList.filter((service) => service.isActive).length,
      activeOrdersCount: ordersByProvider.get(provider.id) ?? 0,
    };
  });
}

async function requireProvider(db: Db, tenantId: number, providerId: number) {
  const [provider] = await db
    .select()
    .from(providerProfiles)
    .where(and(eq(providerProfiles.tenantId, tenantId), eq(providerProfiles.id, providerId)))
    .limit(1);
  if (!provider) throw new RouteError(404, "provider not found");
  return provider;
}

async function attachIdentity(
  db: Db,
  tenantId: number,
  contactId: number,
  input: ProviderIdentityInput,
) {
  const channelId = Number(input.channelId);
  const externalUserId = cleanText(input.externalUserId);
  if (!Number.isInteger(channelId) || channelId <= 0 || !externalUserId) {
    throw new RouteError(400, "channelId and externalUserId required");
  }

  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.tenantId, tenantId), eq(channels.id, channelId)))
    .limit(1);
  if (!channel) throw new RouteError(404, "channel not found");

  const [existing] = await db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channelId, channelId),
        eq(channelIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.contactId !== contactId)
      throw new RouteError(409, "channel identity already assigned");
    return existing;
  }

  const [inserted] = await db
    .insert(channelIdentities)
    .values({ contactId, channelId, externalUserId })
    .onConflictDoNothing({
      target: [channelIdentities.channelId, channelIdentities.externalUserId],
    })
    .returning();
  if (inserted) return inserted;

  const [taken] = await db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channelId, channelId),
        eq(channelIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  if (taken?.contactId === contactId) return taken;
  throw new RouteError(409, "channel identity already assigned");
}

export function makeAdminProvidersRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/providers", async (c) => {
    const tenantId = c.var.tenantId;
    const items = await withTenant(opts.db, tenantId, (tx) => loadProviderItems(tx, tenantId));
    return c.json({ items });
  });

  app.post("/api/admin/providers", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json<CreateProviderBody>().catch(() => ({}) as CreateProviderBody);
    const name = cleanText(body.name);
    if (!name) return c.json({ error: "name required" }, 400);

    try {
      const item = await withTenant(opts.db, tenantId, async (tx) => {
        const now = nowEpoch();
        const [contact] = await tx
          .insert(contacts)
          .values({
            tenantId,
            displayName: name,
            attributesJson: JSON.stringify({ role: "provider" }),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!contact) throw new RouteError(400, "contact create failed");

        const [provider] = await tx
          .insert(providerProfiles)
          .values({
            tenantId,
            contactId: contact.id,
            name,
            category: cleanText(body.category),
            serviceArea: cleanText(body.serviceArea),
            defaultCommissionPct: Number(body.defaultCommissionPct ?? 0),
            notes: cleanText(body.notes),
            metadataJson: providerMetadataText(body),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!provider) throw new RouteError(400, "provider create failed");

        if (body.identity) await attachIdentity(tx, tenantId, contact.id, body.identity);

        for (const service of body.services ?? []) {
          const serviceType = cleanText(service.serviceType);
          const serviceName = cleanText(service.name);
          if (!serviceType || !serviceName) continue;
          await tx.insert(providerServices).values({
            tenantId,
            providerId: provider.id,
            serviceType,
            name: serviceName,
            serviceArea: cleanText(service.serviceArea) ?? cleanText(body.serviceArea),
            pricingPolicyJson: jsonText(service.pricingPolicyJson),
            commissionPct: service.commissionPct ?? null,
            isActive: service.isActive ?? true,
            metadataJson: jsonText(service.metadataJson),
            createdAt: now,
            updatedAt: now,
          });
        }

        const [loaded] = await loadProviderItems(tx, tenantId, provider.id);
        return loaded;
      });

      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider.create",
        targetKind: "provider_profile",
        targetId: item?.id,
        details: { name },
      });
      return c.json({ item }, 201);
    } catch (err) {
      if (err instanceof RouteError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.patch("/api/admin/providers/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await c.req
      .json<Partial<CreateProviderBody> & { status?: string }>()
      .catch(() => ({}) as Partial<CreateProviderBody> & { status?: string });

    const patch: Partial<typeof providerProfiles.$inferInsert> = { updatedAt: nowEpoch() };
    if ("name" in body) {
      const name = cleanText(body.name);
      if (!name) return c.json({ error: "name required" }, 400);
      patch.name = name;
    }
    if ("category" in body) patch.category = cleanText(body.category);
    if ("serviceArea" in body) patch.serviceArea = cleanText(body.serviceArea);
    if ("defaultCommissionPct" in body)
      patch.defaultCommissionPct = Number(body.defaultCommissionPct ?? 0);
    if ("notes" in body) patch.notes = cleanText(body.notes);
    const shouldPatchMetadata =
      "metadataJson" in body ||
      "whatsappOptIn" in body ||
      "whatsappProviderRequestTemplate" in body;
    if ("status" in body) {
      if (!body.status || !PROVIDER_STATUSES.has(body.status)) {
        return c.json({ error: "bad status" }, 400);
      }
      patch.status = body.status;
    }

    const item = await withTenant(opts.db, tenantId, async (tx) => {
      if (shouldPatchMetadata) {
        const existing = await requireProvider(tx, tenantId, id);
        patch.metadataJson = providerMetadataText(body, existing.metadataJson);
      }
      const [row] = await tx
        .update(providerProfiles)
        .set(patch)
        .where(and(eq(providerProfiles.tenantId, tenantId), eq(providerProfiles.id, id)))
        .returning();
      if (!row) throw new RouteError(404, "provider not found");
      const [loaded] = await loadProviderItems(tx, tenantId, id);
      return loaded;
    }).catch((err) => {
      if (err instanceof RouteError) return err;
      throw err;
    });
    if (item instanceof RouteError) return c.json({ error: item.message }, item.status);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider.update",
      targetKind: "provider_profile",
      targetId: id,
      details: patch,
    });
    return c.json({ item });
  });

  app.post("/api/admin/providers/:id/archive", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);

    const item = await withTenant(opts.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(providerProfiles)
        .set({ status: "archived", updatedAt: nowEpoch() })
        .where(and(eq(providerProfiles.tenantId, tenantId), eq(providerProfiles.id, id)))
        .returning();
      if (!row) throw new RouteError(404, "provider not found");
      const [loaded] = await loadProviderItems(tx, tenantId, id);
      return loaded;
    }).catch((err) => {
      if (err instanceof RouteError) return err;
      throw err;
    });
    if (item instanceof RouteError) return c.json({ error: item.message }, item.status);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider.archive",
      targetKind: "provider_profile",
      targetId: id,
      details: { status: "archived" },
    });
    return c.json({ item });
  });

  app.post("/api/admin/providers/:id/identities", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await c.req
      .json<ProviderIdentityInput>()
      .catch(() => ({}) as ProviderIdentityInput);

    try {
      const item = await withTenant(opts.db, tenantId, async (tx) => {
        const provider = await requireProvider(tx, tenantId, id);
        await attachIdentity(tx, tenantId, provider.contactId, body);
        const [loaded] = await loadProviderItems(tx, tenantId, id);
        return loaded;
      });

      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider_identity.attach",
        targetKind: "provider_profile",
        targetId: id,
        details: { channelId: body.channelId, externalUserId: body.externalUserId },
      });
      return c.json({ item });
    } catch (err) {
      if (err instanceof RouteError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post("/api/admin/providers/:id/services", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveId(c.req.param("id"));
    if (!id) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json<ProviderServiceInput>().catch(() => ({}) as ProviderServiceInput);
    const serviceType = cleanText(body.serviceType);
    const name = cleanText(body.name);
    if (!serviceType || !name) return c.json({ error: "serviceType and name required" }, 400);

    try {
      const item = await withTenant(opts.db, tenantId, async (tx) => {
        await requireProvider(tx, tenantId, id);
        const now = nowEpoch();
        await tx.insert(providerServices).values({
          tenantId,
          providerId: id,
          serviceType,
          name,
          serviceArea: cleanText(body.serviceArea),
          pricingPolicyJson: jsonText(body.pricingPolicyJson),
          commissionPct: body.commissionPct ?? null,
          isActive: body.isActive ?? true,
          metadataJson: jsonText(body.metadataJson),
          createdAt: now,
          updatedAt: now,
        });
        const [loaded] = await loadProviderItems(tx, tenantId, id);
        return loaded;
      });

      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider_service.create",
        targetKind: "provider_profile",
        targetId: id,
        details: { serviceType, name },
      });
      return c.json({ item }, 201);
    } catch (err) {
      if (err instanceof RouteError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.patch("/api/admin/provider-services/:serviceId", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const serviceId = parsePositiveId(c.req.param("serviceId"));
    if (!serviceId) return c.json({ error: "bad id" }, 400);
    const body = await c.req
      .json<Partial<ProviderServiceInput>>()
      .catch(() => ({}) as Partial<ProviderServiceInput>);

    const patch: Partial<typeof providerServices.$inferInsert> = { updatedAt: nowEpoch() };
    if ("serviceType" in body) {
      const serviceType = cleanText(body.serviceType);
      if (!serviceType) return c.json({ error: "serviceType required" }, 400);
      patch.serviceType = serviceType;
    }
    if ("name" in body) {
      const name = cleanText(body.name);
      if (!name) return c.json({ error: "name required" }, 400);
      patch.name = name;
    }
    if ("serviceArea" in body) patch.serviceArea = cleanText(body.serviceArea);
    if ("pricingPolicyJson" in body) patch.pricingPolicyJson = jsonText(body.pricingPolicyJson);
    if ("commissionPct" in body) patch.commissionPct = body.commissionPct ?? null;
    if ("isActive" in body) patch.isActive = body.isActive ?? true;
    if ("metadataJson" in body) patch.metadataJson = jsonText(body.metadataJson);

    const item = await withTenant(opts.db, tenantId, async (tx) => {
      const [service] = await tx
        .update(providerServices)
        .set(patch)
        .where(and(eq(providerServices.tenantId, tenantId), eq(providerServices.id, serviceId)))
        .returning();
      if (!service) throw new RouteError(404, "provider service not found");
      const [loaded] = await loadProviderItems(tx, tenantId, service.providerId);
      return loaded;
    }).catch((err) => {
      if (err instanceof RouteError) return err;
      throw err;
    });
    if (item instanceof RouteError) return c.json({ error: item.message }, item.status);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "provider_service.update",
      targetKind: "provider_service",
      targetId: serviceId,
      details: patch,
    });
    return c.json({ item });
  });

  return app;
}
