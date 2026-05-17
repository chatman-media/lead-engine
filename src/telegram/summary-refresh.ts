import type { MessageRow } from "../db/repos/messages.ts";
import type { ChatMessage } from "../rag/chat.ts";
import { summarizeConversation } from "../rag/summarize-conversation.ts";
import type { ProcessInboundDeps } from "./webhook-types.ts";

/**
 * Conversation summary refresh thresholds. Quality knobs, not deployment
 * knobs — kept as constants (coupled to RECENT_HISTORY_SIZE used in
 * runRagForInbound), not env vars.
 */
export interface SummaryThresholds {
  /** Total messages before a summary is worth the LLM cost. */
  startThreshold: number;
  /** Last N raw messages that always go into the prompt verbatim. */
  recentWindow: number;
  /** Refresh once we drift this many messages past the last summary. */
  staleness: number;
}

export const DEFAULT_SUMMARY_THRESHOLDS: SummaryThresholds = {
  startThreshold: 30,
  recentWindow: 12,
  staleness: 8,
};

/** Stored-summary shape consumed by the planner (subset of ConversationsRepo). */
export interface StoredSummary {
  summarizedThroughMsgId?: number;
  summary?: string;
}

export interface SummaryPlan {
  /** New messages to feed the summarizer (oldest first). */
  messages: ChatMessage[];
  /** Message id the summary will be current through. */
  throughId: number;
  /** True when refining an existing summary rather than creating the first. */
  refining: boolean;
}

/**
 * Decide whether — and what — to summarize. Pure: no I/O, fully unit-tested.
 * Returns null to skip (conversation too short, summary still fresh, or
 * nothing new since the last cutoff).
 */
export function planSummaryRefresh(
  all: MessageRow[],
  stored: StoredSummary | null,
  t: SummaryThresholds = DEFAULT_SUMMARY_THRESHOLDS,
): SummaryPlan | null {
  if (all.length < t.startThreshold) return null;

  const lastSummarizedId = stored?.summarizedThroughMsgId ?? 0;
  // Anything strictly older than the recent window is fair game.
  const summarizableTail = all.slice(0, all.length - t.recentWindow);
  const lastSummarizable = summarizableTail[summarizableTail.length - 1];
  if (!lastSummarizable) return null;

  const gap = lastSummarizable.id - lastSummarizedId;
  if (stored && gap < t.staleness) return null; // not stale enough yet

  // Only the slice that is NEW since the previous summary cutoff — combined
  // with `previousSummary` the model refines instead of re-reading all.
  const newSlice = summarizableTail.filter(
    (m) =>
      m.id > lastSummarizedId &&
      (m.role === "user" || m.role === "assistant" || m.role === "human"),
  );
  if (newSlice.length === 0) return null;

  return {
    messages: newSlice.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    })),
    throughId: lastSummarizable.id,
    refining: stored !== null,
  };
}

/**
 * Lazy summary refresh after a reply. Skipped on short conversations to
 * avoid LLM cost when a summary wouldn't help. Fire-and-forget — errors
 * logged, current turn already replied.
 */
export async function runConversationSummaryRefresh(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag?.conversationSummary) return;

  const all = await d.messages.listByConversation(d.conv.id, 500);
  const stored = await d.conversations.getSummary(d.conv.id);
  const plan = planSummaryRefresh(all, stored);
  if (!plan) return;

  try {
    const summary = await summarizeConversation({
      messagesToSummarize: plan.messages,
      chat: d.rag.chat,
      ...(stored?.summary ? { previousSummary: stored.summary } : {}),
    });
    if (summary.trim().length > 0) {
      await d.conversations.setSummary(d.conv.id, summary, plan.throughId);
    }
    console.log(
      `[summary] conv=${d.conv.id} refreshed through msg=${plan.throughId} (refined=${plan.refining})`,
    );
  } catch (err) {
    console.error("[summary] refresh failed:", err);
  }
}
