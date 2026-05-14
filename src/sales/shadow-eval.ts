/**
 * Shadow A/B runner — pits a freshly-forked style version (B) head-to-head
 * against its parent (A) over N pairwise matches, then computes a Wilson
 * 95% lower bound on B's win rate to recommend keep / rollback.
 *
 * Runs IN-PROCESS as a background task (no worker queue). The HTTP endpoint
 * inserts the row, then kicks off `runShadowEvalBackground` and returns
 * immediately. UI polls GET /admin/api/coach/:id/shadow-eval until status
 * transitions to complete or failed.
 *
 * Decision thresholds (B's Wilson LB at 95% confidence):
 *   >= 0.55 → keep      (clear improvement)
 *   <= 0.45 → rollback  (clear regression)
 *   else    → inconclusive (need more pairs / human review)
 *
 * Wins/losses for B are derived from pairwise verdicts:
 *   winner='b'    → B win (parent loss)
 *   winner='a'    → A win (B loss)
 *   winner='draw' → counted as 0.5 wins for Wilson — same `actualScore`
 *                   convention used in ELO.
 */
import type { ConversationsRepo } from "../db/repos/conversations.ts";
import type { KbRepo } from "../db/repos/kb.ts";
import type { LeadsRepo } from "../db/repos/leads.ts";
import type { ShadowEvaluationsRepo } from "../db/repos/shadow-evaluations.ts";
import type { SkillOutcomesRepo, StyleRatingsRepo } from "../db/repos/skill-outcomes.ts";
import type { SkillsRepo } from "../db/repos/skills.ts";
import type { UsersRepo } from "../db/repos/users.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import { runPairwiseMatch } from "./self-play/pairwise.ts";
import type { CandidatePersona } from "./self-play/personas.ts";
import { wilsonLowerBound } from "./skill-recommendations.ts";
import type { Style } from "./types.ts";

export interface ShadowEvalDeps {
  shadowRepo: ShadowEvaluationsRepo;
  kb: KbRepo;
  skills: SkillsRepo;
  outcomes: SkillOutcomesRepo;
  ratings: StyleRatingsRepo;
  users: UsersRepo;
  conversations: ConversationsRepo;
  leads: LeadsRepo;
  salesChat: ChatClient;
  candidateChat: ChatClient;
  judgeChat: ChatClient;
  embedder: EmbeddingClient;
  vacanciesBlock?: string;
  /** db is needed by orchestrator — passed through pairwise deps. */
  db: import("../db/postgres.ts").Sql;
}

export interface ShadowEvalInput {
  evalId: number;
  parentStyle: Style;
  parentStyleId: number;
  newStyle: Style;
  newStyleId: number;
  personas: readonly CandidatePersona[];
  runs: number;
  maxTurns: number;
}

const DECISION_THRESHOLD_KEEP = 0.55;
const DECISION_THRESHOLD_ROLLBACK = 0.45;

/**
 * Decide keep / rollback / inconclusive from B's Wilson lower bound.
 * Exported for tests and for re-evaluation when more pairs land later.
 */
export function shadowDecide(
  bWinsAdjusted: number,
  totalPairs: number,
): "keep" | "rollback" | "inconclusive" {
  if (totalPairs === 0) return "inconclusive";
  const lb = wilsonLowerBound(bWinsAdjusted, totalPairs);
  if (lb >= DECISION_THRESHOLD_KEEP) return "keep";
  if (lb <= DECISION_THRESHOLD_ROLLBACK) return "rollback";
  return "inconclusive";
}

/**
 * Runs the full eval batch synchronously. The HTTP layer wraps this in a
 * fire-and-forget so the request returns before the first pair finishes —
 * caller should NOT await this for the HTTP response.
 *
 * Mid-batch failures are caught and recorded as `failed` with an error
 * message; partial results are NOT rolled back so the operator still sees
 * "got 4 of 8 pairs before X happened".
 */
export async function runShadowEval(deps: ShadowEvalDeps, input: ShadowEvalInput): Promise<void> {
  const pairs: Array<{ persona: CandidatePersona }> = [];
  for (const persona of input.personas) {
    for (let r = 0; r < input.runs; r++) {
      pairs.push({ persona });
    }
  }
  const total = pairs.length;
  if (total === 0) {
    await deps.shadowRepo.complete(input.evalId, 0, "inconclusive");
    return;
  }

  let aWins = 0;
  let bWins = 0;
  let draws = 0;

  try {
    for (const { persona } of pairs) {
      // Pairwise: A=parent, B=new fork. Same persona, same opener, only
      // the salesperson side differs — exactly what we want to A/B.
      const result = await runPairwiseMatch(
        {
          db: deps.db,
          users: deps.users,
          conversations: deps.conversations,
          leads: deps.leads,
          kb: deps.kb,
          skills: deps.skills,
          outcomes: deps.outcomes,
          ratings: deps.ratings,
          salesChat: deps.salesChat,
          candidateChat: deps.candidateChat,
          judgeChat: deps.judgeChat,
          embedder: deps.embedder,
          ...(deps.vacanciesBlock ? { vacanciesBlock: deps.vacanciesBlock } : {}),
        },
        {
          styleA: input.parentStyle,
          styleAId: input.parentStyleId,
          styleB: input.newStyle,
          styleBId: input.newStyleId,
          persona,
          maxTurns: input.maxTurns,
        },
      );
      await deps.shadowRepo.bumpPairResult(input.evalId, result.verdict.winner);
      if (result.verdict.winner === "a") aWins++;
      else if (result.verdict.winner === "b") bWins++;
      else draws++;
    }

    // Wilson LB on B's win rate, treating draws as half-wins (same
    // convention as actualScore in elo.ts).
    const bAdjusted = bWins + 0.5 * draws;
    const lb = wilsonLowerBound(bAdjusted, total);
    const decision = shadowDecide(bAdjusted, total);
    await deps.shadowRepo.complete(input.evalId, lb, decision);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.shadowRepo.fail(input.evalId, msg);
    console.warn(
      `[shadow-eval] eval #${input.evalId} failed after ${aWins + bWins + draws}/${total} pairs: ${msg}`,
    );
  }
}
