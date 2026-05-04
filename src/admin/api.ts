import type { Database } from "bun:sqlite";

import { activeEmbeddingDim, config } from "../config.ts";
import { ConversationsRepo } from "../db/repos/conversations.ts";
import {
  ExperimentsRepo,
  parseAllocationToExperiment,
  type ExperimentStatus,
  type SuccessMetric,
} from "../db/repos/experiments.ts";
import { KbRepo } from "../db/repos/kb.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { StylesRepo } from "../db/repos/styles.ts";
import { sanitizeLlmOutput } from "../rag/answer.ts";
import type { ChatClient, ChatMessage } from "../rag/chat.ts";
import type { EmbeddingClient } from "../rag/embed.ts";
import { composeSystemPrompt } from "../sales/prompt.ts";
import { nextStage } from "../sales/stage-router.ts";
import { FUNNEL_STAGES, StyleSchema, type FunnelStage } from "../sales/types.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { VacanciesRepo } from "../db/repos/vacancies.ts";
import { json, type RouteHandler } from "../router.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { requireAdmin } from "./auth.ts";

export interface AdminApiDeps {
  db: Database;
  telegram?: TelegramClient;
  /** Optional event hooks for the websocket layer (or other listeners). */
  onConversationChanged?: (conversationId: number) => void;
  onMessageSent?: (input: { conversationId: number; tgUserId: number }) => void;
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

export function createListUsersHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    return json({ users: users.list(500) });
  };
}

/**
 * Admin dashboard data: which RAG layers are enabled, which providers/models
 * are wired, KB stats by topic, and aggregate counts. Lets operators see at
 * a glance what's running without SSHing into the server.
 *
 * NEVER returns API keys or other secrets — only flags, model names, and
 * counts. Safe to render to any authenticated admin.
 */
