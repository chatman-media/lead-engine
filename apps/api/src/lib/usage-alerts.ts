/**
 * Usage alert checker — отправляет email при 80% и 100% квоты LLM.
 *
 * Запускается через setInterval в index.ts (каждые 60 мин).
 * Дедупликация in-memory: Set<`${tenantId}:${monthKey}:${threshold}`>.
 * Сбрасывается при перезапуске — максимум 1 лишний email на рестарт (OK).
 */

import { admins, llmUsageEvents, tenants } from "@chatman-media/storage";
import { and, count, gte, lte } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { usageAlertEmailHtml, type Mailer } from "./mailer.ts";
import { resolvePlan } from "./plans.ts";

// biome-ignore lint/suspicious/noExplicitAny: Drizzle generic
type Db = PostgresJsDatabase<any>;

/** In-memory dedup store — ключ: `${tenantId}:${yyyymm}:${threshold}` */
const _sent = new Set<string>();

function monthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(): { start: number; end: number } {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  // Первый день следующего месяца:
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
  return { start: Math.floor(start), end: Math.floor(end) };
}

async function getOwnerEmail(db: Db, tenantId: number): Promise<{ email: string; slug: string } | null> {
  const [row] = await db
    .select({ email: admins.email, slug: tenants.slug })
    .from(admins)
    .innerJoin(tenants, eq(tenants.id, admins.tenantId))
    .where(and(eq(admins.tenantId, tenantId), eq(admins.role, "superadmin")))
    .limit(1);
  return row ?? null;
}

export async function checkUsageAlerts(
  db: Db,
  mailer: Mailer,
  appUrl: string,
): Promise<void> {
  const mk = monthKey();
  const { start, end } = monthBounds();

  // Выбираем все активные тенанты с ограниченным планом.
  const rows = await db
    .select({ id: tenants.id, plan: tenants.plan, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  for (const tenant of rows) {
    const limits = resolvePlan(tenant.plan);
    if (limits.maxLlmCallsPerMonth <= 0) continue; // unlimited — пропускаем

    const [usageRow] = await db
      .select({ cnt: count() })
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.tenantId, tenant.id),
          gte(llmUsageEvents.createdAt, start),
          lte(llmUsageEvents.createdAt, end),
        ),
      );
    const current = usageRow?.cnt ?? 0;
    const pct = current / limits.maxLlmCallsPerMonth;

    for (const threshold of [0.8, 1.0] as const) {
      if (pct < threshold) continue;
      const dedupKey = `${tenant.id}:${mk}:${threshold}`;
      if (_sent.has(dedupKey)) continue;

      const owner = await getOwnerEmail(db, tenant.id);
      if (!owner) continue;

      _sent.add(dedupKey);
      mailer.send({
        to: owner.email,
        subject: threshold >= 1
          ? "Квота LLM исчерпана — lead-engine"
          : "Использовано 80% квоты LLM — lead-engine",
        html: usageAlertEmailHtml({
          email: owner.email,
          slug: owner.slug,
          current,
          limit: limits.maxLlmCallsPerMonth,
          pct: Math.round(pct * 100),
          appUrl,
          billingUrl: `${appUrl}/billing`,
        }),
      }).catch((e) => console.warn(`[usage-alerts] send failed tenant=${tenant.id}:`, e));

      console.log(`[usage-alerts] alert sent tenant=${tenant.id} threshold=${threshold * 100}% usage=${current}/${limits.maxLlmCallsPerMonth}`);
    }
  }
}
