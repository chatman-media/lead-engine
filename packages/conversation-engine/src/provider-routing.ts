import { providerProfiles, providerServices, serviceOrders } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import { ACTIVE_SERVICE_ORDER_STATUSES, type ServiceOrderStatus } from "./dal/index.ts";
import type { RepoCtx } from "./dal/types.ts";

export type ProviderRoutingFailureReason =
  | "no_provider_available"
  | "provider_not_found"
  | "provider_paused"
  | "service_inactive"
  | "area_unavailable";

export interface ProviderRouteCandidate {
  providerId: number;
  providerName: string;
  providerStatus: string;
  providerServiceId: number;
  serviceType: string;
  serviceName: string;
  serviceArea: string | null;
  providerServiceArea: string | null;
  providerProfileArea: string | null;
  activeOrderCount: number;
  commissionPct: number | null;
}

export type ProviderRoutingResult =
  | {
      ok: true;
      candidate: ProviderRouteCandidate;
      override: boolean;
    }
  | {
      ok: false;
      reason: ProviderRoutingFailureReason;
      details?: string;
    };

export interface ProviderRoutingInput {
  serviceType: string;
  serviceArea?: string | null;
  providerIdOverride?: number | null;
}

interface RawCandidate {
  provider_id: number;
  provider_name: string;
  provider_status: string;
  provider_service_id: number;
  service_type: string;
  service_name: string;
  service_area: string | null;
  provider_service_area: string | null;
  provider_profile_area: string | null;
  active_order_count: number;
  commission_pct: number | null;
  exact_area_rank: number;
}

const activeStatusesSql = sql.join(
  ACTIVE_SERVICE_ORDER_STATUSES.map((status: ServiceOrderStatus) => sql`${status}`),
  sql`, `,
);

