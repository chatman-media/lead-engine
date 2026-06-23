import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { partnerServices, partners, serviceCatalogItems } from "@chatman-media/storage";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import {
  findMarketplaceProvider,
  MARKETPLACE_CUSTOM_SOURCE,
  MARKETPLACE_SOURCE,
  PROVIDER_MARKETPLACE,
  type ProviderMarketplaceProvider,
} from "../lib/provider-marketplace.ts";

type InstalledProviderRef = {
  partnerId: number;
  partnerName: string;
  partnerServiceId: number;
  serviceName: string;
  serviceCatalogItemId: number;
  serviceCatalogSlug: string;
  installedAt: number | null;
};

type ProviderMarketplaceItem = ProviderMarketplaceProvider & {
  installed: InstalledProviderRef | null;
};

type CustomProviderBody = {
  providerName?: unknown;
  serviceName?: unknown;
  category?: unknown;
  description?: unknown;
  coverage?: unknown;
  sla?: unknown;
  pricingMode?: unknown;
  commissionPct?: unknown;
  requiredFields?: unknown;
};

type CatalogInstallRow = {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  partnerServiceId: number | null;
  metadataJson: string;
  sortOrder: number;
  partnerId: number | null;
  partnerName: string | null;
  serviceName: string | null;
};

type MarketplaceMetadata = {
  source?: string;
  providerKey?: string;
  installedAt?: number;
};

export function makeAdminProviderMarketplaceRoutes(opts: { db: Db }): Hono {
  const app = new Hono();

  app.get("/api/admin/provider-marketplace", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await loadCatalogInstallRows(opts.db, tenantId);
    const installedByKey = buildInstalledByKey(rows, MARKETPLACE_SOURCE);
    const customProviders = rows
      .map((row) => {
        const meta = parseMarketplaceMetadata(row.metadataJson);
        if (meta.source !== MARKETPLACE_CUSTOM_SOURCE || !meta.providerKey) return null;
        const installed = installedRef(row, meta);
        if (!installed) return null;
        return {
          key: meta.providerKey,
          category: row.category ?? "Custom",
          name: row.partnerName ?? "Custom provider",
          serviceName: row.serviceName ?? row.name,
          description: row.description,
          installed,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    return c.json({
      items: PROVIDER_MARKETPLACE.map(
        (provider): ProviderMarketplaceItem => ({
          ...provider,
          installed: installedByKey.get(provider.key) ?? null,
        }),
      ),
      customProviders,
    });
  });

  app.post("/api/admin/provider-marketplace/:providerKey/install", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const providerKey = c.req.param("providerKey");
    const provider = findMarketplaceProvider(providerKey);
    if (!provider) return c.json({ error: "provider not found" }, 404);

    const result = await withTenant(opts.db, tenantId, async (tx) =>
      installCuratedProvider(tx, tenantId, provider),
    );

    if (result.created) {
      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider_marketplace.install",
        targetKind: "service_catalog_item",
        targetId: String(result.provider.installed?.serviceCatalogItemId ?? ""),
        details: { providerKey },
      });
    }

    return c.json(result, result.created ? 201 : 200);
  });

  app.post("/api/admin/provider-marketplace/custom", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json<CustomProviderBody>().catch(() => ({}) as CustomProviderBody);
    const providerName = cleanString(body.providerName);
    const serviceName = cleanString(body.serviceName);
    if (!providerName || !serviceName) {
      return c.json({ error: "providerName and serviceName required" }, 400);
    }

    const result = await withTenant(opts.db, tenantId, async (tx) =>
      installCustomProvider(tx, tenantId, {
        providerName,
        serviceName,
        category: cleanString(body.category) || "Custom",
        description: cleanString(body.description) || null,
        coverage: cleanString(body.coverage) || "custom coverage",
        sla: cleanString(body.sla) || "manual confirmation",
        pricingMode: cleanString(body.pricingMode) || "custom quote",
        commissionPct: parseCommission(body.commissionPct),
        requiredFields: parseRequiredFields(body.requiredFields),
      }),
    );

    if (result.created) {
      await recordAudit(opts.db, {
        tenantId,
        adminId,
        action: "provider_marketplace.custom_create",
        targetKind: "service_catalog_item",
        targetId: String(result.provider.installed.serviceCatalogItemId),
        details: { providerName, serviceName },
      });
    }

    return c.json(result, result.created ? 201 : 200);
  });

  return app;
}

