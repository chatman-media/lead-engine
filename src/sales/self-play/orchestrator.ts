/**
 * Self-play orchestrator. Takes a salesperson Style + a candidate persona,
 * runs them in alternating turns through real chat clients, then asks
 * a judge LLM for the verdict. Writes outcomes into skill_outcomes
 * (source='self_play') and bumps style ELO.
 *
 * The salesperson side runs through `answerWithRag` with the same prompt
 * + skills + KB that production uses, so the simulation tests the
 * actual prompt — not a stub. The candidate side runs a lighter
 * persona-prompt loop (no KB, no skills).
 */
import type { Database } from "bun:sqlite";

import type { KbRepo } from "../../db/repos/kb.ts";
import { SelfPlayMatchesRepo } from "../../db/repos/self-play-matches.ts";
import type { SkillOutcomesRepo, StyleRatingsRepo } from "../../db/repos/skill-outcomes.ts";
import type { SkillsRepo } from "../../db/repos/skills.ts";
import { answerWithRag, NO_CONTEXT_MARKER } from "../../rag/answer.ts";
import type { ChatClient, ChatMessage } from "../../rag/chat.ts";
import type { EmbeddingClient } from "../../rag/embed.ts";
import { gradeSkills } from "../../rag/grade-skills.ts";
import type { EloOutcome } from "../elo.ts";
import type { SkillForPrompt } from "../prompt.ts";
import { nextStage } from "../stage-router.ts";
import type { FunnelStage, Style } from "../types.ts";
import { type JudgeVerdict, judgeMatch } from "./judge.ts";
import type { CandidatePersona } from "./personas.ts";

export interface SelfPlayDeps {
  db: Database;
  kb: KbRepo;
  skills: SkillsRepo;
  outcomes: SkillOutcomesRepo;
  ratings: StyleRatingsRepo;
  /** Salesperson chat — same client production uses for the bot's replies. */
  salesChat: ChatClient;
  /** Candidate chat — a separate client (can be cheaper / faster model). */
  candidateChat: ChatClient;
  /** Judge chat — temperature is forced to 0 by the judge module. */
  judgeChat: ChatClient;
  /** Embedder for the salesperson's RAG retrieval. */
  embedder: EmbeddingClient;
  /** Active vacancies block (caller renders, we just inject). Empty = none. */
  vacanciesBlock?: string;
  /**
   * Run reflection on every salesperson reply (extra LLM call per turn).
   * Catches fabrications — the bot inventing dates / numbers / cities
   * not present in CONTEXT. Without this, a confident-sounding lie
   * counts as a "won" outcome in self-play. With it, the lie is replaced
   * with a stall and the candidate hears something honest.
   *
   * Default: ON for self-play (research mode — accuracy matters more
   * than throughput). Pass `false` for fast smoke runs.
   */
  reflect?: boolean;
  /** Polite stall used to replace ungrounded answers — keeps the match
   *  going so the judge can still call the outcome on a fair transcript. */
  stallReply?: string;
}

export interface SelfPlayMatchInput {
  style: Style;
  styleId: number;
  persona: CandidatePersona;
  /** Hard cap on dialog length. Most matches end in 6-12 turns naturally;
   *  20 is a safety net for endless loops. */
  maxTurns?: number;
}

export interface SelfPlayMatchResult {
  styleSlug: string;
  personaSlug: string;
  turns: number;
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>;
  /** Skills the salesperson is configured to expose (regardless of which it
   *  actually used per turn — we attribute to the FULL set since we don't
   *  have per-turn self-grading inside the orchestrator). */
  skillsAttributed: string[];
  verdict: JudgeVerdict;
  outcome: EloOutcome;
  /** Synthetic lead id we generated for skill_outcomes FK. Negative so it
   *  doesn't collide with real leads — see comment on the insert. */
  leadId: number;
  /** Number of salesperson replies that reflect rejected as ungrounded
   *  (i.e. fabrications). High count means the bot is making things up —
   *  prompt grounding needs tightening. */
  fabricationsCaught: number;
  /** Row id in `self_play_matches` after persistence, or null when the
   *  insert failed (logged but non-fatal). Pairwise mode reads this to
   *  link both solo runs into a `pairwise_matches` row. */
  matchId: number | null;
}

