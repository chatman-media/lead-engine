/**
 * Pairwise self-play: run two styles A and B against the SAME candidate
 * persona (same opener, same judging hint), then ask a comparative judge
 * which transcript closed better. Avoids the transitivity assumption of
 * solo-style ELO ("A beat baseline, B beat baseline → A vs B is unclear")
 * and produces a direct verdict you can trust without 100s of matches.
 *
 * Implementation reuses `runSelfPlayMatch` for each side — orchestrator,
 * reflect, per-turn skill grading all kept identical. The only new piece
 * is `judgePairwise` (LLM picks A / B / draw given both transcripts) and
 * `runPairwiseMatch` (drives the two solo runs in sequence and assembles).
 *
 * ELO updates use `eloUpdatePair` so both styles' ratings move
 * symmetrically — A's gain is B's loss, no baseline drift.
 */
import { PairwiseMatchesRepo } from "../../db/repos/pairwise-matches.ts";
import type { ChatClient, ChatMessage } from "../../rag/chat.ts";
import type { EloOutcome } from "../elo.ts";
import { eloUpdatePair } from "../elo.ts";
import type { Style } from "../types.ts";
import { runSelfPlayMatch, type SelfPlayDeps, type SelfPlayMatchResult } from "./orchestrator.ts";
import type { CandidatePersona } from "./personas.ts";

export interface PairwiseDeps extends SelfPlayDeps {}

export interface PairwiseInput {
  styleA: Style;
  styleAId: number;
  styleB: Style;
  styleBId: number;
  persona: CandidatePersona;
  maxTurns?: number;
}

export type PairwiseWinner = "a" | "b" | "draw";

export interface PairwiseVerdict {
  winner: PairwiseWinner;
  reason: string;
  /** Raw judge output when parsing failed — for debugging. */
  raw?: string;
}

export interface PairwiseMatchResult {
  styleASlug: string;
  styleBSlug: string;
  personaSlug: string;
  matchA: SelfPlayMatchResult;
  matchB: SelfPlayMatchResult;
  verdict: PairwiseVerdict;
  /** ELO after applying the symmetric pair update (BEFORE individual
   *  per-match ELO already applied by `runSelfPlayMatch`). The two
   *  effects compound; this field reports the pairwise delta only. */
  eloAAfter: number;
  eloBAfter: number;
  /** Row id in `pairwise_matches` after persistence, or null when the
   *  insert failed (logged but non-fatal). */
  pairwiseId: number | null;
}

/**
 * Comparative judge prompt — shows BOTH transcripts and asks which
 * salesperson did better against the same candidate persona. Forced to
 * pick A, B, or draw with a one-sentence reason. Conservative default
 * is "draw" on ambiguity (mirror of the solo judge bias).
 */
const PAIRWISE_SYSTEM = (hint: string) =>
  `You are an objective judge comparing TWO sales conversations between an agency salesperson (Russian-speaking recruiter for foreign work contracts) and the SAME candidate persona. The candidate said exactly the same opener in both transcripts; only the salesperson side differs.

Pick which salesperson handled this candidate better.

WHAT "BETTER" LOOKS LIKE FOR THIS PERSONA:
${hint}

Tie-breakers (in order):
  1. Did the candidate explicitly commit to a next step (anketa / call / fly out / sign / send photos)?
  2. Did the salesperson stay grounded (no fabricated dates, cities, numbers)?
  3. Did the salesperson advance through the funnel (qualify → pitch → close) or stall?
  4. Tone fit for the persona (gentle for anxious / direct for time-pressed / etc.).

CRITICAL: When the difference is genuinely small or both ended without commitment, return "draw". Don't reward verbosity. Don't reward politeness alone.

OUTPUT FORMAT — RETURN EXACTLY THIS JSON, NOTHING ELSE:
{"winner": "a" | "b" | "draw", "reason": "<one short sentence>"}

No markdown, no explanation outside the JSON.`;

function transcriptToString(t: SelfPlayMatchResult["transcript"]): string {
  return t
    .map((m, i) => `[${i + 1}] ${m.role === "candidate" ? "candidate" : "salesperson"}: ${m.text}`)
    .join("\n");
}

