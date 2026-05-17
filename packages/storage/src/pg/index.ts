import type {
  IConversationsRepo,
  ILeadsRepo,
  IPairwiseMatchesRepo,
  ISelfPlayMatchesRepo,
  IShadowEvaluationsRepo,
  ISkillOutcomesRepo,
  ISkillsRepo,
  IStyleRatingsRepo,
  IUsersRepo,
  SelfPlayMatchRecord,
  SelfPlayMatchSummary,
  SkillAggregate,
  SkillRow,
} from "@chatman-media/sales";
import { eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../schema.ts";

type Db = PostgresJsDatabase<typeof schema>;

export class PgSkillsRepo implements ISkillsRepo {
  constructor(private db: Db) {}

  async skillsForStyle(styleId: number): Promise<SkillRow[]> {
    const rows = await this.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.styleId, styleId));
    return rows.map((r) => ({
      slug: r.slug,
      family: r.family,
      display_name: r.displayName,
      prompt_fragment: r.promptFragment,
      applicable_stages: r.applicableStages,
      is_enabled: r.isEnabled === 1,
    }));
  }
}

export class PgSkillOutcomesRepo implements ISkillOutcomesRepo {
  constructor(private db: Db) {}

  async record(opts: {
    skillSlug: string;
    styleSlug: string;
    leadId: number;
    outcome: string;
    source: string;
  }): Promise<void> {
    await this.db.insert(schema.skillOutcomes).values({
      skillSlug: opts.skillSlug,
      styleSlug: opts.styleSlug,
      leadId: opts.leadId,
      outcome: opts.outcome,
      source: opts.source,
    });
  }

  async aggregates(slugs: string[]): Promise<SkillAggregate[]> {
    if (slugs.length === 0) return [];
    const rows = await this.db
      .select({
        skill_slug: schema.skillOutcomes.skillSlug,
        wins: sql<number>`count(*) filter (where ${schema.skillOutcomes.outcome} = 'won')`,
        losses: sql<number>`count(*) filter (where ${schema.skillOutcomes.outcome} = 'lost')`,
        draws: sql<number>`count(*) filter (where ${schema.skillOutcomes.outcome} = 'draw')`,
        count: sql<number>`count(*)`,
      })
      .from(schema.skillOutcomes)
      .where(inArray(schema.skillOutcomes.skillSlug, slugs))
      .groupBy(schema.skillOutcomes.skillSlug);
    return rows.map((r) => ({
      skill_slug: r.skill_slug,
      wins: Number(r.wins),
      losses: Number(r.losses),
      draws: Number(r.draws),
      count: Number(r.count),
    }));
  }
}

export class PgStyleRatingsRepo implements IStyleRatingsRepo {
  constructor(private db: Db) {}

  async getRating(styleId: number): Promise<number> {
    const [row] = await this.db
      .select({ rating: schema.styleRatings.rating })
      .from(schema.styleRatings)
      .where(eq(schema.styleRatings.styleId, styleId));
    return row?.rating ?? 1500;
  }

  async setRating(styleId: number, rating: number): Promise<void> {
    await this.db
      .insert(schema.styleRatings)
      .values({ styleId, rating })
      .onConflictDoUpdate({
        target: schema.styleRatings.styleId,
        set: { rating, updatedAt: sql`now()` },
      });
  }
}

export class PgSelfPlayMatchesRepo implements ISelfPlayMatchesRepo {
  constructor(private db: Db) {}

  async insert(
    match: Omit<SelfPlayMatchRecord, "id"> & { judge_reason: string },
  ): Promise<number> {
    const [row] = await this.db
      .insert(schema.selfPlayMatches)
      .values({
        styleSlug: match.style_slug,
        personaSlug: match.persona_slug,
        outcome: match.outcome,
        skills: match.skills,
        judgeReason: match.judge_reason,
        transcript: match.transcript,
      })
      .returning({ id: schema.selfPlayMatches.id });
    if (!row) throw new Error("insert failed");
    return row.id;
  }