const DEFAULT_MAX_TURNS = 20;

/**
 * Build the candidate-LLM history shape from the running transcript.
 * The candidate sees its own past replies as `assistant` and the
 * salesperson's replies as `user` — that's the inverse of how
 * production sees them, but it lets the LLM write in-character.
 */
function buildCandidateHistory(
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>,
  systemPrompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of transcript) {
    messages.push({
      role: m.role === "candidate" ? "assistant" : "user",
      content: m.text,
    });
  }
  return messages;
}

/**
 * Build the salesperson-side ChatMessage history for `answerWithRag`.
 * Production sees candidate as `user` and bot as `assistant` — direct.
 */
function buildSalesHistory(
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>,
): ChatMessage[] {
  return transcript.map((m) => ({
    role: m.role === "candidate" ? "user" : "assistant",
    content: m.text,
  }));
}

/**
 * Detect "the candidate clearly closed the loop" — short-circuits the
 * turn loop early, saves judge LLM tokens. Pattern matches Russian
 * yes/no-style commitments.
 */
/** Exposed for tests so the regex can be exercised without spinning up a full match. */
export const _testCandidateConcluded = (text: string): boolean => candidateConcluded(text);

function candidateConcluded(text: string): boolean {
  const t = text.toLowerCase();
  // Strong commit signals — explicit ask-to-proceed.
  if (/(давай[те]*\s+(оформ|анкет|поех|созв|попроб|начн|сдела))/i.test(t)) return true;
  if (/(я\s+согласн[аы]|я\s+готов[а]?\s+(оформ|поех|начать|подать))/i.test(t)) return true;
  // "ок" followed by an action verb. Plain "ок, а сколько…?" is just an
  // engaged follow-up question, not a conclusion — the bare `^ок` regex
  // used to incorrectly close those matches.
  if (/^ок\s*[!,.\s]*(давай|оформ|поех|анкет|готов|подаём|подаем|начн)/i.test(t)) return true;
  // Strong refusal signals.
  if (/(не\s+интересно|мне\s+(не\s+)?подход|передумал)/i.test(t)) return true;
  if (/(не\s+пишите|отстань|это\s+развод)/i.test(t)) return true;
  return false;
}