export function createStatusHandler(deps: AdminApiDeps): RouteHandler {
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    // Provider config — names and dims only, no API keys.
    const chatProvider = config.llm.provider;
    const embedProvider = config.llm.embeddingProvider;
    const chatModel =
      chatProvider === "ollama"
        ? config.ollama.chatModel
        : chatProvider === "openrouter"
          ? config.openrouter.chatModel
          : config.openai.chatModel;
    const embedModel =
      embedProvider === "ollama"
        ? config.ollama.embeddingModel
        : config.openai.embeddingModel;

    // Active routing: env override > running experiment > legacy persona > none.
    const styles = new StylesRepo(deps.db);
    const experiments = new ExperimentsRepo(deps.db);
    const vacancies = new VacanciesRepo(deps.db);
    let routingMode: "env_override" | "running_experiment" | "legacy_persona" | "none";
    let activeStyleSlug: string | null = null;
    let runningExperimentSlug: string | null = null;
    if (config.sales.forcedStyleSlug) {
      routingMode = "env_override";
      activeStyleSlug = config.sales.forcedStyleSlug;
    } else {
      const running = experiments.getRunning();
      if (running) {
        routingMode = "running_experiment";
        runningExperimentSlug = running.slug;
      } else if (config.persona.name) {
        routingMode = "legacy_persona";
      } else {
        routingMode = "none";
      }
    }

    // KB stats grouped by topic. NULL groups together as "untagged" so the
    // UI can render them distinctly. Single CROSS JOIN for aggregate count.
    const kbByTopic = deps.db
      .query<
        { topic: string | null; documents: number; chunks: number },
        []
      >(
        `SELECT d.topic AS topic,
                COUNT(DISTINCT d.id) AS documents,
                COUNT(c.id) AS chunks
         FROM kb_documents d
         LEFT JOIN kb_chunks c ON c.document_id = d.id
         GROUP BY d.topic
         ORDER BY documents DESC, topic ASC`,
      )
      .all();
    const kbTotals = deps.db
      .query<{ documents: number; chunks: number }, []>(
        `SELECT (SELECT COUNT(*) FROM kb_documents) AS documents,
                (SELECT COUNT(*) FROM kb_chunks) AS chunks`,
      )
      .get()!;

    const convsByMode = deps.db
      .query<{ mode: string; count: number }, []>(
        `SELECT mode, COUNT(*) AS count FROM conversations GROUP BY mode`,
      )
      .all();
    const convTotal = convsByMode.reduce((s, r) => s + r.count, 0);

    const usersByStatus = deps.db
      .query<{ status: string; count: number }, []>(
        `SELECT status, COUNT(*) AS count FROM users GROUP BY status`,
      )
      .all();
    const usersTotal = usersByStatus.reduce((s, r) => s + r.count, 0);

    const messagesByRole = deps.db
      .query<{ role: string; count: number }, []>(
        `SELECT role, COUNT(*) AS count FROM messages GROUP BY role`,
      )
      .all();
    const messagesTotal = messagesByRole.reduce((s, r) => s + r.count, 0);

    // How many conversations have a long-conversation summary stored?
    // Useful signal for whether RAG_CONVERSATION_SUMMARY is actually doing
    // anything on this corpus.
    const summarizedConvs = deps.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM conversations WHERE summary_json IS NOT NULL`,
      )
      .get()!.count;

    // How many users have memory facts extracted? Same diagnostic value
    // for RAG_USER_MEMORY.
    const usersWithMemory = deps.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM users
         WHERE profile_json IS NOT NULL
           AND json_extract(profile_json, '$.memory.facts') IS NOT NULL`,
      )
      .get()!.count;

    return json({
      rag: {
        userMemory: config.rag.userMemory,
        queryRewrite: config.rag.queryRewrite,
        reflect: config.rag.reflect,
        hybridSearch: config.rag.hybridSearch,
        conversationSummary: config.rag.conversationSummary,
        topicRouting: config.rag.topicRouting,
        topK: config.rag.topK,
        maxDistance: config.rag.maxDistance ?? null,
      },
      providers: {
        chat: { provider: chatProvider, model: chatModel },
        embed: { provider: embedProvider, model: embedModel, dim: activeEmbeddingDim() },
      },
      routing: {
        mode: routingMode,
        active_style_slug: activeStyleSlug,
        running_experiment_slug: runningExperimentSlug,
        legacy_persona: routingMode === "legacy_persona"
          ? {
              name: config.persona.name,
              role: config.persona.role,
              company: config.persona.company || null,
            }
          : null,
        stage_classifier: config.sales.stageClassifier,
      },
      kb: {
        documents: kbTotals.documents,
        chunks: kbTotals.chunks,
        by_topic: kbByTopic,
        // Number of active styles seeded in DB (just count for UI hint).
        styles: styles.listActive().length,
      },
      conversations: {
        total: convTotal,
        by_mode: Object.fromEntries(convsByMode.map((r) => [r.mode, r.count])),
        with_summary: summarizedConvs,
      },
      users: {
        total: usersTotal,
        by_status: Object.fromEntries(usersByStatus.map((r) => [r.status, r.count])),
        with_memory: usersWithMemory,
      },
      messages: {
        total: messagesTotal,
        by_role: Object.fromEntries(messagesByRole.map((r) => [r.role, r.count])),
      },
      vacancies: {
        active: vacancies.countActive(),
      },
    });
  };
}

export function createListConversationsHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const url = new URL(req.url);
    const onlyEscalated = url.searchParams.get("escalated") === "1";
    return json({
      conversations: conversations
        .list({ onlyEscalated, limit: 200 })
        .map((row) => ({
          id: row.id,
          mode: row.mode,
          escalated_at: row.escalated_at,
          last_message_at: row.last_message_at,
          assigned_admin_id: row.assigned_admin_id,
          user: {
            id: row.user_id,
            tg_user_id: row.tg_user_id,
            tg_username: row.tg_username,
          },
        })),
    });
  };
}

export function createConversationDetailHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  const users = new UsersRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    const user = users.byId(conv.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });
    // Cross-session memory pulled from `users.profile_json.memory`. Always
    // included — when memory extraction is off (RAG_USER_MEMORY=false) this
    // is `{ facts: {} }` and the UI just shows an empty pane. Keeping the
    // shape stable on/off avoids a frontend feature flag.
    const memory = users.getMemory(user.id);
    // Long-conversation summary (RAG_CONVERSATION_SUMMARY). Null when the
    // chat is too short to have triggered summarization yet, which the UI
    // handles by hiding the summary pane.
    const summary = conversations.getSummary(id);
    return json({
      conversation: conv,
      user,
      messages: messages.listByConversation(id, 200),
      memory,
      summary,
    });
  };
}

/**
 * Operator override of extracted candidate facts. Used when the LLM
 * extractor mis-attributes ("intent: путешествие" instead of "работа") —
 * operator edits replace stored memory wholesale (no merge), then the
 * next bot turn picks them up via the standard `getMemory` read path.
 */
