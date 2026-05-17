import type { ChatMessage } from "./chat.ts";

/**
 * Unified interface for persisting conversation history and summaries.
 *
 * Implement this for your storage backend (PostgreSQL, Redis, SQLite, …).
 * An in-memory reference implementation is exported as `InMemoryConversationStore`.
 */
export interface IConversationStore {
  /** Append one message to the conversation history. */
  addMessage(conversationId: string, message: ChatMessage): Promise<void>;

  /** Return messages in chronological order. Returns [] for unknown ids. */
  getHistory(conversationId: string): Promise<ChatMessage[]>;

  /**
   * Replace the stored history with a shorter version (e.g. after summarisation).
   * Typically called with the last N messages after older turns are compressed.
   */
  setHistory(conversationId: string, messages: ChatMessage[]): Promise<void>;

  /** Store or update the running summary for the conversation. */
  setSummary(conversationId: string, summary: string): Promise<void>;

  /** Retrieve the current summary, or null if none exists. */
  getSummary(conversationId: string): Promise<string | null>;

  /** Remove all data for a conversation (GDPR deletion, session reset, …). */
  deleteConversation(conversationId: string): Promise<void>;
}

interface ConversationData {
  history: ChatMessage[];
  summary: string | null;
  updatedAt: number;
}

/**
 * Zero-dependency in-memory `IConversationStore`.
 *
 * Suitable for tests, prototypes, and single-process deployments.
 * Data is lost on process restart — use a database-backed implementation
 * for production.
 *
 * @example
 * ```ts
 * import {
 *   InMemoryConversationStore,
 *   summarizeConversation,
 *   answerWithRag,
 * } from "@chatman-media/rag";
 *
 * const store = new InMemoryConversationStore({ maxHistoryLength: 20, ttlMs: 2 * 60 * 60_000 });
 *
 * // Each turn:
 * const history = await store.getHistory(userId);
 * const summary = await store.getSummary(userId);
 * const result = await answerWithRag({ question, kb, chat, embedder, history, conversationSummary: summary ?? undefined });
 * await store.addMessage(userId, { role: "user", content: question });
 * await store.addMessage(userId, { role: "assistant", content: result.text });
 *
 * // Compress when history grows long:
 * if (history.length > 30) {
 *   const newSummary = await summarizeConversation({ history, chat });
 *   await store.setSummary(userId, newSummary);
 *   await store.setHistory(userId, history.slice(-10));
 * }
 * ```
 */
export class InMemoryConversationStore implements IConversationStore {
  private readonly data = new Map<string, ConversationData>();
  private readonly maxHistoryLength: number;
  private readonly ttlMs: number;

  constructor(opts: { maxHistoryLength?: number; ttlMs?: number } = {}) {
    this.maxHistoryLength = opts.maxHistoryLength ?? 100;
    this.ttlMs = opts.ttlMs ?? Infinity;
  }

  async addMessage(conversationId: string, message: ChatMessage): Promise<void> {
    const conv = this.getOrCreate(conversationId);
    conv.history.push(message);
    if (conv.history.length > this.maxHistoryLength) {
      conv.history = conv.history.slice(-this.maxHistoryLength);
    }
    conv.updatedAt = Date.now();
  }

  async getHistory(conversationId: string): Promise<ChatMessage[]> {
    const conv = this.data.get(conversationId);
    if (!conv || this.isExpired(conv)) return [];
    return [...conv.history];
  }

  async setHistory(conversationId: string, messages: ChatMessage[]): Promise<void> {
    const conv = this.getOrCreate(conversationId);
    conv.history = [...messages];
    conv.updatedAt = Date.now();
  }

  async setSummary(conversationId: string, summary: string): Promise<void> {
    const conv = this.getOrCreate(conversationId);
    conv.summary = summary;
    conv.updatedAt = Date.now();
  }

  async getSummary(conversationId: string): Promise<string | null> {
    const conv = this.data.get(conversationId);
    if (!conv || this.isExpired(conv)) return null;
    return conv.summary;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.data.delete(conversationId);
  }

  /** Number of active (non-expired) conversations. */
  get size(): number {
    let n = 0;
    for (const conv of this.data.values()) {
      if (!this.isExpired(conv)) n++;
    }
    return n;
  }

  private getOrCreate(id: string): ConversationData {
    let conv = this.data.get(id);
    if (!conv || this.isExpired(conv)) {
      conv = { history: [], summary: null, updatedAt: Date.now() };
      this.data.set(id, conv);
    }
    return conv;
  }

  private isExpired(conv: ConversationData): boolean {
    return this.ttlMs !== Infinity && Date.now() - conv.updatedAt > this.ttlMs;
  }
}
