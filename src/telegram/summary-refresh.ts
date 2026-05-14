import { summarizeConversation } from "../rag/summarize-conversation.ts";
import type { ProcessInboundDeps } from "./webhook-types.ts";

// Conversation summary refresh thresholds. Tunable via constants here, not
// env vars — these are quality knobs not deployment knobs, and they should
// stay coupled to RECENT_HISTORY_SIZE (12) used in runRagForInbound.
const SUMMARY_START_THRESHOLD = 30; // total messages before summary kicks in
const SUMMARY_RECENT_WINDOW = 12; // last N raw messages always go in prompt
const SUMMARY_STALENESS = 8; // refresh once we drift this many msgs past last summary

/**
 * Lazy summary refresh after a reply. Skipped on short conversations to
 * avoid LLM cost when a summary wouldn't help. Otherwise:
 *   - if no summary yet → summarize all but the recent window
 *   - if summary stale (gap to current latest > SUMMARY_STALENESS) → refresh
 *     by passing the previous summary + new chunk to the summarizer (refining,
 *     not re-summarizing the whole history)
 *
 * Fire-and-forget — errors logged, current turn already replied.
 */
export async function runConversationSummaryRefresh(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag?.conversationSummary) return;

  const all = await d.messages.listByConversation(d.conv.id, 500);
  if (all.length < SUMMARY_START_THRESHOLD) return;

  const stored = await d.conversations.getSummary(d.conv.id);
  const _latestId = all[all.length - 1]!.id;
  const lastSummarizedId = stored?.summarizedThroughMsgId ?? 0;

  // Anything strictly older than the recent window is fair game for the
  // summarizer. We add `+1` margin so the just-replied turn doesn't get
  // pulled in mid-stride.
  const summarizableTail = all.slice(0, all.length - SUMMARY_RECENT_WINDOW);
  if (summarizableTail.length === 0) return;

  const lastSummarizable = summarizableTail[summarizableTail.length - 1]!;
  const gap = lastSummarizable.id - lastSummarizedId;
  if (stored && gap < SUMMARY_STALENESS) return; // not stale enough yet

  // When refreshing: only feed the slice that's NEW since the previous
  // summary cutoff. Combined with `previousSummary` parameter the model
  // refines instead of re-reading everything.
  const newSlice = summarizableTail.filter(
    (m) =>
      m.id > lastSummarizedId &&
      (m.role === "user" || m.role === "assistant" || m.role === "human"),
  );
  if (newSlice.length === 0) return;

  const messages = newSlice.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));

  try {
    const summary = await summarizeConversation({
      messagesToSummarize: messages,
      chat: d.rag.chat,
      ...(stored?.summary ? { previousSummary: stored.summary } : {}),
    });
    if (summary.trim().length > 0) {
      await d.conversations.setSummary(d.conv.id, summary, lastSummarizable.id);
    }
    console.log(
      `[summary] conv=${d.conv.id} refreshed through msg=${lastSummarizable.id} (gap=${gap}, refined=${stored !== null})`,
    );
  } catch (err) {
    console.error("[summary] refresh failed:", err);
  }
}
