import type { KbRepo, KbSearchHit } from "../db/repos/kb.ts";
import type { SkillForPrompt } from "../sales/prompt.ts";
import type { FunnelStage, Style } from "../sales/types.ts";
import type { ChatClient, ChatMessage } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";

/** Sentinel returned when retrieval is empty (or LLM cannot answer from
 * CONTEXT alone). The webhook layer turns this into a polite stall
 * reply ("секунду, уточню…") and queues the chat for the admin. */
export const NO_CONTEXT_MARKER = "__NO_CONTEXT__";

export interface Persona {
  /** Display name used in chat ("Алина", "Менеджер ALINA", etc.). */
  name: string;
  /** "human" → poses as a real person; "assistant" → openly an AI helper. */
  role: "human" | "assistant";
  /** Optional company / agency name. */
  company?: string;
  /**
   * Fixed personal facts about the persona — bypasses RAG for direct personal
   * questions and injects into the system prompt as inviolable grounding.
   * Known keys: "city" (city name), "age" (plain number or "26 лет"),
   * "status" (full natural reply for relationship/marital questions),
   * "experience" (full natural reply for "how long working" questions).
   * Values for "city" and "age" are auto-wrapped into sentences; values for
   * "status" and "experience" are returned verbatim as the bot reply.
   */
  facts?: Record<string, string>;
}

export interface AnswerInput {
  question: string;
  kb: KbRepo;
  embedder: EmbeddingClient;
  chat: ChatClient;
  /** Recent dialog messages (oldest first), excluding the current question. */
  history?: ChatMessage[];
  topK?: number;
  /** Used to drop noisy hits; pgvector returns cosine distance (lower=closer). */
  maxDistance?: number;
  /** Persona settings (see buildSystemPrompt). Optional — defaults to a
   *  generic AI-assistant persona for backward compatibility with tests.
   *  Mutually exclusive with `style`: when both are present, `style` wins. */
  persona?: Persona;
  /**
   * Sales style — when provided, the system prompt is composed via the sales
   * engine (`composeSystemPrompt`) instead of the legacy `buildSystemPrompt`.
   * `persona` is then ignored. See `src/sales/types.ts` for the schema and
   * `docs/SALES_STYLES.md` for the integration plan.
   */
  style?: Style;
  /**
   * Current funnel stage. Required when `style` is set; ignored otherwise.
   * Drives stage-specific guidance (opener vs pitch vs objection etc.) inside
   * the composed system prompt.
   */
  stage?: FunnelStage;
  /**
   * Whether to include the style's few-shot examples in the system prompt.
   * Default `true` (first turn). Pass `false` on follow-ups to save 200-500
   * tokens once the style anchor is already in chat history.
   */
  includeFewShot?: boolean;
  /** Optional output-token cap. When unset, the underlying ChatClient picks
   *  its own default (256 for Ollama). Useful for tests / playground to
   *  bound output time on slow CPU. */
  numPredict?: number;
  /**
   * Cross-session memory facts about the CANDIDATE (city, age, intent, …).
   * Survive conversation deletion (stored in users.profile_json.memory).
   * Injected into the system prompt as a "ЗНАЕМ О КАНДИДАТЕ" block so the
   * LLM doesn't re-ask things the candidate already told us in past sessions.
   */
  userFacts?: Record<string, string>;
  /**
   * When true, the question is passed through `rewriteQuery` before vector
   * retrieval. Resolves pronouns/elliptical follow-ups using `history`.
   * Adds one LLM call BEFORE retrieval (only when the heuristic flags the
   * question as ambiguous — typically ~20-30% of turns).
   */
  rewriteQueryBeforeRetrieval?: boolean;
  /**
   * When true, the generated answer is passed through `verifyAnswer` to
   * confirm every concrete fact it cites is present in the retrieved
   * context. Ungrounded answers are converted to NO_CONTEXT_MARKER (the
   * webhook then stays silent rather than send a hallucinated reply).
   * Adds one LLM call AFTER generation, only on turns that actually used
   * KB context (skipped for smalltalk/persona-fact short-circuits).
   */
  reflect?: boolean;
  /**
   * Hybrid retrieval: combine vector search and BM25 keyword search via
   * Reciprocal Rank Fusion. Catches exact-match queries (numbers, proper
   * nouns) that pure embedding search ranks poorly. No extra LLM calls —
   * just a second SQL query to the FTS5 index. When `maxDistance` is set
   * alongside this flag, it's IGNORED (fused ranks aren't on the L2 scale).
   */
  hybridSearch?: boolean;
  /**
   * Compressed summary of older turns (before the recent-history window).
   * Injected into the system prompt as "ИЗ РАННЕЙ ПЕРЕПИСКИ:" so the LLM
   * has continuity beyond the last 12 raw messages. Generated lazily by
   * the webhook (see runConversationSummaryRefresh) — caller just passes
   * whatever is currently stored.
   */
  conversationSummary?: string;
  /**
   * Topic-routed retrieval: when true and `classifyTopic(question)` returns
   * a deterministic match, only KB docs tagged with that topic (or untagged)
   * are searched. Falls back to global search when classifier returns null
   * OR the topic-filtered search yields zero hits — never reduces recall,
   * only sharpens precision when the classifier is confident.
   * Free at query time (regex classifier, no LLM).
   */
  topicRouting?: boolean;
  /**
   * Pre-rendered "АКТУАЛЬНЫЕ ВАКАНСИИ" block from admin-managed vacancies
   * (see VacanciesRepo + renderVacanciesBlock). Prepended to the KB context
   * so the bot answers from the freshest operator-curated info; KB hits
   * still appear below as background. Empty string = no active vacancies,
   * skip the heading.
   *
   * Important side effect: when set AND non-empty, retrieval may return
   * 0 KB hits and we still produce an answer (vacancies alone are enough
   * grounding). NO_CONTEXT_MARKER only fires when BOTH are empty.
   */
  vacanciesBlock?: string;
  /**
   * When false, disables vacancy-accuracy checking inside fact-checker even
   * when vacanciesBlock is set. Useful for self-play dry-run where you want
   * to see what the bot *would* say without the guard blocking it.
   * Default: true (guard runs whenever vacanciesBlock is non-empty).
   */
  vacancyGuard?: boolean;
  /**
   * Persuasion skills attached to the active style. Loaded from the DB
   * (SkillsRepo.skillsForStyle) by the webhook and threaded through to
   * `composeSystemPrompt`. Filtered by current stage at compose time.
   */
  skills?: readonly SkillForPrompt[];
  /**
   * Books-priority retrieval: when true, searches the "books" topic first
   * (management / manipulation library). Falls back to global KB when the
   * books slice is empty. Pairs with `hybridSearch` — uses hybrid when both
   * flags are set, vector-only otherwise.
   */
  booksPriority?: boolean;
}

