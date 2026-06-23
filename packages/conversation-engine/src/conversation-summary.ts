import { type ChatClient, type ChatMessage, summarizeConversation } from "@chatman-media/kb";
import type { MessageRow, MessagesRepo } from "./dal/messages.ts";

export interface ConversationSummaryPayload {
  version: 1;
  summary: string;
  throughMessageId: number;
  updatedAt: number;
}

export interface RollingConversationContext {
  history: MessageRow[];
  conversationSummary?: string;
}

export interface RollingConversationSummaryOptions {
  recentWindow: number;
  summarizeAfterMessages?: number;
  summaryMaxChars?: number;
  maxMessagesToSummarize?: number;
}

type SummaryMessagesRepo = Pick<
  MessagesRepo,
  "recent" | "countByConversation" | "forConversationSummary"
>;

type SummaryConversationsRepo = {
  findById(conversationId: number): Promise<{ summaryJson: string | null } | null>;
  setSummaryJson(conversationId: number, summaryJson: string): Promise<void>;
};

export function messageRowsToChatHistory(
  history: readonly Pick<MessageRow, "role" | "text">[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant" || m.role === "human") {
      out.push({ role: "assistant", content: m.text });
    }
  }
  return out;
}

export function renderConversationSummaryBlock(summary?: string): string {
  const trimmed = summary?.trim();
  if (!trimmed) return "";
  return `ИЗ РАННЕЙ ПЕРЕПИСКИ (контекст уже обсуждённого, не повторяй буквально):\n${trimmed}`;
}

export function parseConversationSummaryPayload(
  raw: string | null | undefined,
): ConversationSummaryPayload | null {
  if (!raw?.trim()) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") {
      return legacySummaryPayload(parsed);
    }
    if (parsed && typeof parsed === "object") {
      const row = parsed as Record<string, unknown>;
      const summary = typeof row.summary === "string" ? row.summary.trim() : "";
      if (!summary) return null;
      const throughMessageId =
        typeof row.throughMessageId === "number" &&
        Number.isFinite(row.throughMessageId) &&
        row.throughMessageId > 0
          ? Math.floor(row.throughMessageId)
          : 0;
      const updatedAt =
        typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)
          ? Math.floor(row.updatedAt)
          : 0;
      return {
        version: 1,
        summary,
        throughMessageId,
        updatedAt,
      };
    }
  } catch {
    return legacySummaryPayload(raw);
  }

  return legacySummaryPayload(raw);
}

function legacySummaryPayload(summary: string): ConversationSummaryPayload | null {
  const trimmed = summary.trim();
  if (!trimmed) return null;
  return {
    version: 1,
    summary: trimmed,
    throughMessageId: 0,
    updatedAt: 0,
  };
}

function stringifySummaryPayload(payload: ConversationSummaryPayload): string {
  return JSON.stringify(payload);
}

function withoutCurrentMessage(
  rows: MessageRow[],
  current: { id?: number; text?: string },
): MessageRow[] {
  if (current.id !== undefined) {
    return rows.filter((row) => row.id !== current.id);
  }
  const text = current.text?.trim();
  if (!text) return rows;

  let idx = -1;
  for (let i = rows.length - 1; i >= 0 && idx < 0; i -= 1) {
    const row = rows[i];
    if (row?.role === "user" && row.text.trim() === text) {
      idx = i;
    }
  }
  if (idx < 0) return rows;
  return [...rows.slice(0, idx), ...rows.slice(idx + 1)];
}

