// Operations / maintenance endpoints — surface common CLI scripts in the
// admin UI so operators don't need shell access for routine data tasks
// (re-ingest the KB after wipe, set/clear the Telegram webhook, seed
// default vacancies, drain the userbot queue, purge old analytics rows).
//
// Every endpoint runs synchronously inside the request lifetime. Long-
// running ones (KB re-ingest) stream their summary back as JSON; UI is
// expected to show a spinner.

import { resolve } from "node:path";
import { activeEmbeddingDim, config, llmIsConfigured } from "../../config.ts";
import { AuditLogRepo } from "../../db/repos/audit-log.ts";
import { KbRepo } from "../../db/repos/kb.ts";
import { MAX_SEND_ATTEMPTS } from "../../db/repos/userbot-send-queue.ts";
import { seedInfinityVacancies, VacanciesRepo } from "../../db/repos/vacancies.ts";
import { ingestDirectory } from "../../rag/ingest.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseJsonBody, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// Whitelisted ingest sources — accept only known KB roots so a request
// can't be coerced into walking the filesystem outside `kb/`. The repo
// ships markdown extracts of the operator's existing channel + chat
// archives alongside the human-curated FAQ; expose all of them so the
// admin UI can re-ingest each pile without redeploying.
const KB_INGEST_ROOTS: Record<string, { dir: string; defaultTopic?: string }> = {
  curated: { dir: "kb/curated" },
  books: { dir: "kb/books", defaultTopic: "books" },
  // Channel posts + dialog extracts pulled out of Telegram history. Mixed
  // topics — leave defaultTopic unset so each chunk picks one via the
  // regex classifier when RAG_TOPIC_ROUTING is on.
  extracted: { dir: "kb/extracted" },
  // Per-candidate chat dumps. Same mixed-topic rationale.
  chats: { dir: "kb/chats" },
};

interface IngestBody {
  source?: unknown;
  topic?: unknown;
  maxChars?: unknown;
  overlap?: unknown;
}

/**
 * POST /admin/api/ops/kb/ingest
 * Bulk-ingests every supported file under one of the whitelisted KB
 * source directories on disk into kb_documents / kb_chunks / kb_vec.
 * Idempotent: ingestFile dedupes by SHA-256.
 */
