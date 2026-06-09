import type { OutboundEnvelope } from "@chatman-media/channel-core";
import {
  type AnswerTelemetry,
  type AnyRagTool,
  answerWithRag,
  DEFAULT_PERSONA,
  type DirectorHookForPrompt,
  generateSoftFallback,
  type IKbStore,
  type KbScope,
  NO_CONTEXT_MARKER,
  type Persona,
  type Reranker,
  type SkillForPrompt,
  type Style,
  StyleSchema,
} from "@chatman-media/kb";
import type {
  ChatClient,
  ChatMessage,
  EmbeddingClient as RagEmbeddingClient,
} from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import { compactConversation } from "../compact-conversation.ts";
import type { ConversationsRepo } from "../dal/conversations.ts";
import { ScopedKbStore } from "../dal/kb-store.ts";
import type { KbSuggestionsRepo } from "../dal/kb-suggestions.ts";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import type { ReplyStrategy } from "../process-inbound.ts";
import {
  type ExchangePolicyState,
  guardExchangePolicy,
} from "./exchange-policy-guard.ts";
import { EXCHANGE_SAFE_FALLBACK } from "./exchange-reply-guard.ts";

/**
 * RAG-аware ReplyStrategy. На каждый user message:
 *   1. Загрузить последние N сообщений (history).
 *   2. Эмбеддинг user message → KbStore.hybridSearch → chunks.
 *   3. answerWithRag(chunks + history + system prompt) → text reply.
 *   4. Вернуть OutboundEnvelope.
 *
 * answerWithRag из @chatman-media/kb сам строит system prompt из chunks,
 * делает query rewriting + reflection (если флаги включены) и
 * sanitize'ит output. Мы только инжектим деп'ы и history.
 *
 * Vertical-template'овский systemPromptFragment пробрасывается через
 * persona.role — это не идеально, но answerWithRag не предоставляет
 * прямой override system-промпта; нужная extension-точка появится при
 * рефакторе rag (вне scope этого pkg'а).
 */