export function createUpdateUserMemoryHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const users = new UsersRepo(deps.db);
  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    const user = users.byId(id);
    if (!user) return json({ error: "not found" }, { status: 404 });

    let body: { facts?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    if (
      typeof body.facts !== "object" ||
      body.facts === null ||
      Array.isArray(body.facts)
    ) {
      return json({ error: "facts must be an object" }, { status: 400 });
    }

    // Coerce: accept any-typed values from JSON (string|number|bool) and
    // normalize to string. Reject keys/values longer than reasonable —
    // memory is for facts, not pasted essays.
    const incoming = body.facts as Record<string, unknown>;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof k !== "string") continue;
      const trimmedKey = k.trim();
      if (!trimmedKey || trimmedKey.length > 40) continue;
      if (v === null || v === undefined) continue;
      const str = typeof v === "string" ? v : String(v);
      const trimmed = str.trim();
      if (!trimmed || trimmed.length > 200) continue;
      cleaned[trimmedKey] = trimmed;
    }

    users.setMemoryFacts(id, cleaned);
    return json({ memory: users.getMemory(id) });
  };
}

export function createTakeHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    conversations.setMode(id, "human", ctx.adminId);
    deps.onConversationChanged?.(id);
    const updated = conversations.byId(id);
    return json({ conversation: updated });
  };
}

export function createReleaseHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    conversations.setMode(id, "ai");
    deps.onConversationChanged?.(id);
    const updated = conversations.byId(id);
    return json({ conversation: updated });
  };
}

export function createDeleteConversationHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    const ok = conversations.deleteById(id);
    if (!ok) return json({ error: "delete failed" }, { status: 500 });
    deps.onConversationChanged?.(id);
    return json({ ok: true, deleted: id });
  };
}

export function createReplyHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  const users = new UsersRepo(deps.db);

  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    if (conv.mode !== "human") {
      return json(
        { error: "conversation is not in human mode" },
        { status: 409 },
      );
    }

    let body: { text?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const text =
      typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text is required" }, { status: 400 });

    const user = users.byId(conv.user_id);
    if (!user) return json({ error: "user not found" }, { status: 404 });

    let tgMessageId: number | undefined;
    if (deps.telegram) {
      try {
        const sent = await deps.telegram.sendMessage({
          chatId: user.tg_user_id,
          text,
        });
        tgMessageId = sent.message_id;
      } catch (err) {
        console.error("[admin reply] Telegram send failed:", err);
      }
    }

    messages.add({
      conversationId: id,
      role: "human",
      text,
      tgMessageId,
    });
    conversations.touch(id);

    deps.onMessageSent?.({ conversationId: id, tgUserId: user.tg_user_id });

    return json({ ok: true, conversationId: id, tgUserId: user.tg_user_id });
  };
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

interface ExportedTurn {
  role: "system" | "user" | "assistant" | "human";
  content: string;
  /** Funnel stage at the time this message was processed (sales engine only). */
  stage?: string | null;
}