export async function runSelfPlayMatch(
  deps: SelfPlayDeps,
  input: SelfPlayMatchInput,
): Promise<SelfPlayMatchResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const transcript: SelfPlayMatchResult["transcript"] = [];

  // Resolve skills attached to this style (filtered to enabled ones).
  const skillRows = deps.skills.skillsForStyle(input.styleId).filter((r) => r.is_enabled === 1);
  const skills: SkillForPrompt[] = skillRows.map((r) => ({
    slug: r.slug,
    displayName: r.display_name,
    promptFragment: r.prompt_fragment,
    applicableStages: parseStages(r.applicable_stages_json),
  }));

  // Candidate kicks the conversation off with their canned opener.
  transcript.push({ role: "candidate", text: input.persona.opener });

  let stage: FunnelStage | null = null;
  let userMessageCount = 1;
  // Slugs the LLM actually demonstrated across the match, accumulated
  // via per-turn grade-skills calls. Used at finalize for fine-grained
  // attribution — only the skills the bot really performed get the
  // outcome, not the full attached bundle.
  const usedSkills = new Set<string>();
  let fabricationsCaught = 0;
  // Consecutive stall counter — same anti-deadloop logic as webhook.ts.
  const STALL_LIMIT = 3;
  let consecutiveStalls = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Salesperson's response — full RAG pipeline. We don't pass a
    // user/conversation persisted in DB; this is ephemeral simulation.
    const lastCandidate = transcript[transcript.length - 1]!;
    if (lastCandidate.role !== "candidate") break;

    stage = nextStage({
      turnNumber: userMessageCount,
      currentStage: stage,
      lastUserMessage: lastCandidate.text,
    });

    // History excludes the just-sent candidate message — answerWithRag
    // takes that as its `question`.
    const history = buildSalesHistory(transcript.slice(0, -1));

    const reflect = deps.reflect !== false; // default ON for self-play
    const salesResult = await answerWithRag({
      question: lastCandidate.text,
      kb: deps.kb,
      embedder: deps.embedder,
      chat: deps.salesChat,
      history,
      style: input.style,
      stage,
      includeFewShot: turn === 0,
      ...(deps.vacanciesBlock ? { vacanciesBlock: deps.vacanciesBlock } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(reflect ? { reflect: true } : {}),
    });

    // answerWithRag returns NO_CONTEXT in two cases — distinguish via
    // the telemetry path so we count "fabrications" only when reflect
    // was the cause:
    //   - "ungrounded" → reflect rejected the answer as fabricated
    //   - "no_context" → retrieval found nothing (no KB hit, no vacancies)
    // Both paths get the same stall fallback so the match keeps going,
    // but only the first bumps the fabrication counter.
    let salesText = salesResult.text;
    if (salesText === NO_CONTEXT_MARKER) {
      if (salesResult.telemetry.path === "ungrounded") {
        fabricationsCaught++;
      }
      consecutiveStalls++;
      if (consecutiveStalls >= STALL_LIMIT) {
        // CTA-fallback instead of yet another stall — mirrors webhook.ts logic.
        consecutiveStalls = 0;
        salesText =
          input.style.voice.stallCtaReply ??
          "Давай созвонимся — так быстрее всё объясню. В какое время удобно? 😊";
      } else {
        salesText = deps.stallReply ?? "Секунду, уточню детали и напишу — пара минут.";
      }
    } else {
      consecutiveStalls = 0;
    }
    transcript.push({ role: "salesperson", text: salesText });

    // Per-turn self-grading: ask the judge-class LLM which of the configured
    // skills the bot ACTUALLY used in this reply. Without this, attribution
    // bundles the whole skill set onto every outcome and per-skill win-rate
    // can't differentiate. We use the SAME chat client as the judge (already
    // running at temperature 0) — adds one short LLM call per turn but only
    // when skills are attached.
    // Don't grade skills on a stall reply — there's nothing meaningful
    // for the LLM to extract from "секунду, уточню". Skip when reflect
    // dropped the original.
    const defaultStall = deps.stallReply ?? "Секунду, уточню детали и напишу — пара минут.";
    if (skills.length > 0 && salesText !== defaultStall) {
      try {
        const used = await gradeSkills({
          question: lastCandidate.text,
          reply: salesText,
          availableSlugs: skills.map((s) => s.slug),
          chat: deps.judgeChat,
        });
        for (const slug of used) usedSkills.add(slug);
      } catch (err) {
        console.warn("[self-play] per-turn skill grading failed:", err);
      }
    }

    // Candidate's reply — separate LLM, persona-driven.
    const candidateMessages = buildCandidateHistory(transcript, input.persona.systemPrompt);
    let candidateText: string;
    try {
      candidateText = await deps.candidateChat.complete(candidateMessages, {
        temperature: 0.85,
        numPredict: 120,
      });
    } catch (err) {
      // Bail with a draw on candidate-LLM failure — better than crashing
      // halfway through a batch run.
      const verdict: JudgeVerdict = {
        outcome: "draw",
        reason: `candidate LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      return finalize(deps, input, transcript, skills, verdict, usedSkills, fabricationsCaught);
    }
    candidateText = candidateText.trim();
    if (!candidateText) {
      // Empty reply == candidate ghosted. Treat as lost.
      const verdict: JudgeVerdict = {
        outcome: "lost",
        reason: "candidate produced empty reply (ghosted)",
      };
      return finalize(deps, input, transcript, skills, verdict, usedSkills, fabricationsCaught);
    }
    transcript.push({ role: "candidate", text: candidateText });
    userMessageCount++;

    if (candidateConcluded(candidateText)) {
      break; // judge will read the final state
    }
  }

  const verdict = await judgeMatch({
    styleSlug: input.style.slug,
    personaSlug: input.persona.slug,
    judgingHint: input.persona.judgingHint,
    transcript,
    chat: deps.judgeChat,
  });
  return finalize(deps, input, transcript, skills, verdict, usedSkills, fabricationsCaught);
}

function finalize(
  deps: SelfPlayDeps,
  input: SelfPlayMatchInput,
  transcript: SelfPlayMatchResult["transcript"],
  skills: SkillForPrompt[],
  verdict: JudgeVerdict,
  usedSkills: Set<string>,
  fabricationsCaught: number,
): SelfPlayMatchResult {
  // Attribute outcomes to skills that the LLM actually USED (per-turn
  // self-grading union). Falls back to the full attached set when the
  // grader produced zero matches — typically because the grader LLM
  // failed or the bot didn't visibly demonstrate any skill, in which
  // case bundle-level attribution is the conservative default.
  const attributedSkills =
    usedSkills.size > 0 ? skills.filter((s) => usedSkills.has(s.slug)) : skills;
  let leadId = -1;
  if (input.style && attributedSkills.length > 0) {
    leadId = persistSelfPlayOutcome(deps, input, attributedSkills, verdict);
  }
  const result: SelfPlayMatchResult = {
    styleSlug: input.style.slug,
    personaSlug: input.persona.slug,
    turns: Math.ceil(transcript.length / 2),
    transcript,
    skillsAttributed: attributedSkills.map((s) => s.slug),
    verdict,
    outcome: verdict.outcome,
    leadId,
    fabricationsCaught,
    matchId: null,
  };
  // Save the full transcript for operator review on /admin/self-play.
  result.matchId = persistSelfPlayMatch(deps, result, verdict.reason);
  return result;
}

/**
 * Inserts a synthetic lead row + outcome rows + bumps style ELO. The
 * synthetic lead is needed because skill_outcomes has a FK to leads(id).
 * Rows are clearly tagged by the persona slug encoded in conversation
 * style_id metadata so they can be filtered out of business reports.
 */
function persistSelfPlayOutcome(
  deps: SelfPlayDeps,
  input: SelfPlayMatchInput,
  skills: SkillForPrompt[],
  verdict: JudgeVerdict,
): number {
  // Make a throwaway user + conversation + lead so FKs hold. Negative
  // tg_user_id keeps these rows distinguishable from real candidates.
  const tgUserId = -Math.floor(1e9 + Math.random() * 9e9);
  const u = deps.db
    .query<{ id: number }, [number]>(
      `INSERT INTO users (tg_user_id, status) VALUES (?, 'lost') RETURNING id`,
    )
    .get(tgUserId)!;
  const c = deps.db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO conversations (user_id, style_id) VALUES (?, ?) RETURNING id`,
    )
    .get(u.id, input.styleId)!;
  const lead = deps.db
    .query<{ id: number }, [number]>(`INSERT INTO leads (user_id) VALUES (?) RETURNING id`)
    .get(u.id)!;

  for (const s of skills) {
    deps.outcomes.record({
      leadId: lead.id,
      conversationId: c.id,
      messageId: null,
      styleSlug: input.style.slug,
      skillSlug: s.slug,
      outcome: verdict.outcome,
      source: "self_play",
    });
  }
  deps.ratings.applyOutcome(input.style.slug, verdict.outcome);
  return lead.id;
}

/** Persist the full match transcript so operators can review it on
 *  /admin/self-play. Called from `finalize` AFTER skill-outcome rows
 *  exist so `lead_id` is real. Failure-soft: any error logs and skips
 *  — losing a transcript is annoying but shouldn't kill the batch. */
export function persistSelfPlayMatch(
  deps: SelfPlayDeps,
  result: SelfPlayMatchResult,
  judgeReason: string,
): number | null {
  try {
    const row = new SelfPlayMatchesRepo(deps.db).insert({
      styleSlug: result.styleSlug,
      personaSlug: result.personaSlug,
      outcome: result.outcome,
      judgeReason,
      transcript: result.transcript,
      turns: result.turns,
      skills: result.skillsAttributed,
      leadId: result.leadId > 0 ? result.leadId : null,
      fabricationsCaught: result.fabricationsCaught,
    });
    return row.id;
  } catch (err) {
    console.warn("[self-play] failed to persist match transcript:", err);
    return null;
  }
}

function parseStages(raw: string): readonly FunnelStage[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is FunnelStage =>
      ["opener", "qualify", "pitch", "objection", "close"].includes(s),
    );
  } catch {
    return [];
  }
}