export function createKbIngestHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req }) => {
    if (!deps.rag?.embedder) {
      return json(
        { error: "embedder not configured — set OLLAMA_HOST or LLM_PROVIDER" },
        { status: 503 },
      );
    }
    if (!llmIsConfigured()) {
      return json({ error: "LLM provider not configured" }, { status: 503 });
    }

    const body = await parseJsonBody<IngestBody>(req);
    if (body instanceof Response) return body;
    const source = typeof body.source === "string" ? body.source : "curated";
    const root = KB_INGEST_ROOTS[source];
    if (!root) {
      return json(
        { error: `unknown source — choose one of: ${Object.keys(KB_INGEST_ROOTS).join(", ")}` },
        { status: 400 },
      );
    }

    // Embedder dim must match the column type the schema was created with —
    // otherwise insertChunkWithEmbedding will fail mid-walk and leave a
    // partially-ingested run.
    if (deps.rag.embedder.dim !== activeEmbeddingDim()) {
      return json(
        {
          error: `embedder dim ${deps.rag.embedder.dim} ≠ active dim ${activeEmbeddingDim()} (check OPENAI_EMBEDDING_DIM / OLLAMA_EMBEDDING_DIM)`,
        },
        { status: 500 },
      );
    }

    const topicOverride =
      typeof body.topic === "string" && body.topic.trim() ? body.topic.trim() : undefined;
    const chunkOpts: { maxChars?: number; overlapChars?: number } = {};
    if (typeof body.maxChars === "number" && body.maxChars >= 100)
      chunkOpts.maxChars = body.maxChars;
    if (typeof body.overlap === "number" && body.overlap >= 0)
      chunkOpts.overlapChars = body.overlap;

    const kb = new KbRepo(deps.sql);
    const ingestDeps: Parameters<typeof ingestDirectory>[1] = {
      kb,
      embedder: deps.rag.embedder,
      chunk: chunkOpts,
    };
    const topic = topicOverride ?? root.defaultTopic;
    if (topic !== undefined) ingestDeps.topic = topic;

    const dirAbs = resolve(process.cwd(), root.dir);
    const startedAt = Date.now();
    let summary: Awaited<ReturnType<typeof ingestDirectory>>;
    try {
      summary = await ingestDirectory(dirAbs, ingestDeps);
    } catch (err) {
      console.error("[ops] kb/ingest failed:", err);
      return json(
        { error: `ingest failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }

    return json({
      ok: true,
      source,
      dir: dirAbs,
      duration_ms: Date.now() - startedAt,
      summary,
      provider: config.llm.embeddingProvider,
      dim: activeEmbeddingDim(),
    });
  });
}

/**
 * POST /admin/api/ops/kb/wipe
 * Drops every row from kb_chunks + kb_documents. Requires
 * `confirm: "yes"` in the body to dodge accidental clicks.
 */
export function createKbWipeHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, admin }) => {
    let body: { confirm?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }
    if (body.confirm !== "yes") {
      return json({ error: 'send { "confirm": "yes" } to wipe the KB' }, { status: 400 });
    }
    const [chunksRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM kb_chunks
    `;
    const [docsRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM kb_documents
    `;
    await deps.sql`DELETE FROM kb_chunks`;
    await deps.sql`DELETE FROM kb_documents`;
    const deletedChunks = chunksRow?.n ?? 0;
    const deletedDocs = docsRow?.n ?? 0;
    // Audit-trail write is best-effort — if it fails the destructive
    // action still went through, so the response must be the success
    // body, not the audit error.
    await new AuditLogRepo(deps.sql)
      .write({
        action: "kb.wipe",
        adminId: admin.adminId,
        details: { deleted_chunks: deletedChunks, deleted_documents: deletedDocs },
      })
      .catch((err) => console.error("[audit] kb.wipe write failed:", err));
    return json({
      ok: true,
      deleted_chunks: deletedChunks,
      deleted_documents: deletedDocs,
    });
  });
}

// ─── Telegram webhook ──────────────────────────────────────────────────

/** GET /admin/api/ops/telegram/webhook → { url, pending_update_count } */
export function createGetTelegramWebhookHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async () => {
    if (!deps.telegram) return json({ error: "telegram client not configured" }, { status: 503 });
    try {
      const info = await deps.telegram.getWebhookInfo();
      return json({ info });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  });
}

/** PUT /admin/api/ops/telegram/webhook  body: { url, dropPending? } */
export function createSetTelegramWebhookHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req }) => {
    if (!deps.telegram) return json({ error: "telegram client not configured" }, { status: 503 });
    const body = await parseJsonBody<{ url?: unknown; dropPending?: unknown }>(req);
    if (body instanceof Response) return body;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url || !/^https:\/\//.test(url)) {
      return json({ error: "url must start with https://" }, { status: 400 });
    }
    try {
      await deps.telegram.setWebhook({
        url,
        secretToken: config.telegram.webhookSecret,
        dropPendingUpdates: body.dropPending === true,
      });
      const info = await deps.telegram.getWebhookInfo();
      return json({ ok: true, info });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  });
}

/** DELETE /admin/api/ops/telegram/webhook  body: { dropPending? } */
export function createDeleteTelegramWebhookHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, admin }) => {
    if (!deps.telegram) return json({ error: "telegram client not configured" }, { status: 503 });
    let body: { dropPending?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }
    try {
      await deps.telegram.deleteWebhook(body.dropPending === true);
      await new AuditLogRepo(deps.sql)
        .write({
          action: "telegram.webhook.delete",
          adminId: admin.adminId,
          details: { drop_pending: body.dropPending === true },
        })
        .catch((err) => console.error("[audit] telegram.webhook.delete write failed:", err));
      return json({ ok: true });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  });
}

// ─── Maintenance ───────────────────────────────────────────────────────

/** POST /admin/api/ops/vacancies/reseed — re-runs seedInfinityVacancies. */
export function createReseedVacanciesHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async () => {
    const repo = new VacanciesRepo(deps.sql);
    const result = await seedInfinityVacancies(repo);
    return json({ ok: true, ...result });
  });
}

interface PurgeBody {
  days?: unknown;
  dryRun?: unknown;
}

/**
 * POST /admin/api/ops/skill-outcomes/purge — deletes rows older than
 * `days` (default 90) from skill_outcomes + unreferenced self_play_matches.
 * Pairwise / shadow / coach rows are intentionally preserved (audit trail).
 */
export function createPurgeOutcomesHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, admin }) => {
    let body: PurgeBody;
    try {
      body = (await req.json()) as PurgeBody;
    } catch {
      body = {};
    }
    const days =
      typeof body.days === "number" && Number.isFinite(body.days) && body.days >= 1
        ? Math.floor(body.days)
        : 90;
    const dryRun = body.dryRun === true;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const [outcomesPending] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM skill_outcomes WHERE created_at < ${cutoff}
    `;
    const [matchesPending] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM self_play_matches m
      WHERE m.created_at < ${cutoff}
        AND m.id NOT IN (
          SELECT match_a_id FROM pairwise_matches WHERE match_a_id IS NOT NULL
          UNION
          SELECT match_b_id FROM pairwise_matches WHERE match_b_id IS NOT NULL
        )
    `;

    const willDelete = {
      skill_outcomes: outcomesPending?.n ?? 0,
      self_play_matches: matchesPending?.n ?? 0,
    };
    if (dryRun) {
      return json({
        ok: true,
        dry_run: true,
        cutoff_epoch: cutoff,
        days,
        would_delete: willDelete,
      });
    }

    if (willDelete.skill_outcomes > 0) {
      await deps.sql`DELETE FROM skill_outcomes WHERE created_at < ${cutoff}`;
    }
    if (willDelete.self_play_matches > 0) {
      await deps.sql`
        DELETE FROM self_play_matches
        WHERE created_at < ${cutoff}
          AND id NOT IN (
            SELECT match_a_id FROM pairwise_matches WHERE match_a_id IS NOT NULL
            UNION
            SELECT match_b_id FROM pairwise_matches WHERE match_b_id IS NOT NULL
          )
      `;
    }
    await new AuditLogRepo(deps.sql)
      .write({
        action: "skill_outcomes.purge",
        adminId: admin.adminId,
        details: { days, deleted: willDelete },
      })
      .catch((err) => console.error("[audit] skill_outcomes.purge write failed:", err));
    return json({ ok: true, days, deleted: willDelete });
  });
}

/**
 * POST /admin/api/ops/userbot/queue-stats — non-destructive snapshot of
 * the userbot send queue so operators can see how many manual replies
 * are still waiting for the userbot worker to pick up.
 *
 * `userbot_send_queue` has no `status` column; we derive one from
 * `sent_at` / `error` / `attempts` so the operator dashboard can show
 * the right buckets without a schema migration.
 */
export function createUserbotQueueStatsHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async () => {
    const rows = await deps.sql<{ status: string; count: number }[]>`
      SELECT
        CASE
          WHEN sent_at IS NOT NULL          THEN 'sent'
          WHEN attempts >= ${MAX_SEND_ATTEMPTS} THEN 'parked'
          WHEN error IS NOT NULL            THEN 'errored'
          ELSE                                   'pending'
        END AS status,
        COUNT(*)::INTEGER AS count
      FROM userbot_send_queue
      GROUP BY 1
    `;
    return json({
      by_status: Object.fromEntries(rows.map((r) => [r.status, r.count])),
      userbot_enabled: !!deps.userbotEnabled,
    });
  });
}
