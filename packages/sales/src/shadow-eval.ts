/**
 * Shadow A/B runner — pits a freshly-forked style version (B) head-to-head
 * against its parent (A) over N pairwise matches, then computes a Wilson
 * 95% lower bound on B's win rate to recommend keep / rollback.
 *
 * Runs IN-PROCESS as a background task (no worker queue). The HTTP endpoint
 * used to fire-and-forget this function directly. Current production code
 * calls it from a DB-backed queue claim so API restarts can recover stale
 * `running` rows without losing the operator-visible eval status.
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
import type { ChatClient, EmbeddingClient } from "@chatman-media/llm-router";
import type { IKbStore } from "@chatman-media/kb";
import { runPairwiseMatch } from "./self-play/pairwise.ts";
import type { CandidatePersona } from "./self-play/personas.ts";
import { wilsonLowerBound } from "./skill-recommendations.ts";
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
} from "./store.ts";
import type { Style } from "./types.ts";

export interface ShadowEvalDeps {
  shadowRepo: IShadowEvaluationsRepo;
  kb: IKbStore;
  skills: ISkillsRepo;
  outcomes: ISkillOutcomesRepo;
  ratings: IStyleRatingsRepo;
  users: IUsersRepo;
  conversations: IConversationsRepo;
  leads: ILeadsRepo;
  salesChat: ChatClient;
  candidateChat: ChatClient;
  judgeChat: ChatClient;
  embedder: EmbeddingClient;
  vacanciesBlock?: string;
  matches: ISelfPlayMatchesRepo;
  pairwiseMatches: IPairwiseMatchesRepo;
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
  resume?: {
    pairsDone: number;
    aWins: number;
    bWins: number;
    draws: number;
  };
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
    await deps.shadowRepo.update(input.evalId, {
      status: "complete",
      decision: "inconclusive",
      totalPairs: 0,
      aWins: 0,
      bWins: 0,
      draws: 0,
      winRateLb: null,
    });
    return;
  }

  const resume = normalizeResume(input.resume, total);
  let aWins = resume.aWins;
  let bWins = resume.bWins;
  let draws = resume.draws;

  try {
    for (const { persona } of pairs.slice(resume.pairsDone)) {
      const result = await runPairwiseMatch(
        {
          users: deps.users,
          conversations: deps.conversations,
          leads: deps.leads,
          kb: deps.kb,
          skills: deps.skills,
          outcomes: deps.outcomes,
          ratings: deps.ratings,
          matches: deps.matches,
          pairwiseMatches: deps.pairwiseMatches,
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
      if (result.verdict.winner === "a") aWins++;
      else if (result.verdict.winner === "b") bWins++;
      else draws++;
      const pairsDone = aWins + bWins + draws;
      const bAdjusted = bWins + 0.5 * draws;
      await deps.shadowRepo.update(input.evalId, {
        totalPairs: pairsDone,
        aWins,
        bWins,
        draws,
        winRateLb: wilsonLowerBound(bAdjusted, pairsDone),
      });
    }

    const bAdjusted = bWins + 0.5 * draws;
    const decision = shadowDecide(bAdjusted, total);
    await deps.shadowRepo.update(input.evalId, {
      status: "complete",
      decision,
      totalPairs: total,
      aWins,
      bWins,
      draws,
      winRateLb: wilsonLowerBound(bAdjusted, total),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const pairsDone = aWins + bWins + draws;
    const bAdjusted = bWins + 0.5 * draws;
    await deps.shadowRepo.update(input.evalId, {
      status: "failed",
      totalPairs: pairsDone,
      aWins,
      bWins,
      draws,
      winRateLb: pairsDone > 0 ? wilsonLowerBound(bAdjusted, pairsDone) : null,
      error: msg,
    });
    console.warn(
      `[shadow-eval] eval #${input.evalId} failed after ${aWins + bWins + draws}/${total} pairs: ${msg}`,
    );
  }
}

function normalizeResume(
  resume: ShadowEvalInput["resume"],
  total: number,
): { pairsDone: number; aWins: number; bWins: number; draws: number } {
  if (!resume) return { pairsDone: 0, aWins: 0, bWins: 0, draws: 0 };
  const pairsDone = Math.max(0, Math.min(total, resume.pairsDone));
  const aWins = Math.max(0, resume.aWins);
  const bWins = Math.max(0, resume.bWins);
  const draws = Math.max(0, resume.draws);
  if (aWins + bWins + draws !== pairsDone) {
    return { pairsDone: 0, aWins: 0, bWins: 0, draws: 0 };
  }
  return { pairsDone, aWins, bWins, draws };
}
