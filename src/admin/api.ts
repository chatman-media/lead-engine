import type { Database } from "bun:sqlite";

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
    return json({
      conversation: conv,
      user,
      messages: messages.listByConversation(id, 200),
    });
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