async function loadCatalogInstallRows(db: Db, tenantId: number): Promise<CatalogInstallRow[]> {
  return withTenant(db, tenantId, async (tx) =>
    tx
      .select({
        id: serviceCatalogItems.id,
        slug: serviceCatalogItems.slug,
        name: serviceCatalogItems.name,
        category: serviceCatalogItems.category,
        description: serviceCatalogItems.description,
        partnerServiceId: serviceCatalogItems.partnerServiceId,
        metadataJson: serviceCatalogItems.metadataJson,
        sortOrder: serviceCatalogItems.sortOrder,
        partnerId: partners.id,
        partnerName: partners.name,
        serviceName: partnerServices.name,
      })
      .from(serviceCatalogItems)
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
      .orderBy(asc(serviceCatalogItems.sortOrder), asc(serviceCatalogItems.id)),
  );
}

async function installCuratedProvider(
  tx: Db,
  tenantId: number,
  provider: ProviderMarketplaceProvider,
): Promise<{ provider: ProviderMarketplaceItem; created: boolean }> {
  const rows = await loadCatalogInstallRowsFromTx(tx, tenantId);
  const existing = buildInstalledByKey(rows, MARKETPLACE_SOURCE).get(provider.key);
  if (existing) return { provider: { ...provider, installed: existing }, created: false };

  const now = epochNow();
  const partner = await findOrCreatePartner(tx, tenantId, {
    name: provider.name,
    markerKey: provider.key,
    source: MARKETPLACE_SOURCE,
    commissionPct: provider.commissionPct,
    notes: {
      coverage: provider.coverage,
      sla: provider.sla,
      pricingMode: provider.pricingMode,
    },
  });
  const service = await findOrCreatePartnerService(tx, tenantId, {
    partnerId: partner.id,
    name: provider.defaultServiceName,
    category: provider.category,
    commissionPct: provider.commissionPct,
    source: MARKETPLACE_SOURCE,
    markerKey: provider.key,
    notes: {
      providerName: provider.name,
      requiredFields: provider.requiredFields,
      handoffMode: provider.handoffMode,
    },
  });
  const catalog = await createCatalogItem(tx, tenantId, rows, {
    name: provider.defaultServiceName,
    category: provider.category,
    description: provider.description,
    slugBase: provider.serviceSlug,
    partnerServiceId: service.id,
    metadata: {
      source: MARKETPLACE_SOURCE,
      providerKey: provider.key,
      coverage: provider.coverage,
      sla: provider.sla,
      pricingMode: provider.pricingMode,
      commissionPct: provider.commissionPct,
      requiredFields: provider.requiredFields,
      handoffMode: provider.handoffMode,
      installedAt: now,
    },
    now,
  });

  return {
    provider: {
      ...provider,
      installed: {
        partnerId: partner.id,
        partnerName: partner.name,
        partnerServiceId: service.id,
        serviceName: service.name,
        serviceCatalogItemId: catalog.id,
        serviceCatalogSlug: catalog.slug,
        installedAt: now,
      },
    },
    created: true,
  };
}

