import type { Database } from "bun:sqlite";

import type { ConversationsRepo } from "../db/repos/conversations.ts";
import type { LeadRow } from "../db/repos/leads.ts";
import type { MessagesRepo } from "../db/repos/messages.ts";
import type {
  SkillOutcomeRow,
  SkillOutcomesRepo,
  StyleRatingsRepo,
} from "../db/repos/skill-outcomes.ts";
import type { StylesRepo } from "../db/repos/styles.ts";
import type { EloOutcome } from "../sales/elo.ts";

/**
 * Map a lead's terminal-ish state into an attribution outcome.
 *
 * - `docs_complete`  → won (bot's job done — visa team handoff happened)
 * - `submitted`      → won (consul filing confirmed; idempotency dedupes
 *                          if `docs_complete` already attributed)
 * - `rejected`       → draw (operator marked unfit; not the bot's fault)
 * - `closed`         → lost (ghosted / operator give-up)
 * - other states     → null (not terminal yet, no attribution)
 */
export function leadOutcome(lead: LeadRow): {
  outcome: EloOutcome;
  source: SkillOutcomeRow["source"];
} | null {
  if (lead.state === "docs_complete" || lead.state === "submitted") {
    return { outcome: "won", source: "lead_submitted" };
  }
  if (lead.state === "rejected") {
    return { outcome: "draw", source: "lead_rejected" };
  }
  if (lead.state === "closed") {
    return { outcome: "lost", source: "lead_ghosted" };
  }
  return null;
}

/** How many recent assistant messages we examine when extracting
 *  skills_used for attribution. Recent turns are most likely to be
 *  the cause of the outcome — older turns get progressively diluted. */
const ATTRIBUTION_WINDOW = 10;

interface MessageWithMeta {
  id: number;
  meta_json: string | null;
}

/**
 * Pull the union of `skills_used` from the last N assistant messages of
 * this lead's conversation. Each skill is attributed once even if it
 * appears in multiple messages — repeated use shouldn't be a force
 * multiplier on a single outcome.
 *
 * Returns a Map slug → most-recent-message-id so the outcome row can
 * link back to the specific reply that demonstrated the skill.
 */
function collectRecentSkills(messages: MessagesRepo, conversationId: number): Map<string, number> {
  const recent = messages
    .listByConversation(conversationId, 200)
    .filter((m) => m.role === "assistant")
    .slice(-ATTRIBUTION_WINDOW);
  const seen = new Map<string, number>();
  for (const m of recent as MessageWithMeta[]) {
    const slugs = parseSkillsUsed(m.meta_json);
    for (const slug of slugs) {
      // Last write wins → message_id points at the latest demonstration.
      seen.set(slug, m.id);
    }
  }
  return seen;
}

/** Robust JSON parse of `meta_json` → telemetry.skills_used array. */
function parseSkillsUsed(metaJson: string | null): string[] {
  if (!metaJson) return [];
  try {
    const parsed = JSON.parse(metaJson) as { telemetry?: { skills_used?: unknown } };
    const used = parsed.telemetry?.skills_used;
    if (!Array.isArray(used)) return [];
    return used.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/** Find the active style slug for a conversation: prefer pinned style_id,
 *  fall back to latest assistant message's stage/style metadata if any. */
function resolveStyleSlug(
  styles: StylesRepo,
  conversations: ConversationsRepo,
  conversationId: number,
): string | null {
  const conv = conversations.byId(conversationId);
  if (!conv?.style_id) return null;
  return styles.byId(conv.style_id)?.slug ?? null;
}

export interface AttributionDeps {
  db: Database;
  outcomes: SkillOutcomesRepo;
  ratings: StyleRatingsRepo;
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  styles: StylesRepo;
}

export interface AttributionResult {
  outcomesRecorded: number;
  styleRatingUpdated: boolean;
}

/**
 * The public entry point. Call this when a lead transitions into a
 * terminal state. Idempotent: re-running on the same (lead, state) is
 * a no-op thanks to the UNIQUE index on skill_outcomes.
 *
 * Side effects:
 *  - Inserts skill_outcome rows for every skill demonstrated in the last
 *    N assistant messages of the lead's conversation.
 *  - Updates style_ratings (ELO + W/L/D) for the active style.
 */
export function attributeLeadOutcome(d: AttributionDeps, lead: LeadRow): AttributionResult {
  const out = leadOutcome(lead);
  if (!out) return { outcomesRecorded: 0, styleRatingUpdated: false };

  // Find the conversation associated with this lead. Lead.user_id → any
  // conversation by user is a 1:1 in our schema.
  const conv = d.conversations.byUserId(lead.user_id);
  if (!conv) return { outcomesRecorded: 0, styleRatingUpdated: false };

  const styleSlug = resolveStyleSlug(d.styles, d.conversations, conv.id);
  const skillToMsgId = collectRecentSkills(d.messages, conv.id);

  let recorded = 0;
  for (const [slug, msgId] of skillToMsgId) {
    const inserted = d.outcomes.record({
      leadId: lead.id,
      conversationId: conv.id,
      messageId: msgId,
      styleSlug,
      skillSlug: slug,
      outcome: out.outcome,
      source: out.source,
    });
    if (inserted) recorded++;
  }

  // Style rating: only update once per (lead, source). Cheap proxy: if
  // we recorded zero new skill outcomes (meaning we already attributed
  // this lead before), skip the rating update. The first attribution
  // attempt drives the ELO move.
  let styleUpdated = false;
  if (styleSlug && recorded > 0) {
    d.ratings.applyOutcome(styleSlug, out.outcome);
    styleUpdated = true;
  }

  return { outcomesRecorded: recorded, styleRatingUpdated: styleUpdated };
}

export const _testHelpers = {
  parseSkillsUsed,
  collectRecentSkills,
  resolveStyleSlug,
  ATTRIBUTION_WINDOW,
};
