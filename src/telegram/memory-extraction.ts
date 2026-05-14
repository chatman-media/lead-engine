import { extractUserFacts } from "../rag/extract-user-facts.ts";
import type { ProcessInboundDeps } from "./webhook-types.ts";

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
  const fresh = all.filter((m) => m.id > sinceId && (m.role === "user" || m.role === "assistant"));
  if (fresh.length === 0) return;

  // Hard-cap the slice fed to the extractor. Without this, a candidate who
  // hasn't been processed in a while (e.g. extractor was disabled then
  // re-enabled, or the cursor got reset) hands the LLM 100+ messages in one
  // call — slow, expensive, and the model loses precision past ~16 turns.
  // Trimming to the most recent N messages keeps cost bounded; older facts
  // are already accumulated in `stored.facts` from prior runs.
  const MAX_EXTRACTION_SLICE = 16;
  const slicedFresh =
    fresh.length > MAX_EXTRACTION_SLICE ? fresh.slice(-MAX_EXTRACTION_SLICE) : fresh;

  const slice = slicedFresh.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));
  // Cursor advances to the last RAW fresh message even when we trimmed —
  // skipped older messages would otherwise be re-considered next turn.
  const lastId = fresh[fresh.length - 1]!.id;

  try {
    const newFacts = await extractUserFacts({
      messages: slice,
      chat: d.rag.chat,
      existingFacts: stored.facts,
    });
    if (Object.keys(newFacts).length > 0 || lastId !== sinceId) {
      await d.users.mergeMemoryFacts(d.user.id, newFacts, lastId);
    }
    if (Object.keys(newFacts).length > 0) {
      const lead = await d.leads.byUserId(d.user.id);
      if (lead) {
        const allFacts = { ...stored.facts, ...newFacts };
        const lines = Object.entries(allFacts)
          .filter(([, v]) => v?.trim())
          .map(([k, v]) => `• ${k}: ${v}`);
        if (lines.length > 0) {
          await d.leads.upsertAutoFactsNote(lead.id, `Факты из разговора:\n${lines.join("\n")}`);
        }
      }
    }
  } catch (err) {
    console.error("[memory] extraction failed:", err);
  }
}
