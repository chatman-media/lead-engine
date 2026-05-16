import type { KbSearchHit } from "../db/repos/kb.ts";
import { composeSystemPrompt } from "../sales/prompt.ts";
import type { FunnelStage } from "../sales/types.ts";
import {
  type AnswerInput,
  type AnswerResult,
  type AnswerTelemetry,
  NO_CONTEXT_MARKER,
  type Persona,
} from "./answer-types.ts";
import type { ChatMessage } from "./chat.ts";
import { checkFacts } from "./fact-checker.ts";
import {
  botPresenceReply,
  isBotPresenceQuestion,
  isPersonalFactQuestion,
  isPersonaSmalltalkQuestion,
  personaFactReply,
  personaSmalltalkReply,
} from "./persona-shortcuts.ts";
import { rewriteQuery } from "./rewrite-query.ts";
import { sanitizeLlmOutput } from "./sanitize.ts";
import {
  buildSystemPrompt,
  DEFAULT_PERSONA,
  legacyRagSamplingTemperature,
} from "./system-prompt.ts";
import { applyStyleRules } from "./text-style-rules.ts";
import { classifyTopic } from "./topic-classifier.ts";

// Re-exports kept on this module's path for backward compatibility with
// existing importers (tests, webhook, admin/api, scripts, sales/prompt).
export {
  type AnswerInput,
  type AnswerResult,
  type AnswerTelemetry,
  NO_CONTEXT_MARKER,
  type Persona,
} from "./answer-types.ts";
export {
  botPresenceReply,
  isBotPresenceQuestion,
  isPersonalFactQuestion,
  isPersonaSmalltalkQuestion,
  personaFactReply,
  personaSmalltalkReply,
} from "./persona-shortcuts.ts";
export { sanitizeLlmOutput } from "./sanitize.ts";
export {
  buildSystemPrompt,
  legacyRagSamplingTemperature,
  renderSummaryBlock,
  renderUserFactsBlock,
} from "./system-prompt.ts";

/** Shared: build a reply from pre-fetched hits. Called by both the
 *  books-priority path and the normal retrieval path to avoid duplication. */
