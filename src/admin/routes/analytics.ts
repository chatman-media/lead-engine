import { json, type RouteHandler } from "../../router.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Analytics (per-turn telemetry aggregates) ─────────────────────────

const WINDOW_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

interface PathRow {
  path: string;
  count: number;
}
interface TopicRow {
  topic: string;
  count: number;
}
interface LatencyRow {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  count: number;
}

/**
 * Aggregates per-turn RAG telemetry stored in `messages.meta_json`. Used by
 * the admin /admin/analytics page so operators can see retrieval quality,
 * latency, and the no_context / ungrounded rate over a rolling window
 * (1h / 24h / 7d / 30d, default 24h).
 *
 * All extraction goes through `json_extract(meta_json, '$.telemetry.…')`
 * so this is one SQL pass per metric — no in-memory parsing of every
 * row's full meta blob. Indexes already exist on `created_at`.
 */
export function createAnalyticsHandler(deps: AdminApiDeps): RouteHandler {
  return async ({ req, url }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;

    const windowKey = url.searchParams.get("window") ?? "24h";
    const windowSec = WINDOW_SECONDS[windowKey];
    if (windowSec === undefined) {
      return json(
        {
          error: `bad window — supported: ${Object.keys(WINDOW_SECONDS).join(", ")}`,
        },
        { status: 400 },
      );
    }
    const since = Math.floor(Date.now() / 1000) - windowSec;

    // Total assistant messages with telemetry in window. We scope to
    // role='assistant' because user messages don't carry telemetry.
    const [totalRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND meta_json IS NOT NULL
    `;
    const total = totalRow?.n ?? 0;

    // Per-path breakdown (smalltalk / persona_fact / no_context / ungrounded / ok).
    const byPath = await deps.sql<PathRow[]>`
      SELECT (meta_json::jsonb)->'telemetry'->>'path' AS path,
             COUNT(*)::INTEGER AS count
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND meta_json IS NOT NULL
        AND (meta_json::jsonb)->'telemetry'->>'path' IS NOT NULL
      GROUP BY path
      ORDER BY count DESC
    `;

    // Latency aggregates — total / retrieval / generation. We compute
    // approximate percentiles by ranking. Cheap on the message-count
    // scale we'd ever see (<1M turns over any reasonable window).
    async function latencyFor(field: string): Promise<LatencyRow> {
      const rows = (
        await deps.sql<{ v: number }[]>`
        SELECT ((meta_json::jsonb)->'telemetry'->>${field})::NUMERIC AS v
        FROM messages
        WHERE role = 'assistant'
          AND created_at >= ${since}
          AND (meta_json::jsonb)->'telemetry'->>${field} IS NOT NULL
        ORDER BY v ASC
      `
      )
        .map((r) => Number(r.v))
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (rows.length === 0) {
        return { p50: null, p95: null, p99: null, avg: null, count: 0 };
      }
      const pick = (q: number) => rows[Math.min(rows.length - 1, Math.floor(rows.length * q))]!;
      const sum = rows.reduce((a, b) => a + b, 0);
      return {
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
        avg: Math.round(sum / rows.length),
        count: rows.length,
      };
    }

    const latency = {
      total_ms: await latencyFor("total_ms"),
      retrieval_ms: await latencyFor("retrieval_ms"),
      generation_ms: await latencyFor("generation_ms"),
    };

    // Topic distribution — which topics the classifier hit (only when
    // RAG_TOPIC_ROUTING was on for that turn).
    const byTopic = await deps.sql<TopicRow[]>`
      SELECT (meta_json::jsonb)->'telemetry'->>'topic' AS topic,
             COUNT(*)::INTEGER AS count
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND (meta_json::jsonb)->'telemetry'->>'topic' IS NOT NULL
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 20
    `;

    // Reflection ungrounded count (when reflect was on and dropped the answer).
    const [ungroundedRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND (meta_json::jsonb)->'telemetry'->'reflect'->>'grounded' = 'false'
    `;
    const ungrounded = ungroundedRow?.n ?? 0;

    // Hybrid retrieval usage rate.
    const [hybridRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND (meta_json::jsonb)->'telemetry'->>'hybrid' = 'true'
    `;
    const hybrid = hybridRow?.n ?? 0;

    // Query rewrites (when query_rewrite was on AND the heuristic flagged the turn).
    const [rewritesRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND (meta_json::jsonb)->'telemetry'->>'rewritten_query' IS NOT NULL
    `;
    const rewrites = rewritesRow?.n ?? 0;

    const noContextCount = (byPath.find((p) => p.path === "no_context")?.count ?? 0) + ungrounded;
    const unansweredRate = total > 0 ? noContextCount / total : 0;

    return json({
      window: windowKey,
      window_seconds: windowSec,
      since_unix: since,
      total_assistant_messages: total,
      by_path: byPath,
      by_topic: byTopic,
      latency,
      ungrounded_count: ungrounded,
      hybrid_count: hybrid,
      rewrite_count: rewrites,
      unanswered_rate: unansweredRate,
    });
  };
}