function normalizeArea(area: string | null | undefined): string | null {
  const trimmed = area?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function rawToCandidate(raw: RawCandidate): ProviderRouteCandidate {
  return {
    providerId: raw.provider_id,
    providerName: raw.provider_name,
    providerStatus: raw.provider_status,
    providerServiceId: raw.provider_service_id,
    serviceType: raw.service_type,
    serviceName: raw.service_name,
    serviceArea: raw.service_area,
    providerServiceArea: raw.provider_service_area,
    providerProfileArea: raw.provider_profile_area,
    activeOrderCount: Number(raw.active_order_count),
    commissionPct: raw.commission_pct,
  };
}

export class ProviderRouter {
  constructor(private readonly ctx: RepoCtx) {}

  async selectProvider(input: ProviderRoutingInput): Promise<ProviderRoutingResult> {
    const serviceType = input.serviceType.trim();
    if (serviceType.length === 0) {
      return {
        ok: false,
        reason: "no_provider_available",
        details: "serviceType is empty",
      };
    }

    const serviceArea = normalizeArea(input.serviceArea);
    if (input.providerIdOverride !== undefined && input.providerIdOverride !== null) {
      return this.selectOverride({
        providerId: input.providerIdOverride,
        serviceType,
        serviceArea,
      });
    }

    const candidate = await this.findBestCandidate({
      serviceType,
      serviceArea,
    });
    if (candidate) return { ok: true, candidate, override: false };

    const hasAnyArea = await this.hasEligibleServiceIgnoringArea(serviceType);
    return {
      ok: false,
      reason: hasAnyArea ? "area_unavailable" : "no_provider_available",
    };
  }

  private async selectOverride(opts: {
    providerId: number;
    serviceType: string;
    serviceArea: string | null;
  }): Promise<ProviderRoutingResult> {
    const [provider] = await this.ctx.db
      .select({
        id: providerProfiles.id,
        status: providerProfiles.status,
      })
      .from(providerProfiles)
      .where(
        and(
          eq(providerProfiles.tenantId, this.ctx.tenantId),
          eq(providerProfiles.id, opts.providerId),
        ),
      )
      .limit(1);
    if (!provider) return { ok: false, reason: "provider_not_found" };
    if (provider.status !== "active") return { ok: false, reason: "provider_paused" };

    const candidate = await this.findBestCandidate({
      serviceType: opts.serviceType,
      serviceArea: opts.serviceArea,
      providerId: opts.providerId,
    });
    if (candidate) return { ok: true, candidate, override: true };

    const hasService = await this.providerHasActiveService(opts.providerId, opts.serviceType);
    return {
      ok: false,
      reason: hasService ? "area_unavailable" : "service_inactive",
    };
  }

  private async findBestCandidate(opts: {
    serviceType: string;
    serviceArea: string | null;
    providerId?: number;
  }): Promise<ProviderRouteCandidate | null> {
    const effectiveArea = sql`COALESCE(ps.service_area, pp.service_area)`;
    const areaPredicate = opts.serviceArea
      ? sql`AND (${effectiveArea} IS NULL OR ${effectiveArea} = ${opts.serviceArea})`
      : sql``;
    const providerPredicate =
      opts.providerId !== undefined ? sql`AND pp.id = ${opts.providerId}` : sql``;
    const exactAreaRank = opts.serviceArea
      ? sql`CASE WHEN ${effectiveArea} = ${opts.serviceArea} THEN 0 ELSE 1 END`
      : sql`0`;

    const rows = await this.ctx.db.execute(sql`
			SELECT
				pp.id AS provider_id,
				pp.name AS provider_name,
				pp.status AS provider_status,
				ps.id AS provider_service_id,
				ps.service_type AS service_type,
				ps.name AS service_name,
				${effectiveArea} AS service_area,
				ps.service_area AS provider_service_area,
				pp.service_area AS provider_profile_area,
				COALESCE(load.active_order_count, 0)::int AS active_order_count,
				COALESCE(ps.commission_pct, pp.default_commission_pct)::double precision AS commission_pct,
				${exactAreaRank} AS exact_area_rank
			FROM ${providerServices} ps
			INNER JOIN ${providerProfiles} pp
				ON pp.id = ps.provider_id
				AND pp.tenant_id = ${this.ctx.tenantId}
			LEFT JOIN (
				SELECT assigned_provider_id, COUNT(*)::int AS active_order_count
				FROM ${serviceOrders}
				WHERE tenant_id = ${this.ctx.tenantId}
					AND assigned_provider_id IS NOT NULL
					AND status IN (${activeStatusesSql})
				GROUP BY assigned_provider_id
			) load ON load.assigned_provider_id = pp.id
			WHERE ps.tenant_id = ${this.ctx.tenantId}
				AND ps.service_type = ${opts.serviceType}
				AND ps.is_active = TRUE
				AND pp.status = 'active'
				${providerPredicate}
				${areaPredicate}
			ORDER BY exact_area_rank ASC, active_order_count ASC, pp.id ASC
			LIMIT 1
		`);
    const raw = (rows as unknown as RawCandidate[])[0];
    return raw ? rawToCandidate(raw) : null;
  }

  private async hasEligibleServiceIgnoringArea(serviceType: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ id: providerServices.id })
      .from(providerServices)
      .innerJoin(
        providerProfiles,
        and(
          eq(providerProfiles.id, providerServices.providerId),
          eq(providerProfiles.tenantId, this.ctx.tenantId),
        ),
      )
      .where(
        and(
          eq(providerServices.tenantId, this.ctx.tenantId),
          eq(providerServices.serviceType, serviceType),
          eq(providerServices.isActive, true),
          eq(providerProfiles.status, "active"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  private async providerHasActiveService(
    providerId: number,
    serviceType: string,
  ): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ id: providerServices.id })
      .from(providerServices)
      .where(
        and(
          eq(providerServices.tenantId, this.ctx.tenantId),
          eq(providerServices.providerId, providerId),
          eq(providerServices.serviceType, serviceType),
          eq(providerServices.isActive, true),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