async function installCustomProvider(
  tx: Db,
  tenantId: number,
  input: {
    providerName: string;
    serviceName: string;
    category: string;
    description: string | null;
    coverage: string;
    sla: string;
    pricingMode: string;
    commissionPct: number;
    requiredFields: string[];
  },
): Promise<{
  provider: {
    key: string;
    category: string;
    name: string;
    serviceName: string;
    description: string | null;
    installed: InstalledProviderRef;
  };
  created: boolean;
}> {
  const now = epochNow();
  const key = `custom_${normalizeSlug(`${input.providerName}_${input.serviceName}`) || now}`;
  const rows = await loadCatalogInstallRowsFromTx(tx, tenantId);
  const existing = buildInstalledByKey(rows, MARKETPLACE_CUSTOM_SOURCE).get(key);
  if (existing) {
    return {
      provider: {
        key,
        category: input.category,
        name: existing.partnerName,
        serviceName: existing.serviceName,
        description: input.description,
        installed: existing,
      },
      created: false,
    };
  }

  const partner = await findOrCreatePartner(tx, tenantId, {
    name: input.providerName,
    markerKey: key,
    source: MARKETPLACE_CUSTOM_SOURCE,
    commissionPct: input.commissionPct,
    notes: {
      coverage: input.coverage,
      sla: input.sla,
      pricingMode: input.pricingMode,
    },
  });
  const service = await findOrCreatePartnerService(tx, tenantId, {
    partnerId: partner.id,
    name: input.serviceName,
    category: input.category,
    commissionPct: input.commissionPct,
    source: MARKETPLACE_CUSTOM_SOURCE,
    markerKey: key,
    notes: {
      providerName: input.providerName,
      requiredFields: input.requiredFields,
      handoffMode: "await_callback",
    },
  });
  const catalog = await createCatalogItem(tx, tenantId, rows, {
    name: input.serviceName,
    category: input.category,
    description: input.description,
    slugBase: normalizeSlug(input.serviceName) || "custom_provider",
    partnerServiceId: service.id,
    metadata: {
      source: MARKETPLACE_CUSTOM_SOURCE,
      providerKey: key,
      coverage: input.coverage,
      sla: input.sla,
      pricingMode: input.pricingMode,
      commissionPct: input.commissionPct,
      requiredFields: input.requiredFields,
      handoffMode: "await_callback",
      installedAt: now,
    },
    now,
  });

  return {
    provider: {
      key,
      category: input.category,
      name: partner.name,
      serviceName: service.name,
      description: input.description,
      installed: {
        partnerId: partner.id,
        partnerName: partner.name,
        partnerServiceId: service.id,
        serviceName: service.name,
        serviceCatalogItemId: catalog.id,
        serviceCatalogSlug: catalog.slug,
        installedAt: now,
      },
    },
    created: true,
  };
}

async function loadCatalogInstallRowsFromTx(
  tx: Db,
  tenantId: number,
): Promise<CatalogInstallRow[]> {
  return tx
    .select({
      id: serviceCatalogItems.id,
      slug: serviceCatalogItems.slug,
      name: serviceCatalogItems.name,
      category: serviceCatalogItems.category,
      description: serviceCatalogItems.description,
      partnerServiceId: serviceCatalogItems.partnerServiceId,
      metadataJson: serviceCatalogItems.metadataJson,
      sortOrder: serviceCatalogItems.sortOrder,
      partnerId: partners.id,
      partnerName: partners.name,
      serviceName: partnerServices.name,
    })
    .from(serviceCatalogItems)
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
    .orderBy(asc(serviceCatalogItems.sortOrder), asc(serviceCatalogItems.id));
}

function buildInstalledByKey(
  rows: CatalogInstallRow[],
  source: string,
): Map<string, InstalledProviderRef> {
  const out = new Map<string, InstalledProviderRef>();
  for (const row of rows) {
    const meta = parseMarketplaceMetadata(row.metadataJson);
    if (meta.source !== source || !meta.providerKey || out.has(meta.providerKey)) continue;
    const installed = installedRef(row, meta);
    if (installed) out.set(meta.providerKey, installed);
  }
  return out;
}

function installedRef(
  row: CatalogInstallRow,
  meta: MarketplaceMetadata,
): InstalledProviderRef | null {
  if (!row.partnerId || !row.partnerServiceId || !row.partnerName || !row.serviceName) return null;
  return {
    partnerId: row.partnerId,
    partnerName: row.partnerName,
    partnerServiceId: row.partnerServiceId,
    serviceName: row.serviceName,
    serviceCatalogItemId: row.id,
    serviceCatalogSlug: row.slug,
    installedAt: Number.isFinite(meta.installedAt) ? Number(meta.installedAt) : null,
  };
}