export interface RagReplyStrategyOpts {
  /** Fallback template used when no per-tenant template resolver is configured. */
  template: VerticalTemplate;
  /**
   * Optional per-tenant template resolver. Lets apps/api use the tenant's
   * installed vertical instead of one boot-time hardcoded template.
   */
  resolveTemplate?: (tenantId: number) => VerticalTemplate | null | undefined;
  /** Лимит history сообщений (default 12 — answerWithRag сам ужмёт через summary). */
  historyLimit?: number;
  /**
   * Включить hybrid retrieval (vector + BM25 RRF). Default true.
   * False = pure vector — быстрее, но хуже на keyword-questions.
   */
  hybridSearch?: boolean;
  /**
   * Query rewriting перед retrieval (LLM-вызов до search). Default true.
   * Помогает на ambiguous follow-up'ах ("а что насчёт оплаты?" → "оплата контракта в UAE").
   */
  rewriteQueryBeforeRetrieval?: boolean;
  /**
   * Reflection-guard после генерации (LLM фактчекит chunks vs answer).
   * Default false — дополнительная LLM-стоимость и latency.
   */
  reflect?: boolean;
  /** topK chunks для контекста. Default 5. */
  topK?: number;
  /** Per-call temperature, default 0.7. */
  temperature?: number;
  maxOutputTokens?: number;
  resolveChat: (tenantId: number) => ChatClient;
  resolveEmbed: (tenantId: number) => RagEmbeddingClient;
  resolveKb: (tenantId: number) => IKbStore;
  /**
   * Optional KB scope resolver. When provided, retrieval checks the current
   * stage first, then the funnel, then global docs.
   */
  resolveKbScope?: (input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
  }) => Promise<KbScope | null> | KbScope | null;
  /**
   * Опциональный sales-style resolver. Если задан и возвращает Style —
   * answerWithRag использует его для построения system-prompt (persona,
   * sales framework, hooks, skills). При null/undefined — rag fallback'нет
   * на DEFAULT_PERSONA. Если resolver возвращает styleId/experimentId,
   * assignment сохраняется в conversations для coach/eval attribution.
   */
  resolveStyle?: (input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
  }) => Promise<ResolvedStyleAssignment | null> | ResolvedStyleAssignment | null;
  /**
   * Опциональная проверка support-mode. Если возвращает true — стадия лида
   * помечена как supportMode и бот не отвечает (возвращает null). Оператор
   * ведёт диалог вручную пока лид не переведут на другую стадию.
   */
  resolveIsSupport?: (input: {
    tenantId: number;
    contactId: number;
  }) => Promise<boolean>;
  /**
   * Опциональный resolver пер-стадийных инструкций (Phase 2): goal/guidance
   * текущей стадии лида из stage_definitions. Если вернёт значение — оно идёт
   * в composeSystemPrompt (stageOverride) с приоритетом над Style.stages.
   * null → используется Style.
   */
  resolveStageGuidance?: (input: {
    tenantId: number;
    contactId: number;
  }) => Promise<{ goal: string; guidance?: string } | null>;
  /**
   * Опциональный resolver динамического контекста запроса (multi-request /
   * concierge): тип запроса гостя + число открытых. Идёт в composeSystemPrompt
   * (requestContext). null → блок «ЗАПРОС ГОСТЯ» не добавляется.
   */
  resolveRequestContext?: (input: {
    tenantId: number;
    contactId: number;
  }) => Promise<string | null>;
  /**
   * Optional factual brokered-order context for the current customer. Merged
   * into requestContext for prompt grounding; it must not mutate order state.
   */
  resolveServiceOrderContext?: (input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
  }) => Promise<string | null> | string | null;
  /**
   * Optional exchange workflow state snapshot for the final policy guard.
   * Used only for exchange_v1, after RAG/tool generation.
   */
  resolveExchangePolicyState?: (input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
  }) => Promise<ExchangePolicyState | null> | ExchangePolicyState | null;
  /**
   * Опциональный resolver «лид ждёт оператора» (R5): true → в промпт идёт блок
   * «ОЖИДАНИЕ ОПЕРАТОРА» (бот держит, не выдумывает цену). false/absent → нет.
   */
  resolveAwaitingOperator?: (input: {
    tenantId: number;
    contactId: number;
  }) => Promise<boolean>;
  /**
   * Загрузить включённые навыки убеждения для тенанта. Возвращает список
   * SkillForPrompt, уже отфильтрованных по is_enabled = true.
   * Stage-фильтрация (intake/active/always) выполняется внутри
   * composeSystemPrompt по applicableStages.
   * Если не задан — навыки не инжектируются (silent fallback).
   */
  resolveSkills?: (input: {
    tenantId: number;
  }) => Promise<readonly SkillForPrompt[]>;
  /**
   * Загрузить активные директорские хуки тенанта (is_active = true).
   * Если не задан — хуки не инжектируются.
   */
  resolveDirectorHooks?: (input: {
    tenantId: number;
  }) => Promise<readonly DirectorHookForPrompt[]>;
  /**
   * Загрузить активные agentic tools для тенанта.
   * Вызывается один раз на каждый входящий message.
   * Если не задан или возвращает пустой массив — tool-loop не запускается
   * (поведение как раньше: один LLM-вызов без инструментов).
   *
   * @example
   * ```ts
   * resolveTools: async ({ tenantId }) => {
   *   const url = await getBookingUrl(tenantId);
   *   return url ? [makeBookingLinkTool(url)] : [];
   * }
   * ```
   */
  resolveTools?: (input: {
    tenantId: number;
    conversationId: number;
    contactId?: number;
  }) => Promise<AnyRagTool[]> | AnyRagTool[];
  /**
   * Если true — когда RAG не находит контекста (NO_CONTEXT_MARKER) бот всё
   * равно отвечает через `generateSoftFallback` (честное «уточню и вернусь»
   * без выдумывания конкретики). Вопрос при этом логируется в kb_suggestions.
   *
   * Если false (по умолчанию) — бот молчит (возвращает null), как раньше.
   */
  softFallback?: boolean;
  /**
   * Фабрика KbSuggestionsRepo для fire-and-forget логирования незакрытых вопросов.
   * Используется только если softFallback=true.
   */
  resolveSuggestions?: (tenantId: number) => KbSuggestionsRepo;
  /**
   * Conversation compaction: если кол-во сообщений в диалоге достигает порога —
   * pipeline генерирует резюме и сохраняет его в conversations.summary_json.
   * Резюме передаётся в answerWithRag как conversationSummary, сокращая effective
   * history window и предотвращая overflow LLM context.
   *
   * Default: 20. Отключить: 0 или Infinity.
   */
  compactAfterMessages?: number;
  /**
   * Фабрика ConversationsRepo для сохранения compaction summary.
   * Если не задан — compaction происходит в памяти (summary не сохраняется).
   */
  resolveConversations?: (tenantId: number) => ConversationsRepo;
  /**
   * Optional cross-encoder reranker resolver. Called once per turn — should
   * return a `Reranker` instance (Jina or Cohere) configured for the tenant,
   * or null/undefined if no reranker is configured. Results are expected to be
   * cached by the caller (building a reranker per-call is cheap — the API key
   * lookup is the expensive part, which the caller should cache).
   */
  resolveReranker?: (input: {
    tenantId: number;
  }) => Promise<Reranker | null> | Reranker | null;
  /**
   * Optional post-generation telemetry sink for agentic tool calls. Called only
   * after the LLM/tool loop finishes, so it never wraps an LLM call in a DB tx.
   */
  recordToolCalls?: (input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
    userMessageText: string;
    assistantText: string;
    telemetry: AnswerTelemetry;
  }) => Promise<void> | void;
}

