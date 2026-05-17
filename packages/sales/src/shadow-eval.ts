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
import type { ChatClient, EmbeddingClient, IKbStore } from "@chatman-media/rag";
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
export async function runShadowEval(
  deps: ShadowEvalDeps,
  input: ShadowEvalInput,
): Promise<void> {
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
    });
    return;
  }

  let aWins = 0;
  let bWins = 0;
  let draws = 0;

  try {
    for (const { persona } of pairs) {
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
          ...(deps.vacanciesBlock
            ? { vacanciesBlock: deps.vacanciesBlock }
            : {}),
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
      await deps.shadowRepo.update(input.evalId, {
        totalPairs: aWins + bWins + draws,
        bWins: bWins + 0.5 * draws,
      });
    }

    const bAdjusted = bWins + 0.5 * draws;
    const decision = shadowDecide(bAdjusted, total);
    await deps.shadowRepo.update(input.evalId, {
      status: "complete",
      decision,
      totalPairs: total,
      bWins: bAdjusted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.shadowRepo.update(input.evalId, {
      status: "failed",
      error: msg,
    });
    console.warn(
      `[shadow-eval] eval #${input.evalId} failed after ${aWins + bWins + draws}/${total} pairs: ${msg}`,
    );
  }
}
