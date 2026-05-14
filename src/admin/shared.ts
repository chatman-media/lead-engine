import type { Sql } from "../db/postgres.ts";
import { ConversationsRepo } from "../db/repos/conversations.ts";
import { type LeadRow, LeadsRepo } from "../db/repos/leads.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { SkillOutcomesRepo, StyleRatingsRepo } from "../db/repos/skill-outcomes.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { attributeLeadOutcome } from "../leads/outcome-attribution.ts";
import { LeadsService } from "../leads/service.ts";
import type { ChatClient } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import type { TelegramClient } from "../telegram/client.ts";

export interface AdminApiDeps {
  sql: Sql;
  telegram?: TelegramClient;
  /** When true, manual admin replies are routed through the userbot send queue
   *  so messages appear from Alina's personal account instead of the bot. */
  userbotEnabled?: boolean;
  /** Optional event hooks for the websocket layer (or other listeners). */
  onConversationChanged?: (conversationId: number) => void;
  onMessageSent?: (input: { conversationId: number; tgUserId: number }) => void;
  /** Group chat where lead cards are posted (mirrors config.telegram.leadsChatId). */
  leadsChatId?: number | null;
  /** Group chat where the visa-submission package is posted. */
  visaChatId?: number | null;
  /**
   * Optional LLM clients — required only by the style playground endpoint
   * (`POST /admin/api/styles/:id/playground`). When unset, the playground
   * returns 503 with a hint to configure LLM_PROVIDER. All other endpoints
   * work without this.
   */
  rag?: {
    chat: ChatClient;
    embedder: EmbeddingClient;
    topK?: number;
    maxDistance?: number;
  };
}

/**
 * In-memory bot-health cache. The `getMe` Telegram call is cheap but
 * the Status dashboard could be opened by multiple admins / refreshed
 * frequently — caching for ~60s avoids burning the rate limit just to
 * show a green dot. The cache is per-process (single Node-style
 * process; no Redis), so a deploy restart re-pings on first request.
 */
export type BotHealth =
  | {
      ok: true;
      bot_id: number;
      username: string | null;
      first_name: string | null;
      checked_at: number;
    }
  | { ok: false; error: string; checked_at: number };

let botHealthCache: BotHealth | null = null;
const BOT_HEALTH_TTL_SEC = 60;

/** Drop the cached bot-health probe — tests reset this between cases
 *  so a stub `getMe` from one test doesn't bleed into another. Safe to
 *  call from production code too; the next /status hit re-pings. */
export function __resetBotHealthCacheForTesting(): void {
  botHealthCache = null;
}

export async function readBotHealth(deps: AdminApiDeps): Promise<BotHealth> {
  const now = Math.floor(Date.now() / 1000);
  if (botHealthCache !== null && now - botHealthCache.checked_at < BOT_HEALTH_TTL_SEC) {
    return botHealthCache;
  }
  if (!deps.telegram) {
    return { ok: false, error: "telegram client not configured", checked_at: now };
  }
  try {
    const me = await deps.telegram.getMe();
    botHealthCache = {
      ok: true,
      bot_id: me.id,
      username: me.username ?? null,
      first_name: me.first_name ?? null,
      checked_at: now,
    };
    return botHealthCache;
  } catch (err) {
    botHealthCache = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      checked_at: now,
    };
    return botHealthCache;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Conversation export (Phase 3a).
//
// Operators want to download dialogues for offline review, dataset prep, or
// fine-tuning their own model on winning conversations. JSONL is the lingua
// franca: one "training example" per line, OpenAI fine-tune compatible.
//
// Two endpoints:
//   GET /admin/api/conversations/:id/export.jsonl       single conversation
//   GET /admin/api/conversations/export.jsonl?<filters>  bulk, ndjson stream
//
// Filters for bulk: style_id, experiment_id, user_status, mode, limit.
// ════════════════════════════════════════════════════════════════════════════

export interface ExportedTurn {
  role: "system" | "user" | "assistant" | "human";
  content: string;
  /** Funnel stage at the time this message was processed (sales engine only). */
  stage?: string | null;
}

export interface ExportedConversation {
  /** Stable id — the local conversation row id. */
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  user_status: string | null;
  mode: string;
  style_slug: string | null;
  experiment_slug: string | null;
  current_stage: string | null;
  created_at: number;
  /** OpenAI fine-tune compatible — one entry per turn, oldest-first. */
  messages: ExportedTurn[];
}

export interface ExportRow {
  conv_id: number;
  conv_mode: string;
  conv_created_at: number;
  conv_current_stage: string | null;
  user_id: number;
  tg_user_id: number;
  tg_username: string | null;
  user_status: string;
  style_id: number | null;
  style_slug: string | null;
  experiment_id: number | null;
  experiment_slug: string | null;
}

export interface ExportMessageRow {
  conversation_id: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
  stage: string | null;
  created_at: number;
}

export const EXPORT_BULK_LIMIT_MAX = 1000;
export const EXPORT_BULK_LIMIT_DEFAULT = 100;

/**
 * Build the per-conversation header (everything except messages) — shared by
 * single and bulk export. Joins users + styles + experiments so a downstream
 * data scientist can filter by slug without re-joining themselves.
 */
export async function buildExportHeaders(
  sql: Sql,
  ids: readonly number[],
): Promise<Map<number, ExportedConversation>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<ExportRow[]>`
    SELECT
      c.id              AS conv_id,
      c.mode            AS conv_mode,
      c.created_at      AS conv_created_at,
      c.current_stage   AS conv_current_stage,
      u.id              AS user_id,
      u.tg_user_id      AS tg_user_id,
      u.tg_username     AS tg_username,
      u.status          AS user_status,
      c.style_id        AS style_id,
      s.slug            AS style_slug,
      c.experiment_id   AS experiment_id,
      e.slug            AS experiment_slug
    FROM conversations c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN styles s ON s.id = c.style_id
    LEFT JOIN experiments e ON e.id = c.experiment_id
    WHERE c.id = ANY(${ids as number[]})
  `;

  const out = new Map<number, ExportedConversation>();
  for (const r of rows) {
    out.set(r.conv_id, {
      id: r.conv_id,
      tg_user_id: r.tg_user_id,
      tg_username: r.tg_username,
      user_status: r.user_status,
      mode: r.conv_mode,
      style_slug: r.style_slug,
      experiment_slug: r.experiment_slug,
      current_stage: r.conv_current_stage,
      created_at: r.conv_created_at,
      messages: [],
    });
  }
  return out;
}