/**
 * Per-turn telemetry — captured for every `answerWithRag` call so the webhook
 * can persist it into `messages.meta_json` and admins can diagnose quality
 * regressions ("when did groundedness drop?", "is hybrid retrieval helping?")
 * without re-running the LLM. Fields are optional because not every turn
 * exercises every layer (smalltalk skips embed/retrieve, NO_CONTEXT skips
 * generation, reflection only fires on grounded turns).
 */
export interface AnswerTelemetry {
  /** "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok" */
  path: "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok";
  /** Number of milliseconds from `answerWithRag` entry to return. */
  total_ms?: number;
  /** Number of milliseconds spent in retrieval (embed + kb.search). */
  retrieval_ms?: number;
  /** Number of milliseconds spent in the main generator chat call. */
  generation_ms?: number;
  /** L2 distances (or fused ranks) of the top-k hits, in order. */
  top_distances?: number[];
  /** True when hybrid (BM25 + vector) was used instead of vector-only. */
  hybrid?: boolean;
  /** Topic the question was routed to ("visa", "payment", …) or null when
   *  classifier was inconclusive or topic filter fell back to global. */
  topic?: string | null;
  /** Original user question, when query was rewritten before retrieval. */
  original_query?: string;
  /** Rewritten search query, when different from `original_query`. */
  rewritten_query?: string;
  /** Fact-checker verdict (KB grounding + vacancy accuracy), when ran. */
  factCheck?: { grounded: boolean; vacancyOk: boolean; reason?: string };
}

export interface AnswerResult {
  text: string;
  usedChunkIds: number[];
  hits: KbSearchHit[];
  telemetry: AnswerTelemetry;
}
