import type { OutboundEnvelope } from "@chatman-media/channel-core";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { answerWithRag, type IKbStore, type EmbeddingClient as RagEmbeddingClient } from "@chatman-media/rag";
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
 * answerWithRag из @chatman-media/rag сам строит system prompt из chunks,
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
    const messages = this.messagesRepoFor(tenantId);

    // Грузим history БЕЗ текущего user message (answerWithRag сам добавит
    // его как `question`). Берём + 1 чтобы исключить если оно уже persisted.
    const allRecent = await messages.recent(input.conversationId, (this.opts.historyLimit ?? 12) + 1);
    const historyWithoutCurrent = allRecent.filter((m) => m.text !== input.userMessageText);
    const history = messagesToChatHistory(historyWithoutCurrent);

    const chat = this.opts.resolveChat(tenantId);
    const embedder = this.opts.resolveEmbed(tenantId);
    const kb = this.opts.resolveKb(tenantId);

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
      // Persona.role в rag типизирован как "human" | "assistant" — это
      // semantic-флаг (бот=AI vs живой человек), не место для свободной
      // строки. Vertical-template'овский systemPromptFragment в rag'овский
      // pipeline инжектится через style.config_json в полной интеграции;
      // эту wire-up планируем в Этапе 4 часть 2c-3 (sales-style selection
      // + composeSystemPrompt). Сейчас отдаём минимальную Persona — answerWithRag
      // подхватит свой DEFAULT_PERSONA если поле опущено.
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