export async function judgePairwise(args: {
  judgingHint: string;
  styleASlug: string;
  styleBSlug: string;
  transcriptA: SelfPlayMatchResult["transcript"];
  transcriptB: SelfPlayMatchResult["transcript"];
  chat: ChatClient;
  model?: string;
}): Promise<PairwiseVerdict> {
  const messages: ChatMessage[] = [
    { role: "system", content: PAIRWISE_SYSTEM(args.judgingHint) },
    {
      role: "user",
      content:
        `Transcript A (style: ${args.styleASlug}):\n` +
        transcriptToString(args.transcriptA) +
        `\n\nTranscript B (style: ${args.styleBSlug}):\n` +
        transcriptToString(args.transcriptB) +
        `\n\n/no_think\nReturn the JSON verdict now.`,
    },
  ];
  let raw: string;
  try {
    raw = await args.chat.complete(messages, {
      temperature: 0,
      ...(args.model ? { model: args.model } : {}),
      numPredict: 600,
    });
  } catch (err) {
    return {
      winner: "draw",
      reason: `pairwise judge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parsePairwiseVerdict(raw);
}

/**
 * Tolerant JSON parser. Strips code fences, attempts JSON.parse, falls
 * back to regex. Defaults to "draw" on any ambiguity. Exported for tests.
 */
export function parsePairwiseVerdict(raw: string): PairwiseVerdict {
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object") {
      const winner = pickWinner(parsed.winner);
      const reason = typeof parsed.reason === "string" ? parsed.reason : "(no reason)";
      if (winner) return { winner, reason };
    }
  } catch {
    /* fall through to regex */
  }
  const m = stripped.match(/"winner"\s*:\s*"(a|b|draw)"/i);
  if (m) {
    const winner = m[1]!.toLowerCase() as PairwiseWinner;
    const reasonMatch = stripped.match(/"reason"\s*:\s*"([^"]+)"/);
    return { winner, reason: reasonMatch?.[1] ?? "(no reason)" };
  }
  return { winner: "draw", reason: "pairwise judge unparseable", raw };
}

function pickWinner(v: unknown): PairwiseWinner | null {
  if (v === "a" || v === "b" || v === "draw") return v;
  return null;
}

/**
 * Map pairwise winner → solo `EloOutcome` for style A. B's outcome is
 * the inverse (won↔lost, draw↔draw). Used to drive `eloUpdatePair`.
 */
function pairwiseToSoloOutcome(w: PairwiseWinner): EloOutcome {
  if (w === "a") return "won";
  if (w === "b") return "lost";
  return "draw";
}

/**
 * Run two solo matches (style A vs persona, style B vs persona) and
 * compare their transcripts via `judgePairwise`. Both solo matches still
 * persist into self_play_matches for transcript review; the pairwise
 * verdict is RETURNED but NOT auto-persisted into a separate table —
 * caller decides (CLI prints, future admin endpoint stores).
 *
 * ELO: applies a symmetric `eloUpdatePair` AFTER the solo runs. Note
 * this compounds with each solo `applyOutcome` already done inside
 * `runSelfPlayMatch` — by design, solo ELO captures absolute strength
 * and pairwise ELO captures head-to-head dominance.
 */
export async function runPairwiseMatch(
  deps: PairwiseDeps,
  input: PairwiseInput,
): Promise<PairwiseMatchResult> {
  const matchA = await runSelfPlayMatch(deps, {
    style: input.styleA,
    styleId: input.styleAId,
    persona: input.persona,
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
  });
  const matchB = await runSelfPlayMatch(deps, {
    style: input.styleB,
    styleId: input.styleBId,
    persona: input.persona,
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
  });

  const verdict = await judgePairwise({
    judgingHint: input.persona.judgingHint,
    styleASlug: input.styleA.slug,
    styleBSlug: input.styleB.slug,
    transcriptA: matchA.transcript,
    transcriptB: matchB.transcript,
    chat: deps.judgeChat,
  });

  // Apply symmetric pairwise ELO on top of the solo updates already done.
  const ratingA = deps.ratings.bySlug(input.styleA.slug);
  const ratingB = deps.ratings.bySlug(input.styleB.slug);
  const a = ratingA?.elo ?? 1500;
  const b = ratingB?.elo ?? 1500;
  const outcomeForA = pairwiseToSoloOutcome(verdict.winner);
  const { a: newA, b: newB } = eloUpdatePair(a, b, outcomeForA);
  // Persist by writing a single outcome on each side that yields the
  // exact post-pair ELO. Skip the writes when both ratings are unchanged
  // (draw at equal ELO → no-op).
  if (newA !== a) {
    // We can't directly set the ELO via applyOutcome (which recomputes from
    // K * (actual - expected)). Bump via raw SQL to the precomputed value.
    deps.db.run(
      `INSERT INTO style_ratings (style_slug, elo, wins, losses, draws, last_outcome_at)
       VALUES (?, ?, 0, 0, 0, unixepoch())
       ON CONFLICT(style_slug) DO UPDATE SET
         elo = excluded.elo,
         last_outcome_at = unixepoch(),
         updated_at = unixepoch()`,
      [input.styleA.slug, newA],
    );
  }
  if (newB !== b) {
    deps.db.run(
      `INSERT INTO style_ratings (style_slug, elo, wins, losses, draws, last_outcome_at)
       VALUES (?, ?, 0, 0, 0, unixepoch())
       ON CONFLICT(style_slug) DO UPDATE SET
         elo = excluded.elo,
         last_outcome_at = unixepoch(),
         updated_at = unixepoch()`,
      [input.styleB.slug, newB],
    );
  }

  // Persist the pairwise row, linking to the two solo matches by id
  // (already inserted by runSelfPlayMatch). Failure-soft: a transcript
  // already exists on each side; losing the pairwise row is recoverable.
  let pairwiseId: number | null = null;
  try {
    const row = new PairwiseMatchesRepo(deps.db).insert({
      styleASlug: input.styleA.slug,
      styleBSlug: input.styleB.slug,
      personaSlug: input.persona.slug,
      winner: verdict.winner,
      judgeReason: verdict.reason,
      matchAId: matchA.matchId,
      matchBId: matchB.matchId,
      eloAAfter: newA,
      eloBAfter: newB,
    });
    pairwiseId = row.id;
  } catch (err) {
    console.warn("[pairwise] failed to persist pairwise match:", err);
  }

  return {
    styleASlug: input.styleA.slug,
    styleBSlug: input.styleB.slug,
    personaSlug: input.persona.slug,
    matchA,
    matchB,
    verdict,
    eloAAfter: newA,
    eloBAfter: newB,
    pairwiseId,
  };
}