function normalizeRecentWindow(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function summaryEnabled(threshold: number): boolean {
  return Number.isFinite(threshold) && threshold > 0;
}

function hasSummaryConversationsRepo(
  repo: SummaryConversationsRepo | null | undefined,
): repo is SummaryConversationsRepo {
  return (
    Boolean(repo) &&
    typeof repo?.findById === "function" &&
    typeof repo?.setSummaryJson === "function"
  );
}

export async function loadRollingConversationContext(input: {
  conversationId: number;
  messages: SummaryMessagesRepo;
  conversations?: SummaryConversationsRepo | null;
  chat: ChatClient;
  currentMessageId?: number;
  currentMessageText?: string;
  options: RollingConversationSummaryOptions;
  nowEpoch?: number;
  onWarn?: (message: string, error: unknown) => void;
}): Promise<RollingConversationContext> {
  const recentWindow = normalizeRecentWindow(input.options.recentWindow);
  const threshold = input.options.summarizeAfterMessages ?? 20;
  const conversations = hasSummaryConversationsRepo(input.conversations)
    ? input.conversations
    : null;
  const enabled = summaryEnabled(threshold) && Boolean(conversations);
  const recentLimit =
    recentWindow + (input.currentMessageId !== undefined || input.currentMessageText ? 1 : 0);

  const recentRows = await input.messages.recent(
    input.conversationId,
    Math.max(recentLimit, recentWindow),
  );
  const withoutCurrent = withoutCurrentMessage(recentRows, {
    ...(input.currentMessageId !== undefined ? { id: input.currentMessageId } : {}),
    ...(input.currentMessageText ? { text: input.currentMessageText } : {}),
  });
  const history = recentWindow > 0 ? withoutCurrent.slice(-recentWindow) : [];

  if (!enabled || !conversations) return { history };

  let conversation: { summaryJson: string | null } | null = null;
  let totalCount = 0;
  try {
    [conversation, totalCount] = await Promise.all([
      conversations.findById(input.conversationId),
      input.messages.countByConversation(input.conversationId),
    ]);
  } catch (err) {
    input.onWarn?.("[conversation-summary] failed to load summary snapshot", err);
    return { history };
  }

  const existing = parseConversationSummaryPayload(conversation?.summaryJson);
  let conversationSummary = existing?.summary;
  if (totalCount < threshold) {
    return { history, ...(conversationSummary ? { conversationSummary } : {}) };
  }

  const beforeMessageId = history[0]?.id ?? input.currentMessageId ?? null;
  if (!beforeMessageId) {
    return { history, ...(conversationSummary ? { conversationSummary } : {}) };
  }

  const maxMessagesToSummarize =
    input.options.maxMessagesToSummarize !== undefined
      ? Math.max(0, Math.floor(input.options.maxMessagesToSummarize))
      : 10_000;
  const oldRows = await input.messages.forConversationSummary(input.conversationId, {
    afterMessageId: existing?.throughMessageId ?? null,
    beforeMessageId,
    limit: maxMessagesToSummarize,
  });
  if (oldRows.length === 0) {
    return { history, ...(conversationSummary ? { conversationSummary } : {}) };
  }

  const freshSummary = await summarizeConversation({
    messagesToSummarize: messageRowsToChatHistory(oldRows),
    chat: input.chat,
    ...(conversationSummary ? { previousSummary: conversationSummary } : {}),
    maxLength: input.options.summaryMaxChars ?? 600,
  });
  if (!freshSummary.trim() || freshSummary === conversationSummary) {
    return { history, ...(conversationSummary ? { conversationSummary } : {}) };
  }

  const throughMessageId = oldRows[oldRows.length - 1]?.id;
  if (!throughMessageId) {
    return { history, ...(conversationSummary ? { conversationSummary } : {}) };
  }

  conversationSummary = freshSummary;
  const payload: ConversationSummaryPayload = {
    version: 1,
    summary: freshSummary,
    throughMessageId,
    updatedAt: input.nowEpoch ?? Math.floor(Date.now() / 1000),
  };

  try {
    await conversations.setSummaryJson(input.conversationId, stringifySummaryPayload(payload));
  } catch (err) {
    input.onWarn?.("[conversation-summary] failed to save summary", err);
  }

  return { history, conversationSummary };
}
