import { config } from "../config.ts";
import { extractIntake } from "../leads/intake.ts";
import { LeadsService } from "../leads/service.ts";
import { type IntakeFields, isIntakeComplete } from "../leads/templates.ts";
import { extractVisaDocs, type VisaFields } from "../leads/visa-docs.ts";
import type { PhotoClass } from "../rag/vision.ts";
import type { ProcessInboundDeps } from "./webhook-types.ts";

/**
 * After each candidate message, refresh the lead's intake fields
 * (text-extracted via LLM + media counts via SQL) and auto-promote
 * when the 7-item checklist is complete. Idempotent — re-running on
 * the same conversation just re-merges the same fields.
 *
 * Promotion rules:
 *   - if no lead exists yet: create one in intake_pending
 *   - update lead.intake_json with the merged IntakeFields
 *   - when isIntakeComplete && state == intake_pending:
 *       transition → intake_complete
 *       post lead card to LEADS_CHAT_ID (if configured)
 *       send "ждите, отправили запрос в клуб" to candidate
 *
 * Skips entirely when RAG isn't configured (no LLM = no extraction).
 */
export async function runIntakeUpdate(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag) return;

  // When an ops chat is configured, auto-create a lead for every candidate
  // so intake tracking kicks in from the first message. Without an ops chat,
  // only extract intake for leads that were manually promoted by the operator
  // (so the admin UI fields stay up-to-date even without LEADS_CHAT_ID).
  let lead = await d.leads.byUserId(d.user.id);
  if (!lead) {
    if (d.leadsChatId == null) return;
    lead = await d.leads.ensureForUser(d.user.id);
  }

  // Stop updating once the operator has made a final decision — approved,
  // rejected, submitted, or lost leads are operator-owned and extraction
  // could overwrite manual edits. intake_pending and intake_complete are
  // still "in progress" so we keep extracting.
  if (lead.state !== "intake_pending" && lead.state !== "intake_complete") return;

  const recent = await d.messages.recentForContext(d.conv.id, 30);
  const messagesForLlm = recent
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    }));

  const mediaCounts = await d.messages.countMediaForConversation(d.conv.id);
  // When vision classification is enabled, feed per-category photo counts
  // so passport detection is real instead of the ">=7 photos" heuristic.
  // But only once vision has actually classified something: with vision on
  // yet no result yet (missing OPENROUTER_API_KEY, a transient API failure,
  // or an unclassified backlog) countPhotosByClass returns all-zeros, which
  // would strand passport detection forever. Leaving photoClasses undefined
  // makes extractIntake fall back to the heuristic until vision catches up.
  let photoClasses: Record<PhotoClass, number> | undefined;
  if (config.vision.enabled) {
    const counts = await d.messages.countPhotosByClass(d.conv.id);
    if (counts.passport + counts.full_body + counts.portrait + counts.other > 0) {
      photoClasses = counts;
    }
  }

  const existing = parseIntakeJson(lead.intake_json);
  const intake = await extractIntake({
    messages: messagesForLlm,
    chat: d.rag.chat,
    mediaCounts,
    ...(photoClasses ? { photoClasses } : {}),
    ...(existing ? { existingIntake: existing } : {}),
  });

  await d.leads.setIntake(lead.id, JSON.stringify(intake));

  // Auto-promote + post ops card only when all conditions met:
  // 1. intake is complete, 2. lead was in intake_pending (not already promoted),
  // 3. an ops chat is configured to post the card to.
  if (!isIntakeComplete(intake) || lead.state !== "intake_pending" || d.leadsChatId == null) return;

  const promoted = await d.leads.setState(lead.id, "intake_complete");
  if (!promoted) return;

  const service = new LeadsService({
    leads: d.leads,
    users: d.users,
    conversations: d.conversations,
    messages: d.messages,
    telegram: d.telegram,
    leadsChatId: d.leadsChatId ?? null,
    visaChatId: d.visaChatId ?? null,
  });
  const recentForCard = recent
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "human")
    .map((m) => ({ role: m.role, text: m.text }));
  const withCard = await service.postCardToOpsChat({
    lead: promoted,
    user: d.user,
    recentMessages: recentForCard,
  });
  await service.sendAwaitingApprovalNote({ user: d.user });
  console.log(
    `[leads] auto-promoted lead ${promoted.id} (user ${d.user.id}) on intake completion` +
      (withCard.ops_message_id ? ` (card msg=${withCard.ops_message_id})` : ""),
  );
}

function parseIntakeJson(raw: string | null): IntakeFields | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as IntakeFields;
  } catch {
    return undefined;
  }
}

/**
 * After each candidate message during the docs collection phase,
 * extract structured visa-application fields from the conversation
 * and accumulate them in `lead.visa_docs_json`. Operator's manual
 * edits via PATCH /admin/api/leads/:id/visa-docs are preserved
 * because the LLM extractor only returns NEWLY-mentioned fields
 * (existing values stay intact when not re-mentioned).
 *
 * Same gating as runIntakeUpdate: requires LEADS_CHAT_ID configured
 * (without an ops chat, the parsing is busy work). Skipped when the
 * lead isn't in `docs_pending` — operator owns the lead in approved/
 * docs_complete/submitted/rejected states.
 */
export async function runVisaDocsUpdate(d: ProcessInboundDeps): Promise<void> {
  if (!d.rag) return;
  if (d.leadsChatId == null) return;

  const lead = await d.leads.byUserId(d.user.id);
  if (!lead) return;
  if (lead.state !== "docs_pending") return;

  // Read recent messages from the conversation. The visa form is
  // typically sent by the candidate as one or two long messages, so
  // 30 turns of context is plenty (and a hard upper bound on cost).
  const recent = await d.messages.recentForContext(d.conv.id, 30);
  const messagesForLlm = recent
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    }));

  const existing = parseVisaDocsJson(lead.visa_docs_json);
  const merged = await extractVisaDocs({
    messages: messagesForLlm,
    chat: d.rag.chat,
    ...(existing ? { existingDocs: existing } : {}),
  });

  // Only persist when the merge produced any change at all — avoids
  // bumping updated_at + WS noise on every silent turn.
  const before = JSON.stringify(existing ?? {});
  const after = JSON.stringify(merged);
  if (before !== after) {
    await d.leads.setVisaDocs(lead.id, after);
  }
}

function parseVisaDocsJson(raw: string | null): VisaFields | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as VisaFields;
  } catch {
    return undefined;
  }
}
