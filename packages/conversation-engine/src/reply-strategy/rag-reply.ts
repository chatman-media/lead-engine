import type { OutboundEnvelope } from "@chatman-media/channel-core";
import type {
  ChatClient,
  ChatMessage,
  EmbeddingClient as RagEmbeddingClient,
} from "@chatman-media/llm-router";
import {
  answerWithRag,
  type AnyRagTool,
  type DirectorHookForPrompt,
  type IKbStore,
  type Reranker,
  type SkillForPrompt,
  type Style,
  StyleSchema,
} from "@chatman-media/kb";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import type { ReplyStrategy } from "../process-inbound.ts";

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
  template: VerticalTemplate;
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
   * Опциональный sales-style resolver. Если задан и возвращает Style —
   * answerWithRag использует его для построения system-prompt (persona,
   * sales framework, hooks, skills). При null/undefined — rag fallback'нет
   * на DEFAULT_PERSONA. Лёгкое расширение для A/B routing в будущем:
   * resolveStyle может смотреть на conversation.style_id или experiment_id.
   */
  resolveStyle?: (input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
  }) => Promise<Style | null> | Style | null;
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
  }) => Promise<AnyRagTool[]> | AnyRagTool[];
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

    if (this.opts.resolveIsSupport) {
      const isSupport = await this.opts.resolveIsSupport({ tenantId, contactId: input.contactId });
      if (isSupport) return null;
    }

    const messages = this.messagesRepoFor(tenantId);

    // Грузим history БЕЗ текущего user message (answerWithRag сам добавит
    // его как `question`). Берём + 1 чтобы исключить если оно уже persisted.
    const allRecent = await messages.recent(input.conversationId, (this.opts.historyLimit ?? 12) + 1);
    const historyWithoutCurrent = allRecent.filter((m) => m.text !== input.userMessageText);
    const history = messagesToChatHistory(historyWithoutCurrent);

    const chat = this.opts.resolveChat(tenantId);
    const embedder = this.opts.resolveEmbed(tenantId);
    const kb = this.opts.resolveKb(tenantId);
    const style = this.opts.resolveStyle
      ? await this.opts.resolveStyle({
          tenantId,
          conversationId: input.conversationId,
          contactId: input.contactId,
        })
      : null;

    // Load persuasion skills, director hooks, agentic tools, and reranker in parallel.
    // All are optional — if resolvers not configured, values stay empty/null
    // and the pipeline silently skips those blocks.
    const [skills, directorHooks, tools, reranker] = await Promise.all([
      this.opts.resolveSkills ? this.opts.resolveSkills({ tenantId }) : Promise.resolve([]),
      this.opts.resolveDirectorHooks
        ? this.opts.resolveDirectorHooks({ tenantId })
        : Promise.resolve([]),
      this.opts.resolveTools
        ? this.opts.resolveTools({ tenantId, conversationId: input.conversationId })
        : Promise.resolve([]),
      this.opts.resolveReranker
        ? this.opts.resolveReranker({ tenantId })
        : Promise.resolve(null),
    ]);

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
      reflect: this.opts.reflect ?? false,
      numPredict: this.opts.maxOutputTokens ?? 600,
      // Style: если resolveStyle вернул Style — answerWithRag использует его
      // persona, sales framework, hooks, skills для построения system prompt.
      // При null — rag fallback'нет на DEFAULT_PERSONA и базовый промпт.
      ...(style ? { style } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(directorHooks.length > 0 ? { directorHooks } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(reranker ? { reranker } : {}),
    });

    if (!result.text || result.text.trim().length === 0) return null;
    return [
      {
        channelId: String(input.channel.channelId),
        externalUserId: input.inbound.externalUserId,
        parts: [{ kind: "text", text: result.text }],
      },
    ];
  }
}