interface ExportedConversation {
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

interface ExportRow {
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

interface ExportMessageRow {
  conversation_id: number;
  role: "user" | "assistant" | "human" | "system";
  text: string;
  stage: string | null;
  created_at: number;
}

const EXPORT_BULK_LIMIT_MAX = 1000;
const EXPORT_BULK_LIMIT_DEFAULT = 100;

/**
 * Build the per-conversation header (everything except messages) — shared by
 * single and bulk export. Joins users + styles + experiments so a downstream
 * data scientist can filter by slug without re-joining themselves.
 */
function buildExportHeaders(
  db: Database,
  ids: readonly number[],
): Map<number, ExportedConversation> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<ExportRow, number[]>(
      `SELECT
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
       WHERE c.id IN (${placeholders})`,
    )
    .all(...ids);

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
function fillExportMessages(
  db: Database,
  conversations: Map<number, ExportedConversation>,
): void {
  if (conversations.size === 0) return;
  const ids = [...conversations.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<ExportMessageRow, number[]>(
      `SELECT conversation_id, role, text, stage, created_at
       FROM messages
       WHERE conversation_id IN (${placeholders})
       ORDER BY conversation_id, created_at ASC, id ASC`,
    )
    .all(...ids);
  for (const r of rows) {
    const conv = conversations.get(r.conversation_id);
    if (!conv) continue;
    conv.messages.push({ role: r.role, content: r.text, stage: r.stage });
  }
}

function jsonlResponse(lines: ExportedConversation[], filename: string): Response {
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

export function createExportConversationHandler(deps: AdminApiDeps): RouteHandler {
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    const headers = buildExportHeaders(deps.db, [id]);
    if (headers.size === 0) return json({ error: "not found" }, { status: 404 });
    fillExportMessages(deps.db, headers);

    const conv = [...headers.values()][0]!;
    return jsonlResponse([conv], `conversation-${id}.jsonl`);
  };
}

export function createBulkExportConversationsHandler(
  deps: AdminApiDeps,
): RouteHandler {
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    const url = new URL(req.url);
    const styleId = parseIntParam(url.searchParams.get("style_id"));
    const experimentId = parseIntParam(url.searchParams.get("experiment_id"));
    const userStatus = url.searchParams.get("user_status")?.trim() || null;
    const mode = url.searchParams.get("mode")?.trim() || null;
    const requestedLimit = parseIntParam(url.searchParams.get("limit"));
    const limit = Math.min(
      Math.max(1, requestedLimit ?? EXPORT_BULK_LIMIT_DEFAULT),
      EXPORT_BULK_LIMIT_MAX,
    );

    // Build a parameterized WHERE so we never interpolate user input.
    const wheres: string[] = [];
    const args: Array<number | string> = [];
    if (styleId !== null) {
      wheres.push("c.style_id = ?");
      args.push(styleId);
    }
    if (experimentId !== null) {
      wheres.push("c.experiment_id = ?");
      args.push(experimentId);
    }
    if (userStatus) {
      wheres.push("u.status = ?");
      args.push(userStatus);
    }
    if (mode) {
      wheres.push("c.mode = ?");
      args.push(mode);
    }
    const whereClause = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

    const ids = deps.db
      .query<{ id: number }, Array<number | string>>(
        `SELECT c.id
         FROM conversations c
         JOIN users u ON u.id = c.user_id
         ${whereClause}
         ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
         LIMIT ${limit}`,
      )
      .all(...args)
      .map((r) => r.id);

    const headers = buildExportHeaders(deps.db, ids);
    fillExportMessages(deps.db, headers);

    // Preserve the order from the SELECT (most recent first).
    const out = ids
      .map((id) => headers.get(id))
      .filter((c): c is ExportedConversation => c !== undefined);

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return jsonlResponse(out, `conversations-${stamp}.jsonl`);
  };
}

function parseIntParam(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// ════════════════════════════════════════════════════════════════════════════
// Sales-style engine admin API (Phase 2b).
//
// Endpoints:
//   GET  /admin/api/styles                    list active styles
//   GET  /admin/api/styles/:id                full row including parsed config
//   GET  /admin/api/experiments               list all experiments
//   POST /admin/api/experiments               create draft experiment
//   PATCH /admin/api/experiments/:id          set status (draft|running|paused|done)
//   GET  /admin/api/experiments/:id/funnel    per-style conversion aggregates
//
// All require admin auth (same `requireAdmin` gate as everything else here).
// ════════════════════════════════════════════════════════════════════════════

const VALID_EXPERIMENT_STATUSES: readonly ExperimentStatus[] = [
  "draft",
  "running",
  "paused",
  "done",
];
const VALID_SUCCESS_METRICS: readonly SuccessMetric[] = [
  "qualified",
  "won",
  "replied_3+",
];

export function createListStylesHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const rows = styles.listActive().map((row) => ({
      id: row.id,
      slug: row.slug,
      display_name: row.display_name,
      version: row.version,
      parent_id: row.parent_id,
      is_active: row.is_active === 1,
      created_at: row.created_at,
    }));
    return json({ styles: rows });
  };
}

export function createGetStyleHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const row = styles.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });
    let parsedConfig: unknown = null;
    let parseError: string | null = null;
    try {
      parsedConfig = styles.parseRow(row);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    return json({
      style: {
        id: row.id,
        slug: row.slug,
        display_name: row.display_name,
        version: row.version,
        parent_id: row.parent_id,
        is_active: row.is_active === 1,
        created_at: row.created_at,
        config: parsedConfig,
        config_raw: row.config_json,
        parse_error: parseError,
      },
    });
  };
}

