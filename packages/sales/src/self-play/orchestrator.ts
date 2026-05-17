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
import {
  answerWithRag,
  type ChatClient,
  type ChatMessage,
  type EmbeddingClient,
  gradeSkills,
  type IKbStore,
  NO_CONTEXT_MARKER,
} from "@chatman-media/rag";
import type { EloOutcome } from "../elo.ts";
import { eloUpdate } from "../elo.ts";
import type { SkillForPrompt } from "../prompt.ts";
import { nextStage } from "../stage-router.ts";
import type {
  IConversationsRepo,
  ILeadsRepo,
  ISelfPlayMatchesRepo,
  ISkillOutcomesRepo,
  ISkillsRepo,
  IStyleRatingsRepo,
  IUsersRepo,
} from "../store.ts";
import type { FunnelStage, Style } from "../types.ts";
import { type JudgeVerdict, judgeMatch } from "./judge.ts";
import type { CandidatePersona } from "./personas.ts";

export interface SelfPlayDeps {
  users: IUsersRepo;
  conversations: IConversationsRepo;
  leads: ILeadsRepo;
  kb: IKbStore;
  skills: ISkillsRepo;
  outcomes: ISkillOutcomesRepo;
  ratings: IStyleRatingsRepo;
  matches: ISelfPlayMatchesRepo;
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
  skillsAttributed: string[];
  verdict: JudgeVerdict;
  outcome: EloOutcome;
  /** Synthetic lead id generated for skill_outcomes FK. */
  leadId: number;
  /** Number of salesperson replies rejected by reflect as fabrications. */
  fabricationsCaught: number;
  /** Row id in self_play_matches, or null when the insert failed. */
  matchId: number | null;
  /**
   * Whether the match transcript was durably persisted. `false` means the
   * insert threw and this result exists only in memory — callers running
   * evaluation loops should treat the run as not recorded.
   */
  persisted: boolean;
  /** Non-fatal errors collected during the match (e.g. skill grading failures). */
  warnings: string[];
}

const DEFAULT_MAX_TURNS = 20;

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

function buildSalesHistory(
  transcript: Array<{ role: "candidate" | "salesperson"; text: string }>,
): ChatMessage[] {
  return transcript.map((m) => ({
    role: m.role === "candidate" ? "user" : "assistant",
    content: m.text,
  }));
}

/** Exported for tests so the regex can be exercised without a full match. */
export const _testCandidateConcluded = (text: string): boolean =>
  candidateConcluded(text);

