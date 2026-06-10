export interface MetricCounterLike {
	inc(value?: number, labels?: Readonly<Record<string, string | number>>): void;
}

export interface MetricHistogramLike {
	observe(value: number, labels?: Readonly<Record<string, string | number>>): void;
}

export interface ProviderRelayMetrics {
	providerOrdersCreated: MetricCounterLike;
	providerRequests: MetricCounterLike;
	providerResponses: MetricCounterLike;
	providerTimeToQuote: MetricHistogramLike;
	providerPaidOrders: MetricCounterLike;
	providerCommissionEarned: MetricCounterLike;
	providerFailures: MetricCounterLike;
}

export function providerRelayTenantLabels(
	tenantId: number,
): Readonly<Record<string, string>> {
	return { tenant: String(tenantId) };
}

export function normalizeMetricLabel(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
	return normalized || "unknown";
}
