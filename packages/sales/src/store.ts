/**
 * Storage interfaces for the sales engine.
 *
 * The sales engine never imports concrete DB repositories directly — it
 * depends only on these interfaces. The host application provides
 * implementations (PostgreSQL, SQLite, in-memory) at construction time.
 *
 * Minimal surface: only the methods actually called by the engine are
 * declared here. Implementations may expose more; the engine won't see it.
 */
import type { EloOutcome } from "./elo.ts";

// ─── Skill data ─────────────────────────────────────────────────────────────

export interface SkillRow {
  slug: string;
  family: string;
  display_name: string;
  prompt_fragment: string;
  applicable_stages: string[];
  is_enabled: boolean;
}

export interface SkillAggregate {
  skill_slug: string;
  wins: number;
  losses: number;
  draws: number;
  count: number;
}

export interface ISkillsRepo {
  /** All enabled skills for a given style. */
  skillsForStyle(styleId: number): Promise<SkillRow[]>;
}

export interface ISkillOutcomesRepo {
  /** Record a skill outcome for a single match. */
  record(opts: {
    skillSlug: string;
    styleSlug: string;
    leadId: number;
    outcome: EloOutcome;
    source: string;
  }): Promise<void>;
  /** Aggregate win/draw/loss counts per skill slug. */
  aggregates(slugs: string[]): Promise<SkillAggregate[]>;
}

export interface IStyleRatingsRepo {
  /** Current ELO rating for a style (returns 1500 if not found). */
  getRating(styleId: number): Promise<number>;
  /** Persist updated ELO rating. */
  setRating(styleId: number, rating: number): Promise<void>;
}

// ─── Self-play match data ────────────────────────────────────────────────────

export interface SelfPlayTurn {
  role: "candidate" | "salesperson";
  text: string;
}

export interface SelfPlayMatchSummary {
  id: number;
  style_slug: string;
  persona_slug: string;
  outcome: EloOutcome;
  skills: string[];
  judge_reason: string | null;
}

export interface SelfPlayMatchRecord extends SelfPlayMatchSummary {
  transcript: SelfPlayTurn[];
}

export interface ISelfPlayMatchesRepo {
  /** Insert a completed match and return its id. */
  insert(
    match: Omit<SelfPlayMatchRecord, "id"> & { judge_reason: string },
  ): Promise<number>;
  /** Fetch full match with transcript (null if not found). */
  byId(id: number): Promise<SelfPlayMatchRecord | null>;
  /** List recent matches, optionally filtered. */
  list(opts: {
    styleSlug: string;
    outcome?: EloOutcome;
    limit?: number;
    personaSlug?: string;
  }): Promise<SelfPlayMatchSummary[]>;
}

export interface IPairwiseMatchesRepo {
  /** Insert a pairwise comparison result and return its id. */
  insert(opts: {
    matchAId: number;
    matchBId: number;
    styleASlug: string;
    styleBSlug: string;
    personaSlug: string;
    winner: "a" | "b" | "draw";
    reason: string;
  }): Promise<number>;
}

export interface IShadowEvaluationsRepo {
  /** Update status / decision / error of a shadow eval run. */
  update(
    evalId: number,
    patch: {
      status?: "running" | "complete" | "failed";
      decision?: "keep" | "rollback" | "inconclusive";
      totalPairs?: number;
      bWins?: number;
      error?: string;
    },
  ): Promise<void>;
}

// ─── Conversation / lead plumbing needed by orchestrator ────────────────────

export interface IUsersRepo {
  upsert(opts: {
    telegramId: number;
    username?: string;
  }): Promise<{ id: number }>;
}

export interface IConversationsRepo {
  create(opts: { userId: number; styleSlug: string }): Promise<{ id: number }>;
}

export interface ILeadsRepo {
  create(opts: { conversationId: number }): Promise<{ id: number }>;
}
