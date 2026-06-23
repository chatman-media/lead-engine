/**
 * Stale lead sweep: периодически закрывает лиды, которые «зависли» на
 * активной стадии дольше чем stage_definitions.stale_timeout_days.
 *
 * Логика:
 *   1. SELECT активных tenant'ов.
 *   2. Для каждого — найти leads с stageDefinitionId != null,
 *      где stage.staleTimeoutDays > 0 и lead.updatedAt < now - timeout.
 *   3. Для каждого «просроченного» лида:
 *      a. Найти первую terminal_lost стадию тенанта.
 *      b. Обновить leads.stage_definition_id + leads.state + leads.updated_at.
 *      c. Вставить lead_events с fromState/toState.
 *
 * Почему worker, а не apps/api: sweep — фоновая задача без HTTP-контекста.
 * Worker уже имеет DB connection и тикер. Не требует tenant-specific
 * credentials — только читает/пишет через withTenant (RLS-safe).
 */

import { withTenant, type NotificationService } from "@chatman-media/conversation-engine";
import { contacts, leadEvents, leads, stageDefinitions, tenants } from "@chatman-media/storage";
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@chatman-media/conversation-engine";

export class StaleleadSweeper {
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      intervalMs: number;
      notifications?: NotificationService;
    },
  ) {}

  async run(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });

    while (!this.stopped) {
      try {
        await this.sweep();
      } catch (err) {
        console.error("[stale-sweep] error", err);
      }
      await new Promise((r) => setTimeout(r, this.opts.intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async sweep(): Promise<void> {
    const activeTenants = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));

    const now = Math.floor(Date.now() / 1000);

    for (const { id: tenantId } of activeTenants) {
      await this.sweepTenant(tenantId, now);
    }
  }

  private async sweepTenant(tenantId: number, now: number): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      // Find the first terminal_lost stage for this tenant
      const [terminalLost] = await tx
        .select({ id: stageDefinitions.id, slug: stageDefinitions.slug })
        .from(stageDefinitions)
        .where(
          and(eq(stageDefinitions.tenantId, tenantId), eq(stageDefinitions.kind, "terminal_lost")),
        )
        .limit(1);

      if (!terminalLost) return;

      // Find stale leads: joined to their stage, check timeout
      // Lead is stale if: stage.stale_timeout_days IS NOT NULL AND
      //   lead.updated_at < now - (stage.stale_timeout_days * 86400)
      //   AND stage.kind NOT IN ('terminal_won', 'terminal_lost')
      const staleLeads = await tx
        .select({
          id: leads.id,
          state: leads.state,
          stageDefinitionId: leads.stageDefinitionId,
        })
        .from(leads)
        .innerJoin(
          stageDefinitions,
          and(
            eq(leads.stageDefinitionId, stageDefinitions.id),
            eq(stageDefinitions.tenantId, tenantId),
            isNotNull(stageDefinitions.staleTimeoutDays),
            or(eq(stageDefinitions.kind, "intake"), eq(stageDefinitions.kind, "active")),
          ),
        )
        .where(
          and(
            eq(leads.tenantId, tenantId),
            isNotNull(leads.stageDefinitionId),
            // updated_at < now - stale_timeout_days * 86400
            lt(leads.updatedAt, sql`${now} - (${stageDefinitions.staleTimeoutDays} * 86400)`),
          ),
        );

      for (const lead of staleLeads) {
        await tx
          .update(leads)
          .set({
            stageDefinitionId: terminalLost.id,
            state: terminalLost.slug,
            updatedAt: now,
          })
          .where(eq(leads.id, lead.id));

        await tx.insert(leadEvents).values({
          tenantId,
          leadId: lead.id,
          fromState: lead.state,
          toState: terminalLost.slug,
          createdAt: now,
        });

        if (this.opts.notifications) {
          const [contact] = await tx
            .select({ displayName: contacts.displayName })
            .from(contacts)
            // lead.id is correct here as leads and contacts are 1:1 in this context?
            // No, leads.userId references contacts.id.
            .where(eq(contacts.id, sql`(SELECT user_id FROM leads WHERE id = ${lead.id})`));

          void this.opts.notifications.notify({
            tenantId,
            eventType: "lead_stale",
            leadId: lead.id,
            data: {
              displayName: contact?.displayName || "Без имени",
              fromStage: lead.state,
              toStage: terminalLost.slug,
            },
          });
        }
      }

      if (staleLeads.length > 0) {
        console.log(
          `[stale-sweep] tenant=${tenantId} closed ${staleLeads.length} stale lead(s) → ${terminalLost.slug}`,
        );
      }
    });
  }
}
