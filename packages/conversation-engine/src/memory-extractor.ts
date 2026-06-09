import type { ChatClient, ChatMessage as LlmChatMessage } from "@chatman-media/llm-router";
import { extractUserFacts } from "@chatman-media/kb";
import type { ContactsRepo } from "./dal/contacts.ts";
import type { MessageRow, MessagesRepo } from "./dal/messages.ts";

/**
 * Memory extractor — LLM-based анализ диалога, извлекает факты о кандидате
 * (name/city/age/experience/...) и merge'ит их в contact.attributes_json.
 *
 * Дополняет vertical-template'овский hooks.extractFields:
 *   - extractFields — regex/regex-based, дёшево и быстро, но узко (имя/возраст
 *     по паттерну)
 *   - LlmMemoryExtractor — LLM-call, дороже, но универсально (русский NER,
 *     импликации типа "работала в Дубае" → country_target=Dubai)
 *
 * Вызывается после persist user-message в pipeline. Не блокирует reply-loop:
 *   - exception → log + continue
 *   - extractor сам skip'ает LLM call если нет user-сообщений
 */
export interface MemoryExtractor {
  /** Сколько последних сообщений нужно для extraction snapshot. */
  historyLimit?: number;
  /** Извлекает facts; возвращает только новые/обновлённые. Empty = no-op. */
  extract(opts: {
    tenantId: number;
    conversationId: number;
    contactId: number;
    existingFacts: Record<string, string>;
    /**
     * Prepared history from a short `withTenant` read. If omitted, extractor
     * may load history itself (legacy path).
     */
    history?: MessageRow[];
  }): Promise<Record<string, string>>;
}

/**
 * LLM-based реализация через @chatman-media/kb.extractUserFacts.
 * MessagesRepo — для загрузки history, ChatClient — для LLM-вызова.
 */
export class LlmMemoryExtractor implements MemoryExtractor {
  readonly historyLimit: number;

  constructor(
    private readonly opts: {
      historyLimit?: number;
      resolveChat: (tenantId: number) => ChatClient;
    },
    private readonly messagesRepoFor: (tenantId: number) => MessagesRepo,
  ) {
    this.historyLimit = opts.historyLimit ?? 10;
  }

  async extract(input: {
    tenantId: number;
    conversationId: number;
    contactId: number;
    existingFacts: Record<string, string>;
    history?: MessageRow[];
  }): Promise<Record<string, string>> {
    const history =
      input.history ??
      (await this.messagesRepoFor(input.tenantId).recent(
        input.conversationId,
        this.historyLimit,
      ));
    if (history.length === 0) return {};

    const llmMessages = mapToRagMessages(history);
    if (llmMessages.length === 0) return {};

    const chat = this.opts.resolveChat(input.tenantId);
    return extractUserFacts({
      messages: llmMessages as unknown as Parameters<typeof extractUserFacts>[0]["messages"],
      chat: chat as unknown as Parameters<typeof extractUserFacts>[0]["chat"],
      existingFacts: input.existingFacts,
    });
  }
}

function mapToRagMessages(history: MessageRow[]): LlmChatMessage[] {
  const out: LlmChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant" || m.role === "human")
      out.push({ role: "assistant", content: m.text });
  }
  return out;
}

// ---- Pipeline-side helper ----------------------------------------------

/**
 * Дёргает extractor + merge'ит результат в contact.attributes_json.
 * Используется из process-inbound (опционально через memoryExtractor dep).
 *
 * Контракт: existing facts читаются из contact.attributesJson; только string-
 * value поля считаются "facts" (rag's extractUserFacts возвращает
 * Record<string,string>). Не-string полей (age:number и т.п.) сохраняются
 * как-есть.
 */
export async function runMemoryExtraction(opts: {
  extractor: MemoryExtractor;
  tenantId: number;
  conversationId: number;
  contactId: number;
  contacts: ContactsRepo;
  nowEpoch: number;
}): Promise<Record<string, string>> {
  const contact = await opts.contacts.byId(opts.contactId);
  if (!contact) return {};
  const existing: Record<string, string> = {};
  if (contact.attributesJson) {
    const parsed = JSON.parse(contact.attributesJson) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") existing[k] = v;
    }
  }
  const newFacts = await opts.extractor.extract({
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    contactId: opts.contactId,
    existingFacts: existing,
  });
  if (Object.keys(newFacts).length > 0) {
    await opts.contacts.mergeAttributes(opts.contactId, newFacts, opts.nowEpoch);
  }
  return newFacts;
}
