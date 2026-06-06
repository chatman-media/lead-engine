import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  conversations,
  leads,
  stageDefinitions,
} from "@chatman-media/storage";
import {
  effectivePhase,
  FUNNEL_PHASES,
  type FunnelPhase,
} from "@chatman-media/verticals";
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";

/**
 * GET /api/admin/roi?period=30
 *
 * «Сколько ценности принёс AI» — единый экран для клиента и для маркетинга.
 * Всё считается из существующих данных (миграции не нужны):
 * - leadsReceived       — лидов получено за период
 * - fastReply           — доля авто-ответов AI в пределах 30с (user → assistant)
 * - savedLeads          — диалоги, где AI ответил вне рабочих часов («пока вы спали»)
 * - handoffs            — передано оператору (mode=human / escalated)
 * - conversions         — won / lost за период (терминальные стадии)
 * - funnel              — текущее распределение лидов по фазам костяка
 *
 * «Вне рабочих часов» для MVP — это UTC < 9:00 или ≥ 21:00. Per-tenant
 * таймзона — будущая итерация (см. ROADMAP); тогда метрика станет точной.
 */
export interface AdminRoiRoutesOpts {
  db: Db;
}

const FAST_REPLY_SECONDS = 30;
const WORK_HOUR_START_UTC = 9;
const WORK_HOUR_END_UTC = 21;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 365;

export function makeAdminRoiRoutes(opts: AdminRoiRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/admin/roi", async (c) => {
    const tenantId = c.var.tenantId;

    const rawPeriod = Number.parseInt(c.req.query("period") ?? "", 10);
    const periodDays =
      Number.isFinite(rawPeriod) && rawPeriod > 0
        ? Math.min(rawPeriod, MAX_PERIOD_DAYS)
        : DEFAULT_PERIOD_DAYS;

    const now = Math.floor(Date.now() / 1000);
    const since = now - periodDays * 86400;

    const data = await withTenant(opts.db, tenantId, async (tx) => {
      // 1. Лидов получено за период
      const [leadsReceivedRow] = await tx
        .select({ n: count(leads.id) })
        .from(leads)
        .where(and(eq(leads.tenantId, tenantId), gte(leads.createdAt, since)));

      // 2. Скорость авто-ответа: пары user → следующий assistant в одном
      //    диалоге. answered = user-сообщения с ответом ассистента;
      //    within = из них отвечены ≤ 30с.
      const fastRows = (await tx.execute(sql`
        WITH seq AS (
          SELECT
            role,
            created_at,
            LEAD(role) OVER w AS next_role,
            LEAD(created_at) OVER w AS next_created
          FROM messages
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND created_at >= ${since}
          WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id)
        )
        SELECT
          COUNT(*) FILTER (WHERE role = 'user' AND next_role = 'assistant')
            AS answered,
          COUNT(*) FILTER (
            WHERE role = 'user' AND next_role = 'assistant'
              AND next_created - created_at <= ${FAST_REPLY_SECONDS}
          ) AS within
        FROM seq
      `)) as unknown as Array<{ answered: number | string; within: number | string }>;
      const answered = Number(fastRows[0]?.answered ?? 0);
      const within30 = Number(fastRows[0]?.within ?? 0);

      // 3. «Спасённые лиды»: диалоги, где AI ответил вне рабочих часов (UTC).
      const savedRows = (await tx.execute(sql`
        SELECT COUNT(DISTINCT conversation_id) AS n
        FROM messages
        WHERE tenant_id = ${tenantId}
          AND role = 'assistant'
          AND deleted_at IS NULL
          AND created_at >= ${since}
          AND (
            EXTRACT(HOUR FROM to_timestamp(created_at) AT TIME ZONE 'UTC') < ${WORK_HOUR_START_UTC}
            OR EXTRACT(HOUR FROM to_timestamp(created_at) AT TIME ZONE 'UTC') >= ${WORK_HOUR_END_UTC}
          )
      `)) as unknown as Array<{ n: number | string }>;
      const savedLeads = Number(savedRows[0]?.n ?? 0);

      // 4. Передано оператору за период
      const [handoffRow] = await tx
        .select({ n: count(conversations.id) })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            eq(conversations.mode, "human"),
            isNotNull(conversations.escalatedAt),
            gte(conversations.escalatedAt, since),
          ),
        );

      // 5+6. Текущее распределение лидов по фазам костяка + конверсии.
      //      Распределение — lifetime (pipeline сейчас); won/lost за период
      //      берём по leads.updatedAt (момент последнего перехода).
      const stages = await tx
        .select({
          id: stageDefinitions.id,
          kind: stageDefinitions.kind,
          phase: stageDefinitions.phase,
        })
        .from(stageDefinitions)
        .where(eq(stageDefinitions.tenantId, tenantId));
      const phaseByStage = new Map<number, FunnelPhase | null>();
      for (const s of stages) phaseByStage.set(s.id, effectivePhase(s));

      const leadRows = await tx
        .select({
          stageDefinitionId: leads.stageDefinitionId,
          updatedAt: leads.updatedAt,
        })
        .from(leads)
        .where(eq(leads.tenantId, tenantId));

      const phaseTotals = new Map<FunnelPhase, number>();
      let unassigned = 0;
      let wonPeriod = 0;
      let lostPeriod = 0;
      for (const r of leadRows) {
        const p =
          r.stageDefinitionId != null
            ? phaseByStage.get(r.stageDefinitionId)
            : null;
        if (p) {
          phaseTotals.set(p, (phaseTotals.get(p) ?? 0) + 1);
          if (r.updatedAt >= since) {
            if (p === "won") wonPeriod += 1;
            else if (p === "lost") lostPeriod += 1;
          }
        } else {
          unassigned += 1;
        }
      }

      const funnel = FUNNEL_PHASES.map((phase) => ({
        phase,
        leads: phaseTotals.get(phase) ?? 0,
      }));

      return {
        periodDays,
        leadsReceived: leadsReceivedRow?.n ?? 0,
        fastReply: {
          answered,
          within30,
          rate: answered > 0 ? Math.round((within30 / answered) * 100) : null,
          thresholdSeconds: FAST_REPLY_SECONDS,
        },
        savedLeads,
        handoffs: handoffRow?.n ?? 0,
        conversions: { won: wonPeriod, lost: lostPeriod },
        funnel,
        unassigned,
      };
    });

    return c.json(data);
  });

  return app;
}
