import { tenantFeatureFlags } from "@chatman-media/storage";
import { and, eq } from "drizzle-orm";
import type { RepoCtx } from "./dal/types.ts";

export const PROVIDER_RELAY_FEATURE_KEY = "provider_relay";
export const EXCHANGE_RESPONSE_GUARD_FEATURE_KEY = "exchange_response_guard";

export type TenantFeatureKey =
	| typeof PROVIDER_RELAY_FEATURE_KEY
	| typeof EXCHANGE_RESPONSE_GUARD_FEATURE_KEY
	| string;

export interface TenantFeatureFlagRow {
	id: number;
	tenantId: number;
	featureKey: string;
	enabled: boolean;
	metadataJson: string;
	createdAt: number;
	updatedAt: number;
}

export class TenantFeatureFlagRepo {
	constructor(private readonly ctx: RepoCtx) {}

	async isEnabled(featureKey: TenantFeatureKey): Promise<boolean> {
		return this.isEnabledOrDefault(featureKey, false);
	}

	async isEnabledOrDefault(
		featureKey: TenantFeatureKey,
		defaultEnabled: boolean,
	): Promise<boolean> {
		const [row] = await this.ctx.db
			.select({ enabled: tenantFeatureFlags.enabled })
			.from(tenantFeatureFlags)
			.where(
				and(
					eq(tenantFeatureFlags.tenantId, this.ctx.tenantId),
					eq(tenantFeatureFlags.featureKey, featureKey),
				),
			)
			.limit(1);
		return row?.enabled ?? defaultEnabled;
	}

	async setEnabled(opts: {
		featureKey: TenantFeatureKey;
		enabled: boolean;
		nowEpoch: number;
		metadata?: Record<string, unknown>;
	}): Promise<TenantFeatureFlagRow> {
		const [row] = await this.ctx.db
			.insert(tenantFeatureFlags)
			.values({
				tenantId: this.ctx.tenantId,
				featureKey: opts.featureKey,
				enabled: opts.enabled,
				createdAt: opts.nowEpoch,
				updatedAt: opts.nowEpoch,
				...(opts.metadata
					? { metadataJson: JSON.stringify(opts.metadata) }
					: {}),
			})
			.onConflictDoUpdate({
				target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.featureKey],
				set: {
					enabled: opts.enabled,
					updatedAt: opts.nowEpoch,
					...(opts.metadata
						? { metadataJson: JSON.stringify(opts.metadata) }
						: {}),
				},
			})
			.returning();
		if (!row) throw new Error("tenant_feature_flags.upsert returned no row");
		return row as TenantFeatureFlagRow;
	}
}
