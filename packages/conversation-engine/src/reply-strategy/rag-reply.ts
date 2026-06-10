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
 * RAG-aware ReplyStrategy. На каждый user message:
 *   1. loadTurnContext(input) → все per-tenant/per-conversation данные хода.
 *   2. Загрузить последние N сообщений (history) + conversation compaction.
 *   3. Эмбеддинг user message → KbStore.hybridSearch → chunks.
 *   4. answerWithRag(chunks + history + system prompt) → text reply.
 *   5. Вернуть OutboundEnvelope.
 *
 * answerWithRag из @chatman-media/kb сам строит system prompt из chunks,
 * делает query rewriting + reflection (если флаги включены) и
 * sanitize'ит output. Мы только инжектим деп'ы и history.
 *
 * Раньше каждый источник данных был отдельным resolve*-колбэком (18 штук) —
 * scaffolding creep с «тихими» null-фолбэками. Теперь весь контекст хода
 * загружается одним loadTurnContext (#514); сборка живёт в apps/api.
 */

/** Идентификаторы хода, передаются в loadTurnContext. */
export interface RagTurnInput {
  tenantId: number;
  conversationId: number;
  contactId: number;
}

/**
 * Всё, что нужно стратегии для одного хода диалога. Поля, помеченные `?`,
 * опциональны: отсутствие поля = фича не сконфигурирована у тенанта, пайплайн
 * пропускает соответствующий блок (как раньше при отсутствии резолвера).
 */
export interface RagTurnContext {
  /** Vertical template тенанта. Используется для exchange-guard'ов (slug). */
  template: VerticalTemplate;
  /**
   * true → стадия лида в support-mode: бот молчит (возвращает null), оператор
   * ведёт диалог вручную. Loader может вернуть минимальный контекст с этим
   * флагом и не грузить остальное.
   */
  isSupport?: boolean;
  chat: ChatClient;
  embedder: RagEmbeddingClient;
  kb: IKbStore;
  /**
   * Scope для retrieval (stage → funnel → global). Также логируется в
   * kb_suggestions при no-context fallback'е.
   */
  kbScope?: KbScope | null;
  /**
   * Sales-style: persona, framework, hooks для system-prompt'а. null →
   * answerWithRag fallback'нет на DEFAULT_PERSONA. Если содержит
   * styleId/experimentId — assignment сохраняется в conversations для
   * coach/eval attribution.
   */
  style?: ResolvedStyleAssignment | null;
  /** Включённые навыки убеждения (уже отфильтрованы по is_enabled). */
  skills?: readonly SkillForPrompt[];
  /** Активные директорские хуки тенанта (is_active = true). */
  directorHooks?: readonly DirectorHookForPrompt[];
  /** Agentic tools. Пусто/absent → один LLM-вызов без tool-loop'а. */
  tools?: AnyRagTool[];
  /** Cross-encoder reranker (Jina/Cohere) или null. */
  reranker?: Reranker | null;
  /** Per-стадийные инструкции (goal/guidance) из stage_definitions. */
  stageGuidance?: { goal: string; guidance?: string } | null;
  /** Динамический контекст запроса (multi-request / concierge). */
  requestContext?: string | null;
  /**
   * Factual brokered-order context текущего клиента. Мёржится в
   * requestContext и идёт grounding-блоком; не мутирует order state.
   */
  serviceOrderContext?: string | null;
  /** true → в промпт идёт блок «ОЖИДАНИЕ ОПЕРАТОРА» (бот держит, не выдумывает цену). */
  awaitingOperator?: boolean;
  /** Снапшот exchange-workflow state для финального policy guard (только exchange_v1). */
  exchangePolicyState?: ExchangePolicyState | null;
  /** Repo для fire-and-forget логирования незакрытых вопросов (softFallback). */
  suggestions?: KbSuggestionsRepo | null;
  /** Repo для compaction summary + style assignment. Absent → ничего не персистится. */
  conversations?: ConversationsRepo | null;
  messages: MessagesRepo;
}

export interface RagReplyStrategyOpts {
  /**
   * Загрузить контекст хода. Вызывается один раз на каждый входящий message.
   * Сборка (DB-запросы, кеши, метрики-обёртки) — на стороне приложения;
   * независимые источники стоит грузить параллельно (Promise.all).
   */
  loadTurnContext: (
    input: RagTurnInput,
  ) => Promise<RagTurnContext> | RagTurnContext;
  /** Лимит history сообщений (default 12 — answerWithRag сам ужмёт через summary). */
  historyLimit?: number;
  /**
   * Включить hybrid retrieval (vector + BM25 RRF). Default true.
   * False = pure vector — быстрее, но хуже на keyword-questions.
   */
  hybridSearch?: boolean;
  /**
   * Query rewriting перед retrieval (LLM-вызов до search). Default false (#515):
   * замер на двух режимах корпуса не показал вклада (hybrid retrieval справляется
   * с follow-up'ами сам), а шаг стоит +1 LLM-вызов на каждом ходе с историей.
   * Включать точечно, если у тенанта подтверждена польза на его KB.
   */
  rewriteQueryBeforeRetrieval?: boolean;
  /**
   * Reflection-guard после генерации (LLM фактчекит chunks vs answer).
   * Default: только для exchange_v1 — дополнительная LLM-стоимость и latency.
   */
  reflect?: boolean;
  /** topK chunks для контекста. Default 5. */
  topK?: number;
  maxOutputTokens?: number;
  /**
   * Если true — когда RAG не находит контекста (NO_CONTEXT_MARKER) бот всё
   * равно отвечает через `generateSoftFallback` (честное «уточню и вернусь»
   * без выдумывания конкретики). Вопрос при этом логируется в kb_suggestions.
   *
   * Если false (по умолчанию) — бот молчит (возвращает null), как раньше.
   */
  softFallback?: boolean;
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
 * Использовать снаружи (apps/api) при построении style-части TurnContext:
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
  constructor(private readonly opts: RagReplyStrategyOpts) {}

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
    const ctx = await this.opts.loadTurnContext({
      tenantId,
      conversationId: input.conversationId,
      contactId: input.contactId,
    });

    if (ctx.isSupport) return null;

    const { template, chat, messages: messagesRepo } = ctx;

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
      const convsRepo = ctx.conversations;
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

    const kbScope = ctx.kbScope ?? null;
    const kb = kbScope ? new ScopedKbStore(ctx.kb, kbScope) : ctx.kb;
    const style = ctx.style ?? null;
    if (style && hasAssignmentMetadata(style)) {
      const convsRepo = ctx.conversations;
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

    const skills = ctx.skills ?? [];
    const directorHooks = ctx.directorHooks ?? [];
    const tools = ctx.tools ?? [];
    const reranker = ctx.reranker ?? null;
    const stageGuidance = ctx.stageGuidance ?? null;
    const requestContext = ctx.requestContext ?? null;
    const serviceOrderContext = ctx.serviceOrderContext ?? null;
    const awaitingOperator = ctx.awaitingOperator ?? false;
    const exchangePolicyState = isExchange ? (ctx.exchangePolicyState ?? null) : null;

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
      embedder: ctx.embedder,
      chat: chat as unknown as Parameters<typeof answerWithRag>[0]["chat"],
      history: history as unknown as Parameters<typeof answerWithRag>[0]["history"],
      topK: this.opts.topK ?? 5,
      hybridSearch: this.opts.hybridSearch ?? true,
      rewriteQueryBeforeRetrieval: this.opts.rewriteQueryBeforeRetrieval ?? false,
      reflect: this.opts.reflect ?? isExchange,
      numPredict: this.opts.maxOutputTokens ?? 600,
      // Style: если контекст содержит Style — answerWithRag использует его
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
      if (ctx.suggestions) {
        const nowEpoch = Math.floor(Date.now() / 1000);
        ctx.suggestions
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
