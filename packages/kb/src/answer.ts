import type { z } from "zod";
import {
  type AnswerInput,
  type AnswerResult,
  type AnswerTelemetry,
  NO_CONTEXT_MARKER,
  type Persona,
} from "./answer-types.ts";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { checkFacts } from "./fact-checker.ts";
import {
  botPresenceReply,
  isBotPresenceQuestion,
  isPersonalFactQuestion,
  isPersonaSmalltalkQuestion,
  personaFactReply,
  personaSmalltalkReply,
} from "./persona-shortcuts.ts";
import { composeSystemPrompt } from "./prompt.ts";
import { rewriteQuery } from "./rewrite-query.ts";
import { applyDynamicThreshold, mmrDiversify, rrfMerge } from "./retrieval-utils.ts";
import { expandQueries } from "./multi-query.ts";
import { sanitizeLlmOutput } from "./sanitize.ts";
import {
  injectJsonInstruction,
  parseStructuredOutput,
  zodToJsonSchema,
} from "./structured-output.ts";
import type { FunnelStage } from "./styles.ts";
import {
  buildSystemPrompt,
  DEFAULT_PERSONA,
  legacyRagSamplingTemperature,
} from "./system-prompt.ts";
import { applyStyleRules } from "./text-style-rules.ts";
import { buildToolTelemetry, DEFAULT_MAX_TOOL_CYCLES, runToolLoop } from "./tool-loop.ts";
import type { AnyRagTool } from "./tools.ts";
import { classifyTopic } from "./topic-classifier.ts";
import type { KbSearchHit } from "./types.ts";

// Re-exports for backward compatibility with existing importers.
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

// ── Shared retrieval ─────────────────────────────────────────────────────────

export interface RetrievalResult {
  hits: KbSearchHit[];
  retrievalMs: number;
  searchQuery: string;
  queries: string[];
  /** null when topicRouting is off or booksPriority path was used. */
  usedTopic: string | null;
}

/**
 * Shared retrieval logic for both `answerWithRag` and `answerWithRagStream`.
 *
 * Steps:
 *  1. Optional query rewrite (LLM resolves pronouns/ellipsis via history).
 *  2. Optional multi-query expansion (LLM generates N variants).
 *  3. Embed all queries in one batch.
 *  4. booksPriority path OR normal path (multi-query → RRF | single → topic fallback).
 *  5. maxDistance filter → applyDynamicThreshold → mmrDiversify → reranker.
 *  6. Slice to topK.
 */
export async function retrieveHits(input: AnswerInput): Promise<RetrievalResult> {
  const topK = input.topK ?? 5;
  const candidateK = input.reranker ? topK * 3 : topK;

  const searchQuery = input.rewriteQueryBeforeRetrieval
    ? await rewriteQuery({
        question: input.question,
        ...(input.history ? { history: input.history } : {}),
        chat: input.chat,
      })
    : input.question;

  const queries = input.multiQuery
    ? await expandQueries({
        question: searchQuery,
        history: input.history,
        chat: input.chat,
        count: input.multiQueryCount ?? 2,
      })
    : [searchQuery];

  const retrievalStart = Date.now();
  const vecs = await input.embedder.embed(queries);
  const questionVec = vecs[0];
  if (!questionVec) throw new Error("Embedder returned no vector for question");

  let hits: KbSearchHit[];
  let usedTopic: string | null = null;

  if (input.booksPriority) {
    hits = await input.kb.prioritySearch({
      embedding: questionVec,
      query: searchQuery,
      k: candidateK,
      vectorOnly: !input.hybridSearch,
    });
  } else {
    const topic = input.topicRouting ? classifyTopic(input.question) : null;
    usedTopic = topic;

    if (queries.length > 1) {
      const hitLists = await Promise.all(
        queries.map((q, i) => {
          const vec = vecs[i] ?? questionVec;
          return input.hybridSearch
            ? input.kb.hybridSearch({
                embedding: vec,
                query: q,
                k: candidateK,
                ...(topic !== null ? { topic } : {}),
              })
            : input.kb.search(vec, candidateK, topic);
        }),
      );
      hits = rrfMerge(hitLists, { topN: candidateK });
    } else {
      const runSearch = (filterTopic: string | null) =>
        input.hybridSearch
          ? input.kb.hybridSearch({
              embedding: questionVec,
              query: searchQuery,
              k: candidateK,
              ...(filterTopic !== null ? { topic: filterTopic } : {}),
            })
          : input.kb.search(questionVec, candidateK, filterTopic);

      hits = await runSearch(topic);
      if (topic !== null && hits.length === 0) {
        hits = await runSearch(null);
        usedTopic = null;
      }
    }
  }

  const maxDist = input.maxDistance;
  if (!input.hybridSearch && maxDist !== undefined) {
    hits = hits.filter((h) => h.distance <= maxDist);
  }
  if (input.autoTrimDistance) {
    hits = applyDynamicThreshold(hits, { threshold: input.autoTrimThreshold });
  }
  if (input.mmr) {
    hits = mmrDiversify(hits, { lambda: input.mmrLambda, topK });
  }
  if (input.reranker && hits.length > 0) {
    hits = await input.reranker.rerank(searchQuery, hits, topK);
  }
  hits = hits.slice(0, topK);

  return {
    hits,
    retrievalMs: Date.now() - retrievalStart,
    searchQuery,
    queries,
    usedTopic,
  };
}