function messagesToChatHistory(history: MessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant" || m.role === "human")
      out.push({ role: "assistant", content: m.text });
  }
  return out;
}

/**
 * Helper: распарсить style.config_json (из storage StyleRow) в типизированный
 * rag's Style через zod StyleSchema. Возвращает null если JSON невалидный —
 * pipeline'у тогда fall back на DEFAULT_PERSONA вместо crash'а.
 *
 * Использовать снаружи (apps/api) при построении resolveStyle hook'а:
 *   const styleRow = await stylesRepo.findActiveBySlug(slug);
 *   return parseStyleConfig(styleRow.configJson);
 */
export function parseStyleConfig(configJson: string): Style | null {
  try {
    const raw = JSON.parse(configJson);
    return StyleSchema.parse(raw);
  } catch {
    return null;
  }
}

export type ResolvedStyleAssignment = Style & {
  styleId?: number | null;
  experimentId?: number | null;
  experimentSlug?: string | null;
  variantSlug?: string | null;
};

function hasAssignmentMetadata(style: ResolvedStyleAssignment | null): boolean {
  return style?.styleId !== undefined || style?.experimentId !== undefined;
}

export class RagReplyStrategy implements ReplyStrategy {
  constructor(
    private readonly opts: RagReplyStrategyOpts,
    private readonly messagesRepoFor: (tenantId: number) => MessagesRepo,
  ) {}