function candidateConcluded(text: string): boolean {
  const t = text.toLowerCase();
  if (/(давай[те]*\s+(оформ|анкет|поех|созв|попроб|начн|сдела))/i.test(t))
    return true;
  if (/(я\s+согласн[аы]|я\s+готов[а]?\s+(оформ|поех|начать|подать))/i.test(t))
    return true;
  if (
    /^ок\s*[!,.\s]*(давай|оформ|поех|анкет|готов|подаём|подаем|начн)/i.test(t)
  )
    return true;
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

  const skillRows = (await deps.skills.skillsForStyle(input.styleId)).filter(
    (r) => r.is_enabled,
  );
  const skills: SkillForPrompt[] = skillRows.map((r) => ({
    slug: r.slug,
    displayName: r.display_name,
    promptFragment: r.prompt_fragment,
    applicableStages: r.applicable_stages as FunnelStage[],
  }));

  transcript.push({ role: "candidate", text: input.persona.opener });

  let stage: FunnelStage | null = null;
  let userMessageCount = 1;
  const usedSkills = new Set<string>();
  let fabricationsCaught = 0;
  const warnings: string[] = [];
  const STALL_LIMIT = 3;
  let consecutiveStalls = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const lastCandidate = transcript[transcript.length - 1];
    if (!lastCandidate || lastCandidate.role !== "candidate") break;

    stage = nextStage({
      turnNumber: userMessageCount,
      currentStage: stage,
      lastUserMessage: lastCandidate.text,
    });

    const history = buildSalesHistory(transcript.slice(0, -1));
    const reflect = deps.reflect !== false;

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

    let salesText = salesResult.text;
    if (salesText === NO_CONTEXT_MARKER) {
      if (salesResult.telemetry.path === "ungrounded") {
        fabricationsCaught++;
      }
      consecutiveStalls++;
      if (consecutiveStalls >= STALL_LIMIT) {
        consecutiveStalls = 0;
        salesText =
          input.style.voice.stallCtaReply ??
          "Давай созвонимся — так быстрее всё объясню. В какое время удобно? 😊";
      } else {
        salesText =
          deps.stallReply ?? "Секунду, уточню детали и напишу — пара минут.";
      }
    } else {
      consecutiveStalls = 0;
    }
    transcript.push({ role: "salesperson", text: salesText });

    const defaultStall =
      deps.stallReply ?? "Секунду, уточню детали и напишу — пара минут.";
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
        warnings.push(
          `turn ${turn + 1} skill grading: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const candidateMessages = buildCandidateHistory(
      transcript,
      input.persona.systemPrompt,
    );
    let candidateText: string;
    try {
      candidateText = await deps.candidateChat.complete(candidateMessages, {
        temperature: 0.85,
        numPredict: 120,
      });
    } catch (err) {
      const verdict: JudgeVerdict = {
        outcome: "draw",
        reason: `candidate LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      return finalize(
        deps,
        input,
        transcript,
        skills,
        verdict,
        usedSkills,
        fabricationsCaught,
        warnings,
      );
    }
    candidateText = candidateText.trim();
    if (!candidateText) {
      const verdict: JudgeVerdict = {
        outcome: "lost",
        reason: "candidate produced empty reply (ghosted)",
      };
      return finalize(
        deps,
        input,
        transcript,
        skills,
        verdict,
        usedSkills,
        fabricationsCaught,
        warnings,
      );
    }
    transcript.push({ role: "candidate", text: candidateText });
    userMessageCount++;

    if (candidateConcluded(candidateText)) break;
  }

  const verdict = await judgeMatch({
    styleSlug: input.style.slug,
    personaSlug: input.persona.slug,
    judgingHint: input.persona.judgingHint,
    transcript,
    chat: deps.judgeChat,
  });
  return finalize(
    deps,
    input,
    transcript,
    skills,
    verdict,
    usedSkills,
    fabricationsCaught,
    warnings,
  );
}

async function finalize(
  deps: SelfPlayDeps,
  input: SelfPlayMatchInput,
  transcript: SelfPlayMatchResult["transcript"],
  skills: SkillForPrompt[],
  verdict: JudgeVerdict,
  usedSkills: Set<string>,
  fabricationsCaught: number,
  warnings: string[] = [],
): Promise<SelfPlayMatchResult> {
  const attributedSkills =
    usedSkills.size > 0 ? skills.filter((s) => usedSkills.has(s.slug)) : skills;
  let leadId = -1;
  if (attributedSkills.length > 0) {
    leadId = await persistSelfPlayOutcome(
      deps,
      input,
      attributedSkills,
      verdict,
    );
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
    persisted: false,
    warnings,
  };
  result.matchId = await persistSelfPlayMatch(deps, result, verdict.reason);
  result.persisted = result.matchId !== null;
  return result;
}

async function persistSelfPlayOutcome(
  deps: SelfPlayDeps,
  input: SelfPlayMatchInput,
  skills: SkillForPrompt[],
  verdict: JudgeVerdict,
): Promise<number> {
  const tgId = -Math.floor(1e9 + Math.random() * 9e9);
  const user = await deps.users.upsert({ telegramId: tgId });
  const conv = await deps.conversations.create({
    userId: user.id,
    styleSlug: input.style.slug,
  });
  const lead = await deps.leads.create({ conversationId: conv.id });

  for (const s of skills) {
    await deps.outcomes.record({
      skillSlug: s.slug,
      styleSlug: input.style.slug,
      leadId: lead.id,
      outcome: verdict.outcome,
      source: "self_play",
    });
  }

  const current = await deps.ratings.getRating(input.styleId);
  await deps.ratings.setRating(
    input.styleId,
    eloUpdate(current, verdict.outcome),
  );

  return lead.id;
}

export async function persistSelfPlayMatch(
  deps: Pick<SelfPlayDeps, "matches">,
  result: SelfPlayMatchResult,
  judgeReason: string,
): Promise<number | null> {
  try {
    return await deps.matches.insert({
      style_slug: result.styleSlug,
      persona_slug: result.personaSlug,
      outcome: result.outcome,
      skills: result.skillsAttributed,
      judge_reason: judgeReason,
      transcript: result.transcript,
    });
  } catch (err) {
    console.warn("[self-play] failed to persist match transcript:", err);
    return null;
  }
}
