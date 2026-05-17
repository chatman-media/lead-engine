import type { MessageRow } from "../db/repos/messages.ts";
import type { ChatMessage } from "../rag/chat.ts";
import { extractUserFacts } from "../rag/extract-user-facts.ts";
import type { ProcessInboundDeps } from "./webhook-types.ts";

/**
 * Hard cap on the number of messages handed to the extractor in one call.
 * Without it a candidate who hasn't been processed in a while (extractor
 * disabled then re-enabled, or the cursor got reset) hands the LLM 100+
 * messages at once — slow, expensive, and the model loses precision past
 * ~16 turns. Older facts are already accumulated in `stored.facts`.
 */
export const MAX_EXTRACTION_SLICE = 16;

/**
 * Messages newer than the cursor that are worth feeding the extractor:
 * candidate + bot turns only (system / human-operator turns are skipped).
 * Pure — exported for unit tests.
 */
export function selectFreshMessages(all: MessageRow[], sinceId: number): MessageRow[] {
  return all.filter((m) => m.id > sinceId && (m.role === "user" || m.role === "assistant"));
}

/**
 * Trim the fresh slice to the most recent `max` turns for the LLM call.
 * `lastId` is the last RAW fresh id (not the trimmed one) so older messages
 * skipped by the cap aren't reconsidered next turn. Returns null when there
 * is nothing fresh. Pure — exported for unit tests.
 */
export function sliceForExtraction(
  fresh: MessageRow[],
  max: number = MAX_EXTRACTION_SLICE,
): { slice: ChatMessage[]; lastId: number } | null {
  const last = fresh[fresh.length - 1];
  if (!last) return null;
  const trimmed = fresh.length > max ? fresh.slice(-max) : fresh;
  const slice: ChatMessage[] = trimmed.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  return { slice, lastId: last.id };
}

/**
 * Render the accumulated candidate facts into the lead's auto-facts note,
 * or null when there is nothing non-empty to show. Pure — exported for
 * unit tests.
 */
export function renderAutoFactsNote(facts: Record<string, string>): string | null {
  const lines = Object.entries(facts)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `• ${k}: ${v}`);
  return lines.length > 0 ? `Факты из разговора:\n${lines.join("\n")}` : null;
}

/**
 * Fire-and-forget fact extraction after a reply. We deliberately don't await
 * this in the hot path — extraction is a second LLM call, and blocking the
 * webhook on it would double our reply latency for a memory layer that only
 * matters NEXT turn anyway. Errors are logged and swallowed.
 */
export async function runMemoryExtraction(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag?.userMemory) return;

  const stored = await d.users.getMemory(d.user.id);
  const sinceId = stored.lastExtractedFromMsgId ?? 0;
  const all = await d.messages.listByConversation(d.conv.id, 200);
  const sliced = sliceForExtraction(selectFreshMessages(all, sinceId));
  if (!sliced) return;

  try {
    const newFacts = await extractUserFacts({
      messages: sliced.slice,
      chat: d.rag.chat,
      existingFacts: stored.facts,
    });
    if (Object.keys(newFacts).length > 0 || sliced.lastId !== sinceId) {
      await d.users.mergeMemoryFacts(d.user.id, newFacts, sliced.lastId);
    }
    if (Object.keys(newFacts).length > 0) {
      const lead = await d.leads.byUserId(d.user.id);
      if (lead) {
        const note = renderAutoFactsNote({ ...stored.facts, ...newFacts });
        if (note) await d.leads.upsertAutoFactsNote(lead.id, note);
      }
    }
  } catch (err) {
    console.error("[memory] extraction failed:", err);
  }
}
