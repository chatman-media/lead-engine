import { LeadsRepo } from "../../db/repos/leads.ts";
import { json, type RouteHandler } from "../../router.ts";
import { withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// ─── Analytics (per-turn telemetry aggregates) ─────────────────────────

const WINDOW_SECONDS: Record<string, number> = {
  "1h": 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

// Trend bucket size per window — short windows bucket fine-grained so the
// chart still has several columns, long windows bucket by day.
const BUCKET_SECONDS: Record<string, number> = {
  "1h": 10 * 60,
  "24h": 60 * 60,
  "7d": 24 * 60 * 60,
  "30d": 24 * 60 * 60,
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
 * Aggregates per-turn RAG telemetry stored in `messages.meta_json` plus the
 * candidate funnel (`leads` / `lead_events`) and a time-bucketed activity
 * trend. Used by the admin /admin/analytics page so operators can see
 * retrieval quality, the no_context / ungrounded rate, the lead funnel and
 * daily volume over a rolling window (1h / 24h / 7d / 30d, default 24h).
 *
 * Telemetry extraction goes through `json_extract(meta_json, '$.telemetry.…')`
 * so this is one SQL pass per metric — no in-memory parsing of every
 * row's full meta blob. Indexes already exist on `created_at`.
 */
export function createAnalyticsHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ url }) => {
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
    const now = Math.floor(Date.now() / 1000);
    const since = now - windowSec;

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

    // Ungrounded count — turns the unified fact-checker dropped as not
    // grounded in the KB. The verdict lives in `telemetry.factCheck`
    // (the old separate `reflect` + `vacancy-guard` modules were merged).
    const [ungroundedRow] = await deps.sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n
      FROM messages
      WHERE role = 'assistant'
        AND created_at >= ${since}
        AND (meta_json::jsonb)->'telemetry'->'factCheck'->>'grounded' = 'false'
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

    const funnel = await buildFunnel(deps.sql, since);
    const trend = await buildTrend(deps.sql, windowKey, since, now);

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
      funnel,
      trend,
    });
  });
}

// ─── Lead funnel ───────────────────────────────────────────────────────

/**
 * Candidate-funnel aggregates. `by_state` is a full snapshot (every lead by
 * its current state); the rest is scoped to the rolling window so an
 * operator can see "what moved in the last 24h / 7d".
 */
async function buildFunnel(sql: AdminApiDeps["sql"], since: number) {
  const leadsRepo = new LeadsRepo(sql);
  const byState = await leadsRepo.countByState();

  const [newRow] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::INTEGER AS n FROM leads WHERE created_at >= ${since}
  `;

  const decidedRows = await sql<{ state: string; count: number }[]>`
    SELECT state, COUNT(*)::INTEGER AS count
    FROM leads
    WHERE decided_at >= ${since} AND state IN ('approved', 'rejected')
    GROUP BY state
  `;
  const decided = {
    approved: decidedRows.find((r) => r.state === "approved")?.count ?? 0,
    rejected: decidedRows.find((r) => r.state === "rejected")?.count ?? 0,
  };

  const [submittedRow] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::INTEGER AS n
    FROM lead_events
    WHERE to_state = 'submitted' AND created_at >= ${since}
  `;

  const rejectionReasons = await sql<{ reason: string; count: number }[]>`
    SELECT rejected_reason AS reason, COUNT(*)::INTEGER AS count
    FROM leads
    WHERE state = 'rejected' AND decided_at >= ${since} AND rejected_reason IS NOT NULL
    GROUP BY rejected_reason
    ORDER BY count DESC
    LIMIT 10
  `;

  const [decisionTimeRow] = await sql<{ avg: number | null }[]>`
    SELECT AVG(decided_at - created_at)::INTEGER AS avg
    FROM leads
    WHERE decided_at >= ${since}
  `;

  // Average time a lead spent in each state before transitioning out —
  // pair each lead_event with the next one for the same lead.
  const stageDwell = await sql<{ state: string; avg_seconds: number; n: number }[]>`
    WITH ordered AS (
      SELECT to_state,
             created_at,
             LEAD(created_at) OVER (PARTITION BY lead_id ORDER BY created_at, id) AS next_at
      FROM lead_events
      WHERE created_at >= ${since}
    )
    SELECT to_state AS state,
           AVG(next_at - created_at)::INTEGER AS avg_seconds,
           COUNT(next_at)::INTEGER AS n
    FROM ordered
    WHERE next_at IS NOT NULL
    GROUP BY to_state
  `;

  return {
    by_state: byState,
    new_in_window: newRow?.n ?? 0,
    decided,
    submitted_in_window: submittedRow?.n ?? 0,
    rejection_reasons: rejectionReasons,
    avg_decision_seconds: decisionTimeRow?.avg ?? null,
    stage_dwell: stageDwell,
  };
}

// ─── Activity trend ────────────────────────────────────────────────────

interface BucketRow {
  bucket: number;
  count: number;
}

/**
 * Time-bucketed counts of new conversations, new leads and assistant
 * answers across the window. Empty buckets are filled with zeros so the
 * chart renders a continuous series.
 */
async function buildTrend(sql: AdminApiDeps["sql"], windowKey: string, since: number, now: number) {
  const bucketSec = BUCKET_SECONDS[windowKey] ?? 24 * 60 * 60;

  const bucketize = (rows: BucketRow[]) => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(Number(r.bucket), r.count);
    return m;
  };

  const convRows = await sql<BucketRow[]>`
    SELECT (created_at / ${bucketSec}::int) * ${bucketSec}::int AS bucket,
           COUNT(*)::INTEGER AS count
    FROM conversations
    WHERE created_at >= ${since}
    GROUP BY bucket
  `;
  const leadRows = await sql<BucketRow[]>`
    SELECT (created_at / ${bucketSec}::int) * ${bucketSec}::int AS bucket,
           COUNT(*)::INTEGER AS count
    FROM leads
    WHERE created_at >= ${since}
    GROUP BY bucket
  `;
  const msgRows = await sql<BucketRow[]>`
    SELECT (created_at / ${bucketSec}::int) * ${bucketSec}::int AS bucket,
           COUNT(*)::INTEGER AS count
    FROM messages
    WHERE role = 'assistant' AND created_at >= ${since}
    GROUP BY bucket
  `;

  const convMap = bucketize(convRows);
  const leadMap = bucketize(leadRows);
  const msgMap = bucketize(msgRows);

  const firstBucket = Math.floor(since / bucketSec) * bucketSec;
  const lastBucket = Math.floor(now / bucketSec) * bucketSec;
  const buckets: Array<{
    start_unix: number;
    conversations: number;
    leads: number;
    messages: number;
  }> = [];
  for (let b = firstBucket; b <= lastBucket; b += bucketSec) {
    buckets.push({
      start_unix: b,
      conversations: convMap.get(b) ?? 0,
      leads: leadMap.get(b) ?? 0,
      messages: msgMap.get(b) ?? 0,
    });
  }

  return { bucket_seconds: bucketSec, buckets };
}