/** Hydrate the message lists in-place. Single SELECT for all conversations. */
export async function fillExportMessages(
  sql: Sql,
  conversations: Map<number, ExportedConversation>,
): Promise<void> {
  if (conversations.size === 0) return;
  const ids = [...conversations.keys()];
  const rows = await sql<ExportMessageRow[]>`
    SELECT conversation_id, role, text, stage, created_at
    FROM messages
    WHERE conversation_id = ANY(${ids as number[]})
    ORDER BY conversation_id, created_at ASC, id ASC
  `;
  for (const r of rows) {
    const conv = conversations.get(r.conversation_id);
    if (!conv) continue;
    conv.messages.push({ role: r.role, content: r.text, stage: r.stage });
  }
}

export function jsonlResponse(lines: ExportedConversation[], filename: string): Response {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/jsonl; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // Hint to data-science clients that the format is one-conv-per-line.
      "x-export-format": "jsonl-conversations-v1",
      "x-export-count": String(lines.length),
    },
  });
}

export function parseIntParam(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Leads helpers (shared between leads.ts handlers + callback) ──────

export function buildLeadsService(deps: AdminApiDeps): LeadsService | null {
  if (!deps.telegram) return null;
  return new LeadsService({
    leads: new LeadsRepo(deps.sql),
    users: new UsersRepo(deps.sql),
    conversations: new ConversationsRepo(deps.sql),
    messages: new MessagesRepo(deps.sql),
    telegram: deps.telegram,
    leadsChatId: deps.leadsChatId ?? null,
    visaChatId: deps.visaChatId ?? null,
  });
}

export async function recentMessagesForCard(
  messages: MessagesRepo,
  conversationId: number,
): Promise<Array<{ role: string; text: string }>> {
  return (await messages.recentForContext(conversationId, 8))
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "human")
    .map((m) => ({ role: m.role, text: m.text }));
}

/**
 * Run skill-outcome attribution + ELO update for a lead that just hit
 * a terminal state. Idempotent (UNIQUE constraint on (lead, skill, source)
 * + applyOutcome conditional on fresh inserts) — safe to call after every
 * setState even when the new state isn't terminal. Errors are logged and
 * swallowed: attribution is analytics, not critical path.
 */
export function runAttribution(deps: AdminApiDeps, leadRow: LeadRow | null): void {
  if (!leadRow) return;
  attributeLeadOutcome(
    {
      db: deps.sql,
      outcomes: new SkillOutcomesRepo(deps.sql),
      ratings: new StyleRatingsRepo(deps.sql),
      messages: new MessagesRepo(deps.sql),
      conversations: new ConversationsRepo(deps.sql),
      styles: new StylesRepo(deps.sql),
    },
    leadRow,
  ).catch((err) => {
    console.warn("[attribution] failed for lead", leadRow.id, err);
  });
}