interface PlaygroundBody {
  userMessage?: unknown;
  /** Optional override; if absent, stage is auto-detected from the message. */
  stage?: unknown;
  /**
   * Whether to do a KB pre-search and inject hits into the prompt.
   * Default true — mirrors webhook behavior. Set false to see what the
   * model produces without grounding (useful for stylistic-only checks).
   */
  useKb?: unknown;
  /** Whether to drop the few-shot block (mirrors turn-2+ behavior). */
  dropFewShot?: unknown;
}

const FUNNEL_STAGE_SET: ReadonlySet<string> = new Set(FUNNEL_STAGES);

/**
 * POST /admin/api/styles/:id/playground — dry-run a style against a user
 * message, no DB writes, no Telegram traffic. Returns:
 *   - the resolved stage (auto-detected unless overridden)
 *   - the KB hits that would have been injected (or empty array)
 *   - the full composed system prompt (so operator can sanity-check)
 *   - the model's reply
 *   - duration_ms (so operator can budget against their hardware)
 *
 * This is the "save and pray" antidote: edit a style, click Run with a
 * sample prospect message, see what comes back BEFORE versioning the row.
 */
export function createStylePlaygroundHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.db);
  const kb = new KbRepo(deps.db);
  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    if (!deps.rag) {
      return json(
        {
          error:
            "playground requires LLM to be configured (LLM_PROVIDER + a chat/embed client). Server started without it.",
        },
        { status: 503 },
      );
    }

    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const row = styles.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });

    let style;
    try {
      style = styles.parseRow(row);
    } catch (err) {
      return json(
        { error: `style config_json fails StyleSchema: ${err instanceof Error ? err.message : String(err)}` },
        { status: 422 },
      );
    }

    let body: PlaygroundBody;
    try {
      body = (await req.json()) as PlaygroundBody;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const userMessage =
      typeof body.userMessage === "string" ? body.userMessage.trim() : "";
    if (!userMessage) {
      return json({ error: "userMessage is required" }, { status: 400 });
    }

    const stageOverride =
      typeof body.stage === "string" && FUNNEL_STAGE_SET.has(body.stage)
        ? (body.stage as FunnelStage)
        : null;
    const stage: FunnelStage =
      stageOverride ??
      nextStage({
        // Treat playground as a fresh conversation: turn 1, no prior stage.
        // Operator can pin stage via `body.stage` if testing later-funnel turns.
        turnNumber: 1,
        currentStage: null,
        lastUserMessage: userMessage,
      });

    const useKb = body.useKb !== false; // default true
    const dropFewShot = body.dropFewShot === true; // default false

    // Replicate the webhook's RAG pipeline inline (intentionally NOT calling
    // answerWithRag) so we can:
    //   - return the composed system prompt for the operator to inspect;
    //   - skip the NO_CONTEXT_MARKER escalation behavior — playground runs
    //     the LLM unconditionally so the operator can see what the model
    //     produces even without KB grounding.
    const startedAt = Date.now();

    let kbHits: Array<{
      chunk_id: number;
      title: string;
      text: string;
      distance: number;
    }> = [];
    let kbContext: string | null = null;

    if (useKb) {
      try {
        const [vec] = await deps.rag.embedder.embed([userMessage]);
        if (vec) {
          const topK = deps.rag.topK ?? 5;
          const all = kb.search(vec, topK);
          const filtered =
            deps.rag.maxDistance === undefined
              ? all
              : all.filter((h) => h.distance <= deps.rag.maxDistance!);
          kbHits = filtered.map((h) => ({
            chunk_id: h.chunk_id,
            title: h.title,
            text: h.text,
            distance: h.distance,
          }));
          if (filtered.length > 0) {
            kbContext = filtered
              .map(
                (h, i) =>
                  `[#${i + 1}] (source: ${h.title})\n${h.text}`,
              )
              .join("\n\n");
          }
        }
      } catch (err) {
        return json(
          {
            error: `embedder/KB lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          { status: 502 },
        );
      }
    }

    const systemPrompt = composeSystemPrompt(style, stage, kbContext, {
      includeFewShot: !dropFewShot,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    let reply: string;
    try {
      const raw = await deps.rag.chat.complete(messages, {
        temperature: style.model.temperature,
      });
      reply = sanitizeLlmOutput(raw);
    } catch (err) {
      return json(
        {
          error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 502 },
      );
    }

    const durationMs = Date.now() - startedAt;

    return json({
      stage,
      stage_source: stageOverride ? "override" : "auto",
      kb_hits: kbHits,
      system_prompt: systemPrompt,
      reply,
      duration_ms: durationMs,
      model: { id: style.model.id, temperature: style.model.temperature },
    });
  };
}

/**
 * POST /admin/api/styles — create a fresh sales style from scratch.
 *
 * Used by the "Clone from existing" UI flow: operator picks a template style,
 * tweaks the JSON (slug, displayName, persona name, voice, hooks, …), saves.
 * Resulting row is version=1, parent_id=null, is_active=1 — its own root of a
 * new version chain.
 *
 * Slug uniqueness: enforced against ACTIVE rows only. A historical
 * (deactivated) row with the same slug is fine — that means the slug was
 * once used and edited many times; the chain is terminated and now the slug
 * can be reused. This is not great practice but the CHECK lets operators
 * recover from accidental deactivation without DB surgery.
 */
export function createCreateStyleHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.db);
  return async ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    let body: { config?: unknown };
    try {
      body = (await req.json()) as { config?: unknown };
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    if (typeof body.config !== "object" || body.config === null) {
      return json({ error: "body.config must be a Style object" }, { status: 400 });
    }

    const parsed = StyleSchema.safeParse(body.config);
    if (!parsed.success) {
      return json(
        {
          error: "config fails StyleSchema validation",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 },
      );
    }
    const config = parsed.data;

    // Refuse if there's already an ACTIVE style with this slug. Deactivated
    // rows with the same slug are tolerated (see comment block above).
    if (styles.bySlug(config.slug)) {
      return json(
        {
          error: `style with slug "${config.slug}" already exists. Edit the existing one or pick a different slug.`,
        },
        { status: 409 },
      );
    }

    const inserted = styles.insert({
      slug: config.slug,
      displayName: config.displayName,
      config,
      version: 1,
      parentId: null,
    });

    return json(
      {
        style: {
          id: inserted.id,
          slug: inserted.slug,
          display_name: inserted.display_name,
          version: inserted.version,
          parent_id: inserted.parent_id,
          is_active: inserted.is_active === 1,
          created_at: inserted.created_at,
          config,
          config_raw: inserted.config_json,
          parse_error: null,
        },
      },
      { status: 201 },
    );
  };
}

/**
 * PATCH /admin/api/styles/:id — save edit as a NEW version.
 *
 * The current row is deactivated (is_active=0); a new row is inserted with
 * version+1, parent_id pointing at the deactivated row. Conversations already
 * pinned to the old version keep seeing the prompt they started with.
 */
export function createEditStyleHandler(deps: AdminApiDeps): RouteHandler {
  const styles = new StylesRepo(deps.db);
  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    let body: { config?: unknown };
    try {
      body = (await req.json()) as { config?: unknown };
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    if (typeof body.config !== "object" || body.config === null) {
      return json({ error: "body.config must be a Style object" }, { status: 400 });
    }

    const parseResult = StyleSchema.safeParse(body.config);
    if (!parseResult.success) {
      return json(
        {
          error: "config fails StyleSchema validation",
          issues: parseResult.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 422 },
      );
    }

    let newRow;
    try {
      newRow = styles.editAsNewVersion(id, parseResult.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return json({ error: msg }, { status: 404 });
      }
      if (msg.includes("not active") || msg.includes("slug mismatch")) {
        return json({ error: msg }, { status: 409 });
      }
      throw err;
    }

    return json({
      style: {
        id: newRow.id,
        slug: newRow.slug,
        display_name: newRow.display_name,
        version: newRow.version,
        parent_id: newRow.parent_id,
        is_active: newRow.is_active === 1,
        created_at: newRow.created_at,
        config: parseResult.data,
        config_raw: newRow.config_json,
        parse_error: null,
      },
    });
  };
}

export function createListExperimentsHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const rows = experiments.list().map((row) => ({
      id: row.id,
      slug: row.slug,
      status: row.status,
      success_metric: row.success_metric,
      // Surface the allocation as an object so the UI doesn't have to parse JSON.
      allocation: safeJson(row.allocation_json),
      started_at: row.started_at,
      ended_at: row.ended_at,
      created_at: row.created_at,
    }));
    return json({ experiments: rows });
  };
}

interface CreateExperimentBody {
  slug?: unknown;
  status?: unknown;
  successMetric?: unknown;
  allocation?: unknown;
}

export function createCreateExperimentHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.db);
  const styles = new StylesRepo(deps.db);
  return async ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    let body: CreateExperimentBody;
    try {
      body = (await req.json()) as CreateExperimentBody;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }

    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) return json({ error: "slug is required" }, { status: 400 });
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return json({ error: "slug must be kebab-case" }, { status: 400 });
    }

    const status: ExperimentStatus =
      typeof body.status === "string" &&
      (VALID_EXPERIMENT_STATUSES as readonly string[]).includes(body.status)
        ? (body.status as ExperimentStatus)
        : "draft";

    const successMetric: SuccessMetric =
      typeof body.successMetric === "string" &&
      (VALID_SUCCESS_METRICS as readonly string[]).includes(body.successMetric)
        ? (body.successMetric as SuccessMetric)
        : "qualified";

    if (typeof body.allocation !== "object" || body.allocation === null) {
      return json(
        { error: "allocation must be an object {styleSlug: weight}" },
        { status: 400 },
      );
    }
    const allocation: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.allocation as Record<string, unknown>)) {
      if (typeof k !== "string" || k.length === 0) {
        return json({ error: `bad allocation key: ${k}` }, { status: 400 });
      }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return json(
          { error: `weight for "${k}" must be a non-negative number` },
          { status: 400 },
        );
      }
      // Verify the referenced style exists & is active. Otherwise the
      // experiment will silently allocate to a missing slug and graceful-
      // fallback to the legacy persona — nasty surprise during a real test.
      if (!styles.bySlug(k)) {
        return json(
          { error: `referenced style slug "${k}" not found or inactive` },
          { status: 400 },
        );
      }
      allocation[k] = v;
    }
    if (Object.keys(allocation).length === 0) {
      return json({ error: "allocation must have at least one variant" }, { status: 400 });
    }
    const totalWeight = Object.values(allocation).reduce((s, n) => s + n, 0);
    if (totalWeight <= 0) {
      return json({ error: "total allocation weight must be > 0" }, { status: 400 });
    }

    if (experiments.bySlug(slug)) {
      return json({ error: "experiment with this slug already exists" }, { status: 409 });
    }

    // Only one experiment may run at a time. If we're creating a 'running'
    // one and another is live, refuse — admin must pause/done the existing
    // one first.
    if (status === "running" && experiments.getRunning()) {
      return json(
        { error: "another experiment is already running; pause it first" },
        { status: 409 },
      );
    }

    const row = experiments.insert({ slug, status, allocation, successMetric });
    return json(
      {
        experiment: {
          id: row.id,
          slug: row.slug,
          status: row.status,
          success_metric: row.success_metric,
          allocation: safeJson(row.allocation_json),
          started_at: row.started_at,
          ended_at: row.ended_at,
          created_at: row.created_at,
        },
      },
      { status: 201 },
    );
  };
}

interface PatchExperimentBody {
  status?: unknown;
}

export function createSetExperimentStatusHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const experiments = new ExperimentsRepo(deps.db);
  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const row = experiments.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });

    let body: PatchExperimentBody;
    try {
      body = (await req.json()) as PatchExperimentBody;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const status = typeof body.status === "string" ? body.status : "";
    if (!(VALID_EXPERIMENT_STATUSES as readonly string[]).includes(status)) {
      return json(
        { error: `status must be one of ${VALID_EXPERIMENT_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    const newStatus = status as ExperimentStatus;
    if (newStatus === "running" && row.status !== "running") {
      const conflicting = experiments.getRunning();
      if (conflicting && conflicting.id !== id) {
        return json(
          {
            error: `another experiment is already running (id=${conflicting.id} slug=${conflicting.slug}); pause it first`,
          },
          { status: 409 },
        );
      }
      // Validate allocation before going live — saves a confusing fallback later.
      if (!parseAllocationToExperiment(row)) {
        return json(
          { error: "allocation_json is malformed; fix it before starting" },
          { status: 422 },
        );
      }
    }

    experiments.setStatus(id, newStatus);
    const updated = experiments.byId(id)!;
    return json({
      experiment: {
        id: updated.id,
        slug: updated.slug,
        status: updated.status,
        success_metric: updated.success_metric,
        allocation: safeJson(updated.allocation_json),
        started_at: updated.started_at,
        ended_at: updated.ended_at,
        created_at: updated.created_at,
      },
    });
  };
}

interface FunnelRow {
  style_id: number;
  slug: string;
  display_name: string;
  conversations: number;
  qualified: number;
  won: number;
  lost: number;
  pending: number;
  escalated_to_human: number;
}

export function createExperimentFunnelHandler(deps: AdminApiDeps): RouteHandler {
  const experiments = new ExperimentsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const row = experiments.byId(id);
    if (!row) return json({ error: "not found" }, { status: 404 });

    // Per-style aggregate. LEFT JOIN on conversations so styles that haven't
    // received any traffic yet still appear with zero counts (helps the UI
    // distinguish "nobody assigned" from "assigned, didn't qualify").
    const funnel = deps.db
      .query<FunnelRow, [number]>(
        `SELECT
           s.id AS style_id,
           s.slug AS slug,
           s.display_name AS display_name,
           COUNT(c.id) AS conversations,
           COALESCE(SUM(CASE WHEN u.status = 'qualified' THEN 1 ELSE 0 END), 0) AS qualified,
           COALESCE(SUM(CASE WHEN u.status = 'won' THEN 1 ELSE 0 END), 0) AS won,
           COALESCE(SUM(CASE WHEN u.status = 'lost' THEN 1 ELSE 0 END), 0) AS lost,
           COALESCE(SUM(CASE WHEN u.status IN ('new','questionnaire_pending') THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN c.mode = 'human' THEN 1 ELSE 0 END), 0) AS escalated_to_human
         FROM styles s
         LEFT JOIN conversations c
           ON c.style_id = s.id AND c.experiment_id = ?
         LEFT JOIN users u ON u.id = c.user_id
         WHERE s.id IN (
           SELECT DISTINCT style_id FROM conversations WHERE experiment_id = ?
           UNION
           SELECT s2.id FROM styles s2 WHERE s2.is_active = 1
         )
         GROUP BY s.id, s.slug, s.display_name
         ORDER BY conversations DESC, s.display_name`,
      )
      .all(id, id);

    return json({
      experiment_id: id,
      success_metric: row.success_metric,
      funnel: funnel.filter((r) => r.conversations > 0 || true), // include all rows for now
    });
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Vacancies (admin-managed list of currently-open offers) ───────────

const VACANCY_TITLE_MAX = 200;
const VACANCY_BODY_MAX = 4000;

export function createListVacanciesHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const url = new URL(req.url);
    // Default = all (operators want to see closed too, to re-enable);
    // ?active=1 narrows for any internal callers that need the same
    // shape the bot uses.
    const onlyActive = url.searchParams.get("active") === "1";
    const list = onlyActive ? vacancies.listActive() : vacancies.listAll();
    return json({ vacancies: list });
  };
}

export function createCreateVacancyHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.db);
  return async ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    let body: { title?: unknown; body?: unknown; is_active?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!title) return json({ error: "title is required" }, { status: 400 });
    if (!text) return json({ error: "body is required" }, { status: 400 });
    if (title.length > VACANCY_TITLE_MAX) {
      return json({ error: `title > ${VACANCY_TITLE_MAX}` }, { status: 400 });
    }
    if (text.length > VACANCY_BODY_MAX) {
      return json({ error: `body > ${VACANCY_BODY_MAX}` }, { status: 400 });
    }

    const created = vacancies.create({
      title,
      body: text,
      isActive: body.is_active === false ? false : true,
    });
    return json({ vacancy: created });
  };
}

export function createUpdateVacancyHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.db);
  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    let body: { title?: unknown; body?: unknown; is_active?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const patch: { title?: string; body?: string; isActive?: boolean } = {};
    if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (!trimmed) return json({ error: "title is empty" }, { status: 400 });
      if (trimmed.length > VACANCY_TITLE_MAX) {
        return json({ error: `title > ${VACANCY_TITLE_MAX}` }, { status: 400 });
      }
      patch.title = trimmed;
    }
    if (typeof body.body === "string") {
      const trimmed = body.body.trim();
      if (!trimmed) return json({ error: "body is empty" }, { status: 400 });
      if (trimmed.length > VACANCY_BODY_MAX) {
        return json({ error: `body > ${VACANCY_BODY_MAX}` }, { status: 400 });
      }
      patch.body = trimmed;
    }
    if (typeof body.is_active === "boolean") {
      patch.isActive = body.is_active;
    }
    const updated = vacancies.update(id, patch);
    if (!updated) return json({ error: "not found" }, { status: 404 });
    return json({ vacancy: updated });
  };
}

export function createDeleteVacancyHandler(deps: AdminApiDeps): RouteHandler {
  const vacancies = new VacanciesRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const ok = vacancies.delete(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true, deleted: id });
  };
}