async function findOrCreatePartner(
  tx: Db,
  tenantId: number,
  input: {
    name: string;
    markerKey: string;
    source: string;
    commissionPct: number;
    notes: Record<string, unknown>;
  },
) {
  const rows = await tx
    .select()
    .from(partners)
    .where(eq(partners.tenantId, tenantId))
    .orderBy(asc(partners.id));
  const marker = markerFor(input.source, input.markerKey);
  const existing =
    rows.find((row) => row.notes?.includes(marker)) ??
    rows.find((row) => row.name.toLowerCase() === input.name.toLowerCase());
  if (existing) return existing;

  const now = epochNow();
  const [row] = await tx
    .insert(partners)
    .values({
      tenantId,
      name: input.name,
      contactChannel: "marketplace",
      contactValue: input.markerKey,
      defaultCommissionPct: input.commissionPct,
      settlementCurrency: "THB",
      notes: JSON.stringify({
        marker,
        source: input.source,
        providerKey: input.markerKey,
        ...input.notes,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return requireInserted(row, "partner");
}

async function findOrCreatePartnerService(
  tx: Db,
  tenantId: number,
  input: {
    partnerId: number;
    name: string;
    category: string;
    commissionPct: number;
    source: string;
    markerKey: string;
    notes: Record<string, unknown>;
  },
) {
  const [existing] = await tx
    .select()
    .from(partnerServices)
    .where(
      and(
        eq(partnerServices.tenantId, tenantId),
        eq(partnerServices.partnerId, input.partnerId),
        eq(partnerServices.name, input.name),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const now = epochNow();
  const marker = markerFor(input.source, input.markerKey);
  const [row] = await tx
    .insert(partnerServices)
    .values({
      tenantId,
      partnerId: input.partnerId,
      name: input.name,
      category: input.category,
      commissionPct: input.commissionPct,
      isActive: true,
      notes: JSON.stringify({
        marker,
        source: input.source,
        providerKey: input.markerKey,
        ...input.notes,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return requireInserted(row, "partner service");
}

async function createCatalogItem(
  tx: Db,
  tenantId: number,
  existingRows: CatalogInstallRow[],
  input: {
    name: string;
    category: string;
    description: string | null;
    slugBase: string;
    partnerServiceId: number;
    metadata: Record<string, unknown>;
    now: number;
  },
) {
  const takenSlugs = new Set(existingRows.map((row) => row.slug));
  const nextSortOrder = existingRows.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10;
  const [row] = await tx
    .insert(serviceCatalogItems)
    .values({
      tenantId,
      slug: uniqueSlug(input.slugBase, takenSlugs),
      name: input.name,
      category: input.category,
      description: input.description,
      routeType: "partner_service",
      partnerServiceId: input.partnerServiceId,
      isActive: true,
      sortOrder: nextSortOrder,
      metadataJson: JSON.stringify(input.metadata),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return requireInserted(row, "service catalog item");
}

function requireInserted<T>(row: T | undefined, label: string): T {
  if (!row) throw new Error(`failed to create ${label}`);
  return row;
}

function markerFor(source: string, providerKey: string): string {
  return `${source}:${providerKey}`;
}

function parseMarketplaceMetadata(value: string): MarketplaceMetadata {
  try {
    const parsed = JSON.parse(value) as MarketplaceMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseCommission(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.min(100, n) : 0;
}

function parseRequiredFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean).slice(0, 12);
  }
  const raw = cleanString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function uniqueSlug(base: string, taken: Set<string>): string {
  const normalized = normalizeSlug(base) || "provider_service";
  if (!taken.has(normalized)) return normalized;
  for (let i = 2; i < 100; i++) {
    const candidate = `${normalized}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${normalized}_${epochNow()}`;
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
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya",
    ъ: "",
    ь: "",
  };
  return value
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}

function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}
