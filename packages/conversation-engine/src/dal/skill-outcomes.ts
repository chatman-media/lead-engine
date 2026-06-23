import { skillOutcomes as skillOutcomesTable } from "@chatman-media/storage";
import { and, eq, sql } from "drizzle-orm";
import type { RepoCtx } from "./types.ts";

export interface SkillOutcomeRow {
  id: number;
  tenantId: number;
  leadId: number;
  conversationId: number | null;
  messageId: number | null;
  styleSlug: string | null;
  skillSlug: string;
  outcome: "won" | "lost" | "draw";
  source: "lead_submitted" | "lead_rejected" | "lead_ghosted" | "manual" | "self_play";
  createdAt: number;
}

export interface SkillAggregateRow {
  skillSlug: string;
  wins: number;
  losses: number;
  draws: number;
  total: number;
}

/**
 * Per-skill outcome tracking. После того как lead закрыт (won/lost/ghosted),
 * coach-analyzer проходит по messages в conversation и для каждой assistant-
 * реплики дёргает gradeSkills из @chatman-media/kb — возвращённые slugs
 * пишутся в skill_outcomes с этим outcome'ом. Aggregate'ы дают win-rate
 * per skill для admin-UI / coach-proposals.
 *
 * Дедупликация: uniq на (lead_id, skill_slug, source) гарантирует одну
 * запись на тройку — повторный coach-batch на тот же lead = no-op.
 */
export class SkillOutcomesRepo {
  constructor(private readonly ctx: RepoCtx) {}

  /**
   * Idempotent insert: ON CONFLICT DO NOTHING на uq_skill_outcomes_idempotency
   * (lead_id, skill_slug, source). Возвращает true если строка реально
   * вставлена, false если был conflict.
   */
  async record(opts: {
    leadId: number;
    skillSlug: string;
    outcome: "won" | "lost" | "draw";
    source: SkillOutcomeRow["source"];
    conversationId?: number | null;
    messageId?: number | null;
    styleSlug?: string | null;
    nowEpoch: number;
  }): Promise<boolean> {
    const result = (await this.ctx.db.execute(sql`
      INSERT INTO skill_outcomes
        (tenant_id, lead_id, conversation_id, message_id, style_slug,
         skill_slug, outcome, source, created_at)
      VALUES
        (${this.ctx.tenantId}, ${opts.leadId},
         ${opts.conversationId ?? null}, ${opts.messageId ?? null},
         ${opts.styleSlug ?? null}, ${opts.skillSlug}, ${opts.outcome},
         ${opts.source}, ${opts.nowEpoch})
      ON CONFLICT (lead_id, skill_slug, source) DO NOTHING
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    return result.length > 0;
  }

  /** Все outcomes по lead'у (для inspect'а в admin-UI). */
  async byLeadId(leadId: number): Promise<SkillOutcomeRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(skillOutcomesTable)
      .where(
        and(
          eq(skillOutcomesTable.tenantId, this.ctx.tenantId),
          eq(skillOutcomesTable.leadId, leadId),
        ),
      );
    return rows as SkillOutcomeRow[];
  }

  /**
   * Aggregate win/loss/draw counts per skill. Без фильтра по style_slug —
   * стиль-specific агрегаты для shadow-evaluations считаются отдельным
   * запросом в caller'е через дополнительный WHERE.
   */
  async aggregates(): Promise<SkillAggregateRow[]> {
    const rows = (await this.ctx.db.execute(sql`
      SELECT
        skill_slug,
        SUM(CASE WHEN outcome='won' THEN 1 ELSE 0 END)::INTEGER  AS wins,
        SUM(CASE WHEN outcome='lost' THEN 1 ELSE 0 END)::INTEGER AS losses,
        SUM(CASE WHEN outcome='draw' THEN 1 ELSE 0 END)::INTEGER AS draws,
        COUNT(*)::INTEGER AS total
      FROM skill_outcomes
      WHERE tenant_id = ${this.ctx.tenantId}
      GROUP BY skill_slug
      ORDER BY total DESC
    `)) as unknown as Array<{
      skill_slug: string;
      wins: number;
      losses: number;
      draws: number;
      total: number;
    }>;
    return rows.map((r) => ({
      skillSlug: r.skill_slug,
      wins: r.wins,
      losses: r.losses,
      draws: r.draws,
      total: r.total,
    }));
  }
}