  async generate(input: {
    tenant: { tenantId: number };
    channel: { channelId: number };
    conversationId: number;
    contactId: number;
    inbound: { externalUserId: string };
    userMessageText: string;
  }): Promise<OutboundEnvelope[] | null> {
    if (input.userMessageText.length === 0) return null;

    const tenantId = input.tenant.tenantId;
    const template = this.opts.resolveTemplate?.(tenantId) ?? this.opts.template;

    if (this.opts.resolveIsSupport) {
      const isSupport = await this.opts.resolveIsSupport({ tenantId, contactId: input.contactId });
      if (isSupport) return null;
    }

    const messagesRepo = this.messagesRepoFor(tenantId);
    const chat = this.opts.resolveChat(tenantId);

    // ── Conversation compaction ───────────────────────────────────────────────
    // When the conversation grows past the configured threshold, generate a
    // compressed summary and persist it so future turns can trim the raw history.
    const compactThreshold = this.opts.compactAfterMessages ?? 20;
    let conversationSummary: string | undefined;

    // Load conversation summary + message count in parallel.
    const [allRecent, totalCount] = await Promise.all([
      messagesRepo.recent(input.conversationId, (this.opts.historyLimit ?? 12) + 1),
      compactThreshold > 0 ? messagesRepo.countByConversation(input.conversationId) : Promise.resolve(0),
    ]);

    if (compactThreshold > 0 && totalCount >= compactThreshold) {
      // Try loading a stored summary first (avoid re-compacting every turn).
      const convsRepo = this.opts.resolveConversations?.(tenantId);
      const convo = convsRepo ? await convsRepo.findById(input.conversationId) : null;

      if (convo?.summaryJson) {
        // Parse previously stored summary.
        try {
          conversationSummary = JSON.parse(convo.summaryJson) as string;
        } catch {
          conversationSummary = convo.summaryJson;
        }
      }

      // Re-compact every `compactThreshold` messages to keep summary fresh.
      const shouldRecompact = !conversationSummary || totalCount % compactThreshold === 0;
      if (shouldRecompact) {
        const chatHistory = messagesToChatHistory(allRecent);
        const freshSummary = await compactConversation(
          chatHistory,
          chat as unknown as Parameters<typeof compactConversation>[1],
        ).catch((err) => {
          console.warn("[rag-reply] compaction failed:", err);
          return null;
        });

        if (freshSummary) {
          conversationSummary = freshSummary;
          // Persist async — don't block the reply.
          convsRepo
            ?.setSummaryJson(input.conversationId, JSON.stringify(freshSummary))
            .catch((err) => console.warn("[rag-reply] failed to save summary:", err));
        }
      }
    }

    // Грузим history БЕЗ текущего user message (answerWithRag сам добавит
    // его как `question`). Берём + 1 чтобы исключить если оно уже persisted.
    const historyWithoutCurrent = allRecent.filter((m) => m.text !== input.userMessageText);
    const history = messagesToChatHistory(historyWithoutCurrent);

    const embedder = this.opts.resolveEmbed(tenantId);
    const baseKb = this.opts.resolveKb(tenantId);
    const kbScope = this.opts.resolveKbScope
      ? await this.opts.resolveKbScope({
          tenantId,
          conversationId: input.conversationId,
          contactId: input.contactId,
        })
      : null;
    const kb = kbScope ? new ScopedKbStore(baseKb, kbScope) : baseKb;
    const style = this.opts.resolveStyle
      ? await this.opts.resolveStyle({
          tenantId,
          conversationId: input.conversationId,
          contactId: input.contactId,
        })
      : null;
    if (style && hasAssignmentMetadata(style)) {
      const convsRepo = this.opts.resolveConversations?.(tenantId);
      if (convsRepo) {
        await convsRepo
          .setAssignment(input.conversationId, {
            ...(style.styleId !== undefined ? { styleId: style.styleId } : {}),
            ...(style.experimentId !== undefined ? { experimentId: style.experimentId } : {}),
          })
          .catch((err) => console.warn("[rag-reply] failed to save style assignment:", err));
      }
    }

    const isExchange = template?.slug === "exchange_v1";

    // Load persuasion skills, director hooks, agentic tools, and reranker in parallel.
    // All are optional — if resolvers not configured, values stay empty/null
    // and the pipeline silently skips those blocks.
    const [
      skills,
      directorHooks,
      tools,
      reranker,
      stageGuidance,
      requestContext,
      serviceOrderContext,
      awaitingOperator,
      exchangePolicyState,
    ] = await Promise.all([
      this.opts.resolveSkills ? this.opts.resolveSkills({ tenantId }) : Promise.resolve([]),
      this.opts.resolveDirectorHooks
        ? this.opts.resolveDirectorHooks({ tenantId })
        : Promise.resolve([]),
      this.opts.resolveTools
        ? this.opts.resolveTools({
            tenantId,
            conversationId: input.conversationId,
            contactId: input.contactId,
          })
        : Promise.resolve([]),
      this.opts.resolveReranker
        ? this.opts.resolveReranker({ tenantId })
        : Promise.resolve(null),
      this.opts.resolveStageGuidance
        ? this.opts.resolveStageGuidance({ tenantId, contactId: input.contactId })
        : Promise.resolve(null),
      this.opts.resolveRequestContext
        ? this.opts.resolveRequestContext({ tenantId, contactId: input.contactId })
        : Promise.resolve(null),
      this.opts.resolveServiceOrderContext
        ? Promise.resolve(
            this.opts.resolveServiceOrderContext({
              tenantId,
              conversationId: input.conversationId,
              contactId: input.contactId,
            }),
          )
        : Promise.resolve(null),
      this.opts.resolveAwaitingOperator
        ? this.opts.resolveAwaitingOperator({ tenantId, contactId: input.contactId })
        : Promise.resolve(false),
      isExchange && this.opts.resolveExchangePolicyState
        ? Promise.resolve(
            this.opts.resolveExchangePolicyState({
              tenantId,
              conversationId: input.conversationId,
              contactId: input.contactId,
            }),
          ).catch((err) => {
            console.warn("[rag-reply] failed to resolve exchange policy state:", err);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const combinedRequestContext =
      [requestContext, serviceOrderContext]
        .map((value) => value?.trim())
        .filter(Boolean)
        .join("\n\n") || null;
    const serviceOrderGrounding = serviceOrderContext?.trim() || null;

    // answerWithRag принимает rag's ChatClient/EmbeddingClient. Структурно
    // наш llm-router'овский ChatClient compatible (rag's ChatMessage.content
    // допускает null — наш string ужe; complete(messages, opts?) совпадает).
    // Если TS жалуется на nominal-mismatch — даём structural cast.
    const result = await answerWithRag({
      question: input.userMessageText,
      kb,
      embedder,
      chat: chat as unknown as Parameters<typeof answerWithRag>[0]["chat"],
      history: history as unknown as Parameters<typeof answerWithRag>[0]["history"],
      topK: this.opts.topK ?? 5,
      hybridSearch: this.opts.hybridSearch ?? true,
      rewriteQueryBeforeRetrieval: this.opts.rewriteQueryBeforeRetrieval ?? true,
      reflect: this.opts.reflect ?? isExchange,
      numPredict: this.opts.maxOutputTokens ?? 600,
      // Style: если resolveStyle вернул Style — answerWithRag использует его
      // persona, sales framework, hooks, skills для построения system prompt.
      // При null — rag fallback'нет на DEFAULT_PERSONA и базовый промпт.
      ...(style ? { style } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(directorHooks.length > 0 ? { directorHooks } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(reranker ? { reranker } : {}),
      ...(conversationSummary ? { conversationSummary } : {}),
      ...(stageGuidance ? { stageOverride: stageGuidance } : {}),
      ...(combinedRequestContext ? { requestContext: combinedRequestContext } : {}),
      ...(serviceOrderGrounding
        ? { vacanciesBlock: serviceOrderGrounding, vacancyGuard: false }
        : {}),
      ...(awaitingOperator ? { awaitingOperator } : {}),
    });

    // ── Soft fallback when RAG has no context ────────────────────────────────
    if (result.text === NO_CONTEXT_MARKER || !result.text || result.text.trim().length === 0) {
      // Fire-and-forget: log unanswered question for the KB suggestions queue.
      if (this.opts.resolveSuggestions) {
        const suggestionsRepo = this.opts.resolveSuggestions(tenantId);
        const nowEpoch = Math.floor(Date.now() / 1000);
        suggestionsRepo
          .log({
            questionText: input.userMessageText,
            sourceConversationId: input.conversationId,
            ...(kbScope ? { scope: kbScope } : {}),
            nowEpoch,
          })
          .catch((err) => {
            console.warn("[rag-reply] failed to log kb_suggestion:", err);
          });
      }

      if (isExchange) {
        console.warn(
          `[exchange-reflect-guard] tenant=${tenantId} conversation=${input.conversationId} path=${result.telemetry.path}`,
        );
        return [
          {
            channelId: String(input.channel.channelId),
            externalUserId: input.inbound.externalUserId,
            parts: [{ kind: "text", text: EXCHANGE_SAFE_FALLBACK }],
          },
        ];
      }

      if (!this.opts.softFallback) return null;

      // Derive persona: from style (if set) or DEFAULT_PERSONA.
      const persona: Persona = style
        ? {
            name: style.persona.name,
            role: style.persona.role,
            ...(style.persona.company?.trim() ? { company: style.persona.company.trim() } : {}),
          }
        : DEFAULT_PERSONA;

      const fallbackText = await generateSoftFallback({
        question: input.userMessageText,
        chat: chat as unknown as Parameters<typeof generateSoftFallback>[0]["chat"],
        persona,
        history: history as unknown as Parameters<typeof generateSoftFallback>[0]["history"],
      });

      if (!fallbackText || fallbackText.trim().length === 0) return null;

      return [
        {
          channelId: String(input.channel.channelId),
          externalUserId: input.inbound.externalUserId,
          parts: [{ kind: "text", text: fallbackText }],
        },
      ];
    }

    const guarded = isExchange
      ? guardExchangePolicy({
          text: result.text,
          telemetry: result.telemetry,
          history: historyWithoutCurrent,
          state: exchangePolicyState,
        })
      : { ok: true, text: result.text };
    if (!guarded.ok) {
      console.warn(
        `[exchange-policy-guard] tenant=${tenantId} conversation=${input.conversationId} reason=${guarded.reason ?? "unknown"}`,
      );
    }

    if (
      this.opts.recordToolCalls &&
      ((result.telemetry.toolCalls?.length ?? 0) > 0 || result.telemetry.toolCall)
    ) {
      try {
        await this.opts.recordToolCalls({
          tenantId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          userMessageText: input.userMessageText,
          assistantText: guarded.text,
          telemetry: result.telemetry,
        });
      } catch (err) {
        console.warn("[rag-reply] failed to record tool calls:", err);
      }
    }

    return [
      {
        channelId: String(input.channel.channelId),
        externalUserId: input.inbound.externalUserId,
        parts: [{ kind: "text", text: guarded.text }],
      },
    ];
  }
}
