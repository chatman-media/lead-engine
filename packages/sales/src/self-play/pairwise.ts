/**
 * Pairwise self-play: run two styles A and B against the SAME candidate
 * persona (same opener, same judging hint), then ask a comparative judge
 * which transcript closed better. Avoids the transitivity assumption of
 * solo-style ELO and produces a direct verdict.
 *
 * Implementation reuses `runSelfPlayMatch` for each side. The only new
 * piece is `judgePairwise` (LLM picks A / B / draw) and
 * `runPairwiseMatch` (drives the two solo runs in sequence).
 */
import type { ChatClient, ChatMessage } from "@chatman-media/rag";
import type { EloOutcome } from "../elo.ts";
import { eloUpdatePair } from "../elo.ts";
import { extractJsonObject } from "../llm-json.ts";
import type { IPairwiseMatchesRepo } from "../store.ts";
import type { Style } from "../types.ts";
import {
  runSelfPlayMatch,
  type SelfPlayDeps,
  type SelfPlayMatchResult,
} from "./orchestrator.ts";
import type { CandidatePersona } from "./personas.ts";

export interface PairwiseDeps extends SelfPlayDeps {
  pairwiseMatches: IPairwiseMatchesRepo;
}

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
  raw?: string;
}

export interface PairwiseMatchResult {
  styleASlug: string;
  styleBSlug: string;
  personaSlug: string;
  matchA: SelfPlayMatchResult;
  matchB: SelfPlayMatchResult;
  verdict: PairwiseVerdict;
  eloAAfter: number;
  eloBAfter: number;
  pairwiseId: number | null;
  /**
   * Whether the pairwise match was durably persisted. `false` means the
   * insert threw and this result exists only in memory — callers running
   * A/B evaluation loops should treat the comparison as not recorded.
   */
  persisted: boolean;
}

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

Return EXACTLY this JSON, nothing else:
{"winner": "a" | "b" | "draw", "reason": "<one short sentence>"}`;

function transcriptToString(t: SelfPlayMatchResult["transcript"]): string {
  return t
    .map(
      (m, i) =>
        `[${i + 1}] ${m.role === "candidate" ? "candidate" : "salesperson"}: ${m.text}`,
    )
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

export function parsePairwiseVerdict(raw: string): PairwiseVerdict {
  const parsed = extractJsonObject(raw);
  if (parsed) {
    const winner = pickWinner(parsed.winner);
    const reason =
      typeof parsed.reason === "string" ? parsed.reason : "(no reason)";
    if (winner) return { winner, reason };
  }
  const m = raw.match(/"winner"\s*:\s*"(a|b|draw)"/i);
  if (m) {
    const winner = (m[1] ?? "draw").toLowerCase() as PairwiseWinner;
    const reasonMatch = raw.match(/"reason"\s*:\s*"([^"]+)"/);
    return { winner, reason: reasonMatch?.[1] ?? "(no reason)" };
  }
  return { winner: "draw", reason: "pairwise judge unparseable", raw };
}

function pickWinner(v: unknown): PairwiseWinner | null {
  if (v === "a" || v === "b" || v === "draw") return v;
  return null;
}

function pairwiseToSoloOutcome(w: PairwiseWinner): EloOutcome {
  if (w === "a") return "won";
  if (w === "b") return "lost";
  return "draw";
}

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

  const aRating = await deps.ratings.getRating(input.styleAId);
  const bRating = await deps.ratings.getRating(input.styleBId);
  const outcomeForA = pairwiseToSoloOutcome(verdict.winner);
  const { a: newA, b: newB } = eloUpdatePair(aRating, bRating, outcomeForA);
  if (newA !== aRating) await deps.ratings.setRating(input.styleAId, newA);
  if (newB !== bRating) await deps.ratings.setRating(input.styleBId, newB);

  let pairwiseId: number | null = null;
  let persisted = false;
  try {
    pairwiseId = await deps.pairwiseMatches.insert({
      matchAId: matchA.matchId ?? 0,
      matchBId: matchB.matchId ?? 0,
      styleASlug: input.styleA.slug,
      styleBSlug: input.styleB.slug,
      personaSlug: input.persona.slug,
      winner: verdict.winner,
      reason: verdict.reason,
    });
    persisted = true;
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
    persisted,
  };
}