  async byId(id: number): Promise<SelfPlayMatchRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.selfPlayMatches)
      .where(eq(schema.selfPlayMatches.id, id));
    if (!row) return null;
    return {
      id: row.id,
      style_slug: row.styleSlug,
      persona_slug: row.personaSlug,
      outcome: row.outcome as SelfPlayMatchRecord["outcome"],
      skills: row.skills,
      judge_reason: row.judgeReason,
      transcript: row.transcript as SelfPlayMatchRecord["transcript"],
    };
  }

  async list(opts: {
    styleSlug: string;
    outcome?: string;
    limit?: number;
    personaSlug?: string;
  }): Promise<SelfPlayMatchSummary[]> {
    const conditions = [eq(schema.selfPlayMatches.styleSlug, opts.styleSlug)];
    if (opts.outcome) {
      conditions.push(eq(schema.selfPlayMatches.outcome, opts.outcome));
    }
    if (opts.personaSlug) {
      conditions.push(eq(schema.selfPlayMatches.personaSlug, opts.personaSlug));
    }
    const rows = await this.db
      .select({
        id: schema.selfPlayMatches.id,
        style_slug: schema.selfPlayMatches.styleSlug,
        persona_slug: schema.selfPlayMatches.personaSlug,
        outcome: schema.selfPlayMatches.outcome,
        skills: schema.selfPlayMatches.skills,
        judge_reason: schema.selfPlayMatches.judgeReason,
      })
      .from(schema.selfPlayMatches)
      .where(sql`${conditions.reduce((a, b) => sql`${a} and ${b}`)}`)
      .limit(opts.limit ?? 50);
    return rows.map((r) => ({
      id: r.id,
      style_slug: r.style_slug,
      persona_slug: r.persona_slug,
      outcome: r.outcome as SelfPlayMatchSummary["outcome"],
      skills: r.skills,
      judge_reason: r.judge_reason,
    }));
  }
}

export class PgPairwiseMatchesRepo implements IPairwiseMatchesRepo {
  constructor(private db: Db) {}

  async insert(opts: {
    matchAId: number;
    matchBId: number;
    styleASlug: string;
    styleBSlug: string;
    personaSlug: string;
    winner: "a" | "b" | "draw";
    reason: string;
  }): Promise<number> {
    const [row] = await this.db
      .insert(schema.pairwiseMatches)
      .values({
        matchAId: opts.matchAId,
        matchBId: opts.matchBId,
        styleASlug: opts.styleASlug,
        styleBSlug: opts.styleBSlug,
        personaSlug: opts.personaSlug,
        winner: opts.winner,
        reason: opts.reason,
      })
      .returning({ id: schema.pairwiseMatches.id });
    if (!row) throw new Error("insert failed");
    return row.id;
  }
}

export class PgShadowEvaluationsRepo implements IShadowEvaluationsRepo {
  constructor(private db: Db) {}

  async update(
    evalId: number,
    patch: {
      status?: "running" | "complete" | "failed";
      decision?: "keep" | "rollback" | "inconclusive";
      totalPairs?: number;
      bWins?: number;
      error?: string;
    },
  ): Promise<void> {
    await this.db
      .update(schema.shadowEvaluations)
      .set({
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.decision !== undefined && { decision: patch.decision }),
        ...(patch.totalPairs !== undefined && { totalPairs: patch.totalPairs }),
        ...(patch.bWins !== undefined && { bWins: patch.bWins }),
        ...(patch.error !== undefined && { error: patch.error }),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.shadowEvaluations.id, evalId));
  }
}

export class PgUsersRepo implements IUsersRepo {
  constructor(private db: Db) {}

  async upsert(opts: { telegramId: number; username?: string }): Promise<{ id: number }> {
    const [row] = await this.db
      .insert(schema.users)
      .values({ telegramId: opts.telegramId, username: opts.username })
      .onConflictDoUpdate({
        target: schema.users.telegramId,
        set: { username: opts.username },
      })
      .returning({ id: schema.users.id });
    if (!row) throw new Error("upsert failed");
    return { id: row.id };
  }
}

export class PgConversationsRepo implements IConversationsRepo {
  constructor(private db: Db) {}

  async create(opts: { userId: number; styleSlug: string }): Promise<{ id: number }> {
    const [row] = await this.db
      .insert(schema.conversations)
      .values({ userId: opts.userId, styleSlug: opts.styleSlug })
      .returning({ id: schema.conversations.id });
    if (!row) throw new Error("insert failed");
    return { id: row.id };
  }
}

export class PgLeadsRepo implements ILeadsRepo {
  constructor(private db: Db) {}

  async create(opts: { conversationId: number }): Promise<{ id: number }> {
    const [row] = await this.db
      .insert(schema.leads)
      .values({ conversationId: opts.conversationId })
      .returning({ id: schema.leads.id });
    if (!row) throw new Error("insert failed");
    return { id: row.id };
  }
}

/** Convenience bundle — construct all repos from one Drizzle db instance. */
export function createPgRepos(db: Db) {
  return {
    skills: new PgSkillsRepo(db),
    outcomes: new PgSkillOutcomesRepo(db),
    ratings: new PgStyleRatingsRepo(db),
    matches: new PgSelfPlayMatchesRepo(db),
    pairwise: new PgPairwiseMatchesRepo(db),
    shadowEvals: new PgShadowEvaluationsRepo(db),
    users: new PgUsersRepo(db),
    conversations: new PgConversationsRepo(db),
    leads: new PgLeadsRepo(db),
  };
}
