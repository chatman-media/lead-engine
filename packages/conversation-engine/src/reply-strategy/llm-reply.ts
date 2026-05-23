import type { OutboundEnvelope } from "@chatman-media/channel-core";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { VerticalTemplate } from "@chatman-media/verticals";
import type { MessageRow, MessagesRepo } from "../dal/messages.ts";
import type { ReplyStrategy } from "../process-inbound.ts";

/**
 * Минимальный LLM-based ReplyStrategy. Шаги на каждый inbound:
 *   1. Загрузить последние N сообщений из conversation (history).
 *   2. Собрать system prompt (template.systemPromptFragment + base).
 *   3. Послать history → ChatClient.complete().
 *   4. Вернуть OutboundEnvelope с text-частью.
 *
 * Что отсутствует (полная RAG / sales — следующая итерация):
 *   - KB search + chunks в контекст
 *   - sales-style selection и A/B routing
 *   - memory extraction в contacts.attributes_json
 *   - conversation summarization для длинных history
 *   - extractFields hook на user message
 *   - photo/voice handling (сейчас игнорируем, нет multimodal через chat)
 *
 * Truncated ответы (ChatTruncatedError) ловятся выше — strategy
 * пробрасывает их в processInbound, где попадают в sink.log; envelope
 * НЕ ставится в outbound_queue, бот молчит вместо half-формы.
 */
export interface LlmReplyStrategyOpts {
  template: VerticalTemplate;
  /**
   * Лимит сообщений в history-prompt'е. Default 20.
   * При больших значениях нужен conversation summary (следующая итерация).
   */
  historyLimit?: number;
  /** Per-call temperature, default 0.7. */
  temperature?: number;
  /** Output token cap, default 600. */
  maxOutputTokens?: number;
  /**
   * Resolver ChatClient'а. apps/api прокидывает функцию которая знает
   * tenant_id из request scope: (tenantId) => llmRouter.resolveChat(tenantId, 'chat').
   * Это даёт per-call swap клиента — если оператор поменял конфиг через
   * admin-UI и invalidate'нул router, следующий resolveChat() построит
   * нового.
   */
  resolveChat: (tenantId: number) => ChatClient;
  /** Если возвращает true — стадия лида помечена supportMode, бот молчит. */
  resolveIsSupport?: (input: { tenantId: number; contactId: number }) => Promise<boolean>;
}

const BASE_SYSTEM_PROMPT =
  "Ты — операционный бот платформы lead-engine. Отвечай кратко, " +
  "уважительно, по делу. Никогда не выдумывай факты которых нет в " +
  "контексте — лучше скажи «уточню у партнёра» и поставь сообщение в очередь оператора.";

function messagesToChatHistory(history: MessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant" || m.role === "human")
      out.push({ role: "assistant", content: m.text });
    // 'system' уже отфильтрован в MessagesRepo.recent.
  }
  return out;
}

export class LlmReplyStrategy implements ReplyStrategy {
  constructor(
    private readonly opts: LlmReplyStrategyOpts,
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

    if (this.opts.resolveIsSupport) {
      const isSupport = await this.opts.resolveIsSupport({
        tenantId: input.tenant.tenantId,
        contactId: input.contactId,
      });
      if (isSupport) return null;
    }

    const messages = this.messagesRepoFor(input.tenant.tenantId);
    const history = await messages.recent(input.conversationId, this.opts.historyLimit ?? 20);
    const historyMessages = messagesToChatHistory(history);

    const systemPrompt = [BASE_SYSTEM_PROMPT, this.opts.template.systemPromptFragment]
      .filter(Boolean)
      .join("\n\n");

    const chat = this.opts.resolveChat(input.tenant.tenantId);
    const reply = await chat.complete(
      [{ role: "system", content: systemPrompt }, ...historyMessages],
      {
        temperature: this.opts.temperature ?? 0.7,
        numPredict: this.opts.maxOutputTokens ?? 600,
      },
    );

    if (reply.trim().length === 0) return null;
    return [
      {
        channelId: String(input.channel.channelId),
        externalUserId: input.inbound.externalUserId,
        parts: [{ kind: "text", text: reply }],
      },
    ];
  }
}
