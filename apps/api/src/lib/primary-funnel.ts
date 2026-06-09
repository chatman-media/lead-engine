import { type Db } from "@chatman-media/conversation-engine";
import { funnels } from "@chatman-media/storage";
import { and, asc, eq, sql } from "drizzle-orm";

export type PrimaryFunnelRow = typeof funnels.$inferSelect;

const PRIMARY_FUNNEL_PRIORITY = sql<number>`CASE
  WHEN ${funnels.verticalTemplateId} = 'exchange_v1' THEN 0
  WHEN ${funnels.slug} = 'exchange' THEN 0
  WHEN ${funnels.verticalTemplateId} IS NOT NULL THEN 2
  ELSE 3
END`;

/**
 * Pick the operational funnel shown on dashboard-style screens.
 * Tenants can have several active service directions, so "first active by id"
 * makes the UI drift. Exchange is currently the primary demo/ops workflow.
 */
export async function loadPrimaryActiveFunnel(
  tx: Db,
  tenantId: number,
): Promise<PrimaryFunnelRow | null> {
  const [funnel] = await tx
    .select()
    .from(funnels)
    .where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
    .orderBy(PRIMARY_FUNNEL_PRIORITY, asc(funnels.id))
    .limit(1);

  return funnel ?? null;
}