async function answerFromHits(opts: {
  hits: KbSearchHit[];
  baseTelemetry: AnswerTelemetry;
  startedAt: number;
  input: AnswerInput;
  activePersona: Persona;
}): Promise<AnswerResult> {
  const { hits, baseTelemetry, startedAt, input, activePersona } = opts;
  const vacBlock = (input.vacanciesBlock ?? "").trim();

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
      ...(input.directorHooks && input.directorHooks.length > 0
        ? { directorHooks: input.directorHooks }
        : {}),
      ...(input.supportPhase ? { supportPhase: input.supportPhase } : {}),
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
  const numPredict = input.numPredict ?? input.style?.model.maxTokens;
  const llmOpts = { temperature, ...(numPredict !== undefined ? { numPredict } : {}) };

  // ── Agentic tool-calling loop ────────────────────────────────────────────
  // Multi-cycle: LLM может вызвать tools → увидеть результаты → вызвать
  // снова, пока не достигнет финального ответа или maxToolCycles cap'а.
  // Single-cycle behavior получается при maxToolCycles=1. Если первый
  // cycle вернул content (no tools requested) — early-return как раньше.
  let toolCallTelemetry: AnswerTelemetry["toolCall"] | undefined;
  let multiCycleToolCalls: AnswerTelemetry["toolCalls"] | undefined;

  if (input.tools && input.tools.length > 0 && typeof input.chat.completeWithTools === "function") {
    const maxCycles = input.maxToolCycles ?? DEFAULT_MAX_TOOL_CYCLES;
    const loopResult = await runToolLoop({
      chat: input.chat,
      messages,
      tools: input.tools as AnyRagTool[],
      llmOpts,
      maxCycles,
    });
    const telemetryFields = buildToolTelemetry(loopResult.toolCalls);
    toolCallTelemetry = telemetryFields.toolCall;
    multiCycleToolCalls = telemetryFields.toolCalls;

    // Если loop сам вернул финальный текст (no tools requested на последнем
    // cycle) — отдаём как ok. Иначе messages mutated с tool-results и
    // pipeline продолжает к final-completion ниже.
    if (loopResult.content !== null && loopResult.toolCalls.length === 0) {
      // No tools were ever called — model сам ответил с первого cycle'а.
      const text = sanitizeLlmOutput(loopResult.content);
      const generationMs = Date.now() - generationStart;
      const telemetry: AnswerTelemetry = { ...baseTelemetry, generation_ms: generationMs };
      const result: AnswerResult = {
        text,
        usedChunkIds: hits.map((h) => h.chunk_id),
        hits,
        telemetry: { ...telemetry, path: "ok", total_ms: Date.now() - startedAt },
      };
      input.onTelemetry?.(result.telemetry);
      return result;
    }
    // loopResult.content !== null AND toolCalls.length > 0 means: tools
    // were called and model produced a final answer in last cycle. Pipeline
    // will skip the tools-then-no-final case below and fall through to
    // normal completion (which will re-run on the mutated messages).
  }

  // ── Structured output ────────────────────────────────────────────────────
  if (input.outputSchema) {
    const jsonSchema = zodToJsonSchema(input.outputSchema);
    let rawJson: string;

    if (typeof input.chat.completeStructured === "function") {
      rawJson = await input.chat.completeStructured(messages, jsonSchema, llmOpts);
    } else {
      messages[0] = {
        role: "system",
        content: injectJsonInstruction(messages[0]?.content ?? "", jsonSchema),
      };
      rawJson = await input.chat.complete(messages, { ...llmOpts, temperature: 0 });
    }

    const parsed = parseStructuredOutput(rawJson, input.outputSchema);
    const generationMs = Date.now() - generationStart;
    const telemetry: AnswerTelemetry = {
      ...baseTelemetry,
      generation_ms: generationMs,
      ...(toolCallTelemetry ? { toolCall: toolCallTelemetry } : {}),
    };
    const result: AnswerResult = {
      text: rawJson,
      output: parsed.success ? parsed.data : undefined,
      usedChunkIds: hits.map((h) => h.chunk_id),
      hits,
      telemetry: { ...telemetry, path: "ok", total_ms: Date.now() - startedAt },
    };
    if (!parsed.success) console.warn(`[structured-output] validation failed: ${parsed.error}`);
    input.onTelemetry?.(result.telemetry);
    return result;
  }

  const raw = await input.chat.complete(messages, llmOpts);
  const text = sanitizeLlmOutput(raw);
  const generationMs = Date.now() - generationStart;

  const telemetry: AnswerTelemetry = {
    ...baseTelemetry,
    generation_ms: generationMs,
    ...(toolCallTelemetry ? { toolCall: toolCallTelemetry } : {}),
  };

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

/**
 * Streaming variant of `answerWithRag`. Yields raw text tokens as they arrive
 * from the LLM. The final telemetry is delivered via `input.onTelemetry` (if
 * set). Falls back to `complete()` when the chat client has no `stream()`.
 *
 * Note: hallucination guard (`reflect`, `vacancyGuard`) is not applied during
 * streaming — fact-checking requires the full answer. Use `answerWithRag()` when
 * fact-checking is required.
 */
export async function* answerWithRagStream(input: AnswerInput): AsyncIterable<string> {
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

  // ── Persona shortcuts (no retrieval needed) ──────────────────────────────
  if (isPersonaSmalltalkQuestion(input.question)) {
    const text = applyStyleRules(personaSmalltalkReply(activePersona));
    yield text;
    input.onTelemetry?.({ path: "smalltalk", total_ms: Date.now() - startedAt });
    return;
  }
  if (isBotPresenceQuestion(input.question)) {
    const text = applyStyleRules(botPresenceReply(activePersona));
    yield text;
    input.onTelemetry?.({ path: "smalltalk", total_ms: Date.now() - startedAt });
    return;
  }
  const factKey = isPersonalFactQuestion(input.question);
  if (factKey) {
    const factReply = personaFactReply(activePersona, factKey);
    if (factReply) {
      yield applyStyleRules(factReply);
      input.onTelemetry?.({ path: "persona_fact", total_ms: Date.now() - startedAt });
      return;
    }
  }

  // ── Retrieval ────────────────────────────────────────────────────────────
  const topK = input.topK ?? 5;
  const { hits: retrievedHits, retrievalMs, searchQuery, queries } = await retrieveHits(input);
  let hits = retrievedHits;

  if (hits.length === 0 && !(input.vacanciesBlock ?? "").trim() && !input.style) {
    input.onTelemetry?.({
      path: "no_context",
      retrieval_ms: retrievalMs,
      total_ms: Date.now() - startedAt,
    });
    yield NO_CONTEXT_MARKER;
    return;
  }

  // ── Prompt composition ───────────────────────────────────────────────────
  const kbContextStr = hits
    .map((h, i) => `[#${i + 1}] (source: ${h.title})\n${h.text}`)
    .join("\n\n");
  const vacBlock = (input.vacanciesBlock ?? "").trim();
  const context = vacBlock
    ? kbContextStr
      ? `${vacBlock}\n\n${kbContextStr}`
      : vacBlock
    : kbContextStr;
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
      ...(input.directorHooks && input.directorHooks.length > 0
        ? { directorHooks: input.directorHooks }
        : {}),
      ...(input.supportPhase ? { supportPhase: input.supportPhase } : {}),
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

  const numPredict = input.numPredict ?? input.style?.model.maxTokens;
  const completionOpts = { temperature, ...(numPredict !== undefined ? { numPredict } : {}) };

  // ── Stream or fall back to complete() ───────────────────────────────────
  const generationStart = Date.now();
  if (typeof input.chat.stream === "function") {
    for await (const token of input.chat.stream(messages, completionOpts)) {
      yield token;
    }
  } else {
    const raw = await input.chat.complete(messages, completionOpts);
    yield sanitizeLlmOutput(raw);
  }

  const generationMs = Date.now() - generationStart;
  input.onTelemetry?.({
    path: "ok",
    retrieval_ms: retrievalMs,
    generation_ms: generationMs,
    top_distances: hits.map((h) => Math.round(h.distance * 10000) / 10000),
    ...(input.hybridSearch ? { hybrid: true } : {}),
    ...(searchQuery !== input.question
      ? { original_query: input.question, rewritten_query: searchQuery }
      : {}),
    total_ms: Date.now() - startedAt,
  });
}

export async function answerWithRag<T extends z.ZodTypeAny>(
  input: AnswerInput & { outputSchema: T },
): Promise<AnswerResult<z.infer<T>>>;
export async function answerWithRag(input: AnswerInput): Promise<AnswerResult>;
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
    const result: AnswerResult = {
      text: applyStyleRules(personaSmalltalkReply(activePersona)),
      usedChunkIds: [],
      hits: [],
      telemetry: { path: "smalltalk", total_ms: Date.now() - startedAt },
    };
    input.onTelemetry?.(result.telemetry);
    return result;
  }

  if (isBotPresenceQuestion(input.question)) {
    const result: AnswerResult = {
      text: applyStyleRules(botPresenceReply(activePersona)),
      usedChunkIds: [],
      hits: [],
      telemetry: { path: "smalltalk", total_ms: Date.now() - startedAt },
    };
    input.onTelemetry?.(result.telemetry);
    return result;
  }

  const factKey = isPersonalFactQuestion(input.question);
  if (factKey) {
    const factReply = personaFactReply(activePersona, factKey);
    if (factReply) {
      const result: AnswerResult = {
        text: applyStyleRules(factReply),
        usedChunkIds: [],
        hits: [],
        telemetry: { path: "persona_fact", total_ms: Date.now() - startedAt },
      };
      input.onTelemetry?.(result.telemetry);
      return result;
    }
  }

  const topK = input.topK ?? 5;
  // RAG-поиск не критичен: если эмбеддер/векторный поиск недоступен (напр.
  // 429 quota у провайдера эмбеддингов), не роняем весь ответ — отвечаем без
  // KB-контекста (на чате + инструментах). База знаний для бота опциональна.
  let retrieval: RetrievalResult;
  try {
    retrieval = await retrieveHits(input);
  } catch (err) {
    console.warn(
      `[rag] retrieval failed → отвечаем без базы знаний: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    retrieval = {
      hits: [],
      retrievalMs: 0,
      searchQuery: input.question,
      queries: [],
      usedTopic: null,
    };
  }
  const { hits, retrievalMs, searchQuery, queries, usedTopic } = retrieval;

  const baseTelemetry: AnswerTelemetry = {
    path: "ok",
    retrieval_ms: retrievalMs,
    top_distances: hits.map((h) => Math.round(h.distance * 10000) / 10000),
    ...(input.hybridSearch ? { hybrid: true } : {}),
    ...(input.topicRouting && usedTopic !== null ? { topic: usedTopic } : {}),
    ...(searchQuery !== input.question
      ? { original_query: input.question, rewritten_query: searchQuery }
      : {}),
  };

  console.log(
    `[rag] retrieval hits=${hits.length} queries=${queries.length} topic=${usedTopic ?? "global"} ms=${retrievalMs}`,
  );
  const result = await answerFromHits({ hits, baseTelemetry, startedAt, input, activePersona });
  input.onTelemetry?.(result.telemetry);
  return result;
}

/**
 * Soft fallback reply for turns where RAG produced nothing groundable — no KB
 * hit, or the fact-checker dropped the draft as ungrounded. Instead of going
 * silent, the bot answers in its own persona voice, but is hard-constrained
 * NOT to invent any specifics (salaries, dates, visa terms, cities, prices).
 *
 * Concrete questions get an honest "I'll clarify and come back"; general
 * questions get a normal conversational answer. The caller is still expected
 * to log the unanswered question (kb_suggestions) for a later precise reply.
 */
export async function generateSoftFallback(input: {
  question: string;
  chat: ChatClient;
  persona: Persona;
  history?: ChatMessage[];
}): Promise<string> {
  const { question, chat, persona, history } = input;
  const who = persona.company?.trim()
    ? `${persona.name} из «${persona.company.trim()}»`
    : persona.name;

  const systemPrompt = [
    `Ты — ${who}. Ты переписываешься с кандидатом в мессенджере.`,
    "",
    "По вопросу кандидата у тебя СЕЙЧАС нет точных данных.",
    "Ответь живо и по-человечески, своими словами, коротко — 1–3 предложения.",
    "",
    "Жёсткие правила:",
    "- НЕЛЬЗЯ выдумывать конкретику: зарплаты, суммы, проценты, сроки, даты,",
    "  города, адреса, условия и стоимость визы, названия компаний, требования.",
    "  Никаких цифр и фактов, которых ты не знаешь наверняка.",
    "- Если вопрос требует точных данных — честно скажи, что уточнишь этот",
    "  момент и вернёшься с ответом чуть позже.",
    "- Если вопрос общий и конкретики не требует — просто ответь по смыслу.",
    "- Не извиняйся длинно и формально. Тон тёплый и дружелюбный.",
    "- Не упоминай «базу данных», «систему», не говори, что ты бот или ИИ.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(history ?? []),
    { role: "user", content: question },
  ];
  const raw = await chat.complete(messages, { temperature: 0.5 });
  return applyStyleRules(sanitizeLlmOutput(raw));
}