async function answerFromHits(opts: {
  hits: KbSearchHit[];
  baseTelemetry: AnswerTelemetry;
  startedAt: number;
  input: AnswerInput;
  activePersona: Persona;
}): Promise<AnswerResult> {
  const { hits, baseTelemetry, startedAt, input, activePersona } = opts;
  const vacBlock = (input.vacanciesBlock ?? "").trim();

  // With a sales style, proceed even with no KB hits — the style's system
  // prompt (opener scripts, NEPQ scripting) is enough for conversational
  // turns. Only return NO_CONTEXT when there's truly no style and no KB.
  if (hits.length === 0 && !vacBlock && !input.style) {
    return {
      text: NO_CONTEXT_MARKER,
      usedChunkIds: [],
      hits: [],
      telemetry: { ...baseTelemetry, path: "no_context", total_ms: Date.now() - startedAt },
    };
  }

  const kbContextStr = hits
    .map((h, i) => `[#${i + 1}] (source: ${h.title})\n${h.text}`)
    .join("\n\n");

  const context = vacBlock
    ? kbContextStr
      ? `${vacBlock}\n\n${kbContextStr}`
      : vacBlock
    : kbContextStr;

  // When a style is set but there's no KB content and no vacancies, the LLM
  // sees no grounding section at all and may hallucinate vacancy details from
  // few-shot examples. Pass an explicit "no data" block so the forbid rules
  // in the style fire correctly.
  const contextForPrompt =
    input.style && !context
      ? "АКТУАЛЬНЫЕ ВАКАНСИИ: нет данных. Конкретных вакансий, зарплат и городов сейчас нет в базе — не называй никаких цифр и мест."
      : context;

  let systemPrompt: string;
  let temperature = legacyRagSamplingTemperature(activePersona);
  if (input.style) {
    const stage: FunnelStage = input.stage ?? "qualify";
    systemPrompt = composeSystemPrompt(input.style, stage, contextForPrompt, {
      includeFewShot: input.includeFewShot ?? true,
      ...(input.userFacts ? { userFacts: input.userFacts } : {}),
      ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
      ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
    });
    temperature = input.style.model.temperature;
  } else {
    systemPrompt = buildSystemPrompt(
      input.persona ?? DEFAULT_PERSONA,
      context,
      input.userFacts,
      input.conversationSummary,
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(input.history ?? []),
    { role: "user", content: input.question },
  ];

  console.log(`[rag] calling LLM (hits=${hits.length} vacBlock=${vacBlock.length > 0})`);
  const generationStart = Date.now();
  // Resolve numPredict (output token cap) in priority order:
  //   1. Explicit input.numPredict (tests / playground override)
  //   2. style.model.maxTokens (per-style author cap — was previously dead;
  //      bot's reply was truncated mid-sentence on multi-vacancy listings
  //      because Ollama's default 256 kicked in instead of the schema value)
  //   3. Ollama provider default (256)
  const numPredict = input.numPredict ?? input.style?.model.maxTokens;
  const raw = await input.chat.complete(messages, {
    temperature,
    ...(numPredict !== undefined ? { numPredict } : {}),
  });
  const text = sanitizeLlmOutput(raw);
  const generationMs = Date.now() - generationStart;

  const telemetry: AnswerTelemetry = { ...baseTelemetry, generation_ms: generationMs };

  // Unified fact-checker: single LLM call replaces the old reflect + vacancy-guard
  // two-call pipeline. Checks KB grounding AND vacancy accuracy together.
  // Only runs when reflect=true OR vacanciesBlock is set (same trigger conditions
  // as the old separate layers).
  const runVacancyCheck = vacBlock.length > 0 && input.vacancyGuard !== false;

  // The grounding half verifies every claim is backed by KB CONTEXT. At
  // data-collection stages (opener / qualify / close) the bot ASKS the
  // candidate for anketa fields — "скинь возраст и фото" reads to the
  // checker as an unsupported claim, so the whole reply gets dropped and
  // the candidate sees nothing. Exempt those stages from the grounding
  // drop; vacancy accuracy is still always enforced. pitch/objection (and
  // an unknown stage) keep full grounding.
  const GROUNDING_EXEMPT_STAGES: ReadonlySet<string> = new Set(["opener", "qualify", "close"]);
  const groundingExempt = input.stage !== undefined && GROUNDING_EXEMPT_STAGES.has(input.stage);

  const runFactCheck =
    (input.reflect || runVacancyCheck) &&
    text !== NO_CONTEXT_MARKER &&
    text.trim().length > 0 &&
    // If grounding is exempt for this stage and there's no vacancy block,
    // there's nothing left to verify — skip the LLM call entirely.
    !(groundingExempt && !runVacancyCheck);

  if (runFactCheck) {
    const verdict = await checkFacts({
      question: input.question,
      answer: text,
      context,
      chat: input.chat,
      ...(runVacancyCheck ? { vacanciesBlock: vacBlock } : {}),
    });
    telemetry.factCheck = {
      grounded: verdict.grounded,
      vacancyOk: verdict.vacancyOk,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };

    if (!verdict.grounded && !groundingExempt) {
      console.warn(
        `[fact-checker] dropping ungrounded answer: ${verdict.reason ?? "unknown"} | answer="${text.slice(0, 120)}"`,
      );
      return {
        text: NO_CONTEXT_MARKER,
        usedChunkIds: hits.map((h) => h.chunk_id),
        hits,
        telemetry: { ...telemetry, path: "ungrounded", total_ms: Date.now() - startedAt },
      };
    }

    if (!verdict.vacancyOk) {
      console.warn(
        `[fact-checker] dropping answer with mismatched vacancy data: ${verdict.reason ?? "unknown"} | answer="${text.slice(0, 120)}"`,
      );
      return {
        text: NO_CONTEXT_MARKER,
        usedChunkIds: hits.map((h) => h.chunk_id),
        hits,
        telemetry: { ...telemetry, path: "ungrounded", total_ms: Date.now() - startedAt },
      };
    }
  }

  if (text === NO_CONTEXT_MARKER) {
    telemetry.path = "no_context";
  }

  return {
    text,
    usedChunkIds: hits.map((h) => h.chunk_id),
    hits,
    telemetry: { ...telemetry, total_ms: Date.now() - startedAt },
  };
}

export async function answerWithRag(input: AnswerInput): Promise<AnswerResult> {
  const startedAt = Date.now();
  const activePersona: Persona =
    input.style != null
      ? {
          name: input.style.persona.name,
          role: input.style.persona.role,
          ...(input.style.persona.company != null && input.style.persona.company.trim() !== ""
            ? { company: input.style.persona.company.trim() }
            : {}),
        }
      : (input.persona ?? DEFAULT_PERSONA);

  console.log(
    `[rag] answerWithRag style=${input.style?.slug ?? "none"} stage=${input.stage ?? "none"} q="${input.question.slice(0, 60)}"`,
  );

  if (isPersonaSmalltalkQuestion(input.question)) {
    // Apply text-style rules (em-dash → hyphen, ellipsis → ..., etc) even
    // on the shortcut path: env-configured persona names/companies could
    // smuggle in unicode chars that the LLM-output sanitizer would catch.
    return {
      text: applyStyleRules(personaSmalltalkReply(activePersona)),
      usedChunkIds: [],
      hits: [],
      telemetry: { path: "smalltalk", total_ms: Date.now() - startedAt },
    };
  }

  // Bot/human/AI question — answer must agree with persona.role and not
  // parrot the system-prompt example. Same telemetry path as smalltalk —
  // no KB, no LLM call.
  if (isBotPresenceQuestion(input.question)) {
    return {
      text: applyStyleRules(botPresenceReply(activePersona)),
      usedChunkIds: [],
      hits: [],
      telemetry: { path: "smalltalk", total_ms: Date.now() - startedAt },
    };
  }

  const factKey = isPersonalFactQuestion(input.question);
  if (factKey) {
    const factReply = personaFactReply(activePersona, factKey);
    if (factReply) {
      return {
        text: applyStyleRules(factReply),
        usedChunkIds: [],
        hits: [],
        telemetry: { path: "persona_fact", total_ms: Date.now() - startedAt },
      };
    }
    // Fact not configured → fall through to RAG
  }

  const topK = input.topK ?? 5;

  // Optional query rewriting: resolve "а там?", "это сколько?" type follow-ups
  // into self-contained search queries so vector retrieval lands the right
  // KB chunks. The rewrite is used ONLY for embedding/retrieval — the
  // original `input.question` is still what the LLM answers, so the user's
  // exact phrasing remains in the prompt and conversation history.
  const searchQuery = input.rewriteQueryBeforeRetrieval
    ? await rewriteQuery({
        question: input.question,
        ...(input.history ? { history: input.history } : {}),
        chat: input.chat,
      })
    : input.question;

  const retrievalStart = Date.now();
  const [questionVec] = await input.embedder.embed([searchQuery]);
  if (!questionVec) throw new Error("Embedder returned no vector for question");

  // Books-priority mode: search the "books" topic first, fall back to
  // global KB when the books slice is empty. When both booksPriority and
  // hybridSearch are set, the priority search uses hybrid on each pass.
  if (input.booksPriority) {
    const allHits = await input.kb.prioritySearch({
      embedding: questionVec,
      query: searchQuery,
      k: topK,
      vectorOnly: !input.hybridSearch,
    });
    const hits =
      input.hybridSearch || input.maxDistance === undefined
        ? allHits
        : allHits.filter((h) => h.distance <= input.maxDistance!);
    const retrievalMs = Date.now() - retrievalStart;
    const baseTelemetry: AnswerTelemetry = {
      path: "ok",
      retrieval_ms: retrievalMs,
      top_distances: hits.map((h) => Math.round(h.distance * 10000) / 10000),
      ...(input.hybridSearch ? { hybrid: true } : {}),
      ...(searchQuery !== input.question
        ? { original_query: input.question, rewritten_query: searchQuery }
        : {}),
    };
    return answerFromHits({ hits, baseTelemetry, startedAt, input, activePersona });
  }

  // Topic routing: classify the QUESTION (not the rewritten query — it
  // matches the cleaner regex anchors better). When the classifier is
  // confident AND the topic-filtered search yields hits, use those;
  // otherwise fall through to a global search. Never reduces recall.
  const topic = input.topicRouting ? classifyTopic(input.question) : null;

  // Hybrid retrieval (vector + BM25 + RRF) catches exact-match queries that
  // pure embedding search ranks poorly. When enabled, `maxDistance` is
  // skipped because the fused rank is on a different scale than L2 distance.
  const runSearch = (filterTopic: string | null) =>
    input.hybridSearch
      ? input.kb.hybridSearch({
          embedding: questionVec,
          query: searchQuery,
          k: topK,
          ...(filterTopic !== null ? { topic: filterTopic } : {}),
        })
      : input.kb.search(questionVec, topK, filterTopic);

  let allHits = await runSearch(topic);
  let usedTopic: string | null = topic;
  if (topic !== null && allHits.length === 0) {
    // Topic filter starved retrieval — fall back to global. The miss is
    // either: classifier wrongly identified topic, OR no docs are tagged
    // with that topic yet. Either way, we'd rather return SOMETHING.
    allHits = await runSearch(null);
    usedTopic = null;
  }
  const hits =
    input.hybridSearch || input.maxDistance === undefined
      ? allHits
      : allHits.filter((h) => h.distance <= input.maxDistance!);
  const retrievalMs = Date.now() - retrievalStart;

  // Telemetry common to every retrieval-based path. Distances are rounded to
  // 4 decimals to keep meta_json readable in admin dumps; precision past 4
  // decimals isn't useful for diagnosis.
  const baseTelemetry: AnswerTelemetry = {
    path: "ok",
    retrieval_ms: retrievalMs,
    top_distances: hits.map((h) => Math.round(h.distance * 10000) / 10000),
    ...(input.hybridSearch ? { hybrid: true } : {}),
    ...(input.topicRouting && topic !== null ? { topic: usedTopic } : {}),
    ...(searchQuery !== input.question
      ? { original_query: input.question, rewritten_query: searchQuery }
      : {}),
  };

  console.log(
    `[rag] retrieval hits=${hits.length} topic=${usedTopic ?? "global"} ms=${Date.now() - retrievalStart}`,
  );
  return answerFromHits({ hits, baseTelemetry, startedAt, input, activePersona });
}
