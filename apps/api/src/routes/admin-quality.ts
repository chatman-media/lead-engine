import {
  AgentToolCallsRepo,
  type AgentToolCallFeedbackLabel,
  type AgentToolCallFeedbackRow,
  type AgentToolCallRow,
  type AgentToolCallSource,
  DrizzleKbStore,
  type Db,
  withTenant,
} from "@chatman-media/conversation-engine";
import type { ChatClient, EmbeddingClient } from "@chatman-media/llm-router";
import type { IKbStore } from "@chatman-media/kb";
import {
  applyEditsToStyle,
  CANDIDATE_BY_SLUG,
  CANDIDATE_PERSONAS,
  exportPairwiseMatchJsonl,
  exportSelfPlayMatchJsonl,
  type EloOutcome,
  type PairwiseDeps,
  type PairwiseMatchResult,
  type PairwiseWinner,
  parseProposal,
  proposeStyleEdits,
  runPairwiseMatch,
  runShadowEval,
  runSelfPlayMatch,
  type SelfPlayDeps,
  type SelfPlayMatchResult,
  shadowDecide,
  type Style,
  StyleSchema,
  wilsonLowerBound,
} from "@chatman-media/sales";
import {
  agentToolCallFeedback,
  agentToolCalls,
  coachProposals,
  contacts,
  conversations,
  leads,
  pairwiseMatches,
  selfPlayMatches,
  shadowEvaluations,
  skillOutcomes,
  skills,
  styleRatings,
  styleSkills,
  styles,
  vacancies,
} from "@chatman-media/storage";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { isUniqueViolation } from "../lib/db-errors.ts";

const OUTCOMES = new Set<EloOutcome>(["won", "lost", "draw"]);
const PAIRWISE_WINNERS = new Set<PairwiseWinner>(["a", "b", "draw"]);
const COACH_PROPOSAL_DECISIONS = new Set(["pending", "dismissed"]);
const TOOL_CALL_SOURCES = new Set<AgentToolCallSource>([
  "rag_reply",
  "llm_reply",
  "admin_sim",
  "self_play",
]);
const TOOL_CALL_FEEDBACK_LABELS = new Set<AgentToolCallFeedbackLabel>([
  "good_reply",
  "wrong_tool",
  "missing_tool",
  "bad_args",
  "other",
]);

const selfPlayMatchSelect = {
  id: selfPlayMatches.id,
  styleSlug: selfPlayMatches.styleSlug,
  personaSlug: selfPlayMatches.personaSlug,
  outcome: selfPlayMatches.outcome,
  judgeReason: selfPlayMatches.judgeReason,
  transcriptJson: selfPlayMatches.transcriptJson,
  turns: selfPlayMatches.turns,
  skillsJson: selfPlayMatches.skillsJson,
  leadId: selfPlayMatches.leadId,
  fabricationsCaught: selfPlayMatches.fabricationsCaught,
};

const shadowEvaluationResponseSelect = {
  id: shadowEvaluations.id,
  proposalId: shadowEvaluations.proposalId,
  parentStyleSlug: shadowEvaluations.parentStyleSlug,
  parentStyleId: shadowEvaluations.parentStyleId,
  newStyleSlug: shadowEvaluations.newStyleSlug,
  newStyleId: shadowEvaluations.newStyleId,
  pairsPlanned: shadowEvaluations.pairsPlanned,
  pairsDone: shadowEvaluations.pairsDone,
  aWins: shadowEvaluations.aWins,
  bWins: shadowEvaluations.bWins,
  draws: shadowEvaluations.draws,
  winRateLb: shadowEvaluations.winRateLb,
  status: shadowEvaluations.status,
  decision: shadowEvaluations.decision,
  errorMessage: shadowEvaluations.errorMessage,
  startedAt: shadowEvaluations.startedAt,
  completedAt: shadowEvaluations.completedAt,
};

const toolCallFeedbackJoinedSelect = {
  feedbackId: agentToolCallFeedback.id,
  feedbackToolCallId: agentToolCallFeedback.toolCallId,
  adminId: agentToolCallFeedback.adminId,
  label: agentToolCallFeedback.label,
  note: agentToolCallFeedback.note,
  feedbackCreatedAt: agentToolCallFeedback.createdAt,
  traceId: agentToolCalls.id,
  conversationId: agentToolCalls.conversationId,
  contactId: agentToolCalls.contactId,
  messageId: agentToolCalls.messageId,
  outboundQueueId: agentToolCalls.outboundQueueId,
  source: agentToolCalls.source,
  toolName: agentToolCalls.toolName,
  argsJson: agentToolCalls.argsJson,
  resultJson: agentToolCalls.resultJson,
  error: agentToolCalls.error,
  cycle: agentToolCalls.cycle,
  toolCallIndex: agentToolCalls.toolCallIndex,
  latencyMs: agentToolCalls.latencyMs,
  toolCallCreatedAt: agentToolCalls.createdAt,
};

export interface AdminQualityRoutesOpts {
  db: Db;
  onReload?: (tenantId: number) => void;
  resolveChat?: (tenantId: number) => ChatClient;
  resolveCandidateChat?: (tenantId: number) => ChatClient | null;
  resolveJudgeChat?: (tenantId: number) => ChatClient | null;
  resolveEmbedder?: (tenantId: number) => EmbeddingClient;
  resolveKb?: (tenantId: number) => IKbStore;
}

export function makeAdminQualityRoutes(opts: AdminQualityRoutesOpts): Hono {
  const app = new Hono();

  app.get("/api/admin/quality/tool-calls", async (c) => {
    const tenantId = c.var.tenantId;
    const limit = parsePositiveIntQuery(c.req.query("limit"), 100, 1000);
    if (limit === null) return c.json({ error: "invalid limit" }, 400);

    const conversationId = parseOptionalPositiveIntQuery(c.req.query("conversationId"));
    if (conversationId === null) return c.json({ error: "invalid conversationId" }, 400);
    const contactId = parseOptionalPositiveIntQuery(c.req.query("contactId"));
    if (contactId === null) return c.json({ error: "invalid contactId" }, 400);
    const messageId = parseOptionalPositiveIntQuery(c.req.query("messageId"));
    if (messageId === null) return c.json({ error: "invalid messageId" }, 400);
    const outboundQueueId = parseOptionalPositiveIntQuery(c.req.query("outboundQueueId"));
    if (outboundQueueId === null) return c.json({ error: "invalid outboundQueueId" }, 400);

    const sourceRaw = c.req.query("source");
    const source =
      sourceRaw && TOOL_CALL_SOURCES.has(sourceRaw as AgentToolCallSource)
        ? (sourceRaw as AgentToolCallSource)
        : undefined;
    if (sourceRaw && !source) return c.json({ error: "invalid source" }, 400);

    const errorRaw = c.req.query("error");
    const error =
      errorRaw === undefined
        ? undefined
        : errorRaw === "true"
          ? true
          : errorRaw === "false"
            ? false
            : null;
    if (error === null) return c.json({ error: "invalid error" }, 400);

    const toolName = c.req.query("toolName")?.trim();
    if (toolName !== undefined && toolName.length === 0) {
      return c.json({ error: "invalid toolName" }, 400);
    }

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return new AgentToolCallsRepo({ db: tx, tenantId }).list({
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(contactId !== undefined ? { contactId } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        ...(outboundQueueId !== undefined ? { outboundQueueId } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
        ...(error !== undefined ? { error } : {}),
        limit,
      });
    });

    return c.json({ items: rows.map(toAgentToolCallResponse) });
  });

  app.get("/api/admin/quality/tool-calls/:id/feedback", async (c) => {
    const tenantId = c.var.tenantId;
    const id = parsePositiveParamId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const repo = new AgentToolCallsRepo({ db: tx, tenantId });
      const toolCall = await repo.byId(id);
      if (!toolCall) return null;
      return repo.feedbackForToolCall(id);
    });
    if (result === null) return c.json({ error: "tool call not found" }, 404);

    return c.json({ items: result.map(toAgentToolCallFeedbackResponse) });
  });

  app.post("/api/admin/quality/tool-calls/:id/feedback", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = parsePositiveParamId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid id" }, 400);

    let body: QualityToolCallFeedbackBody;
    try {
      body = (await c.req.json()) as QualityToolCallFeedbackBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const labelRaw = typeof body.label === "string" ? body.label.trim() : "";
    const label = TOOL_CALL_FEEDBACK_LABELS.has(labelRaw as AgentToolCallFeedbackLabel)
      ? (labelRaw as AgentToolCallFeedbackLabel)
      : null;
    if (!label) {
      return c.json({
        error: `label must be one of: ${Array.from(TOOL_CALL_FEEDBACK_LABELS).join(", ")}`,
      }, 400);
    }

    const note = parseOptionalToolFeedbackNote(body.note);
    if (note.kind === "invalid") {
      return c.json({ error: "note must be a string up to 2000 characters" }, 400);
    }

    const feedback = await withTenant(opts.db, tenantId, async (tx) => {
      return new AgentToolCallsRepo({ db: tx, tenantId }).recordFeedback({
        toolCallId: id,
        adminId,
        label,
        note: note.value,
        nowEpoch: Math.floor(Date.now() / 1000),
      });
    });
    if (!feedback) return c.json({ error: "tool call not found" }, 404);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.tool_call_feedback.create",
      targetKind: "agent_tool_call",
      targetId: id,
      details: {
        label,
        hasNote: Boolean(note.value),
      },
    });

    return c.json({ ok: true, feedback: toAgentToolCallFeedbackResponse(feedback) }, 201);
  });

  app.get("/api/admin/quality/tool-call-feedback/summary", async (c) => {
    const tenantId = c.var.tenantId;
    const filters = parseToolCallFeedbackQuery(
      {
        limit: c.req.query("limit"),
        source: c.req.query("source"),
        toolName: c.req.query("toolName"),
        label: c.req.query("label"),
        error: c.req.query("error"),
      },
      25,
      200,
    );
    if (filters.kind === "invalid") return c.json({ error: filters.error }, 400);

    const summary = await withTenant(opts.db, tenantId, async (tx) => {
      const where = toolCallFeedbackWhere(tenantId, filters.value);
      const joinOn = toolCallFeedbackJoinOn();

      const [totalsRow] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          goodReply: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'good_reply'))::int`,
          wrongTool: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'wrong_tool'))::int`,
          missingTool: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'missing_tool'))::int`,
          badArgs: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'bad_args'))::int`,
          other: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'other'))::int`,
          errorCount: sql<number>`(count(*) filter (where ${agentToolCalls.error} = true))::int`,
          lastFeedbackAt: sql<number | null>`max(${agentToolCallFeedback.createdAt})::int`,
        })
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, joinOn)
        .where(where);

      const labelRows = await tx
        .select({
          label: agentToolCallFeedback.label,
          total: sql<number>`count(*)::int`,
          lastFeedbackAt: sql<number | null>`max(${agentToolCallFeedback.createdAt})::int`,
        })
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, joinOn)
        .where(where)
        .groupBy(agentToolCallFeedback.label);

      const byTool = await tx
        .select({
          toolName: agentToolCalls.toolName,
          total: sql<number>`count(*)::int`,
          goodReply: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'good_reply'))::int`,
          wrongTool: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'wrong_tool'))::int`,
          missingTool: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'missing_tool'))::int`,
          badArgs: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'bad_args'))::int`,
          other: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'other'))::int`,
          errorCount: sql<number>`(count(*) filter (where ${agentToolCalls.error} = true))::int`,
          lastFeedbackAt: sql<number | null>`max(${agentToolCallFeedback.createdAt})::int`,
        })
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, joinOn)
        .where(where)
        .groupBy(agentToolCalls.toolName)
        .orderBy(sql`count(*) desc`, desc(sql`max(${agentToolCallFeedback.createdAt})`))
        .limit(25);

      const bySource = await tx
        .select({
          source: agentToolCalls.source,
          total: sql<number>`count(*)::int`,
          goodReply: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'good_reply'))::int`,
          wrongTool: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'wrong_tool'))::int`,
          missingTool: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'missing_tool'))::int`,
          badArgs: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'bad_args'))::int`,
          other: sql<number>`(count(*) filter (where ${agentToolCallFeedback.label} = 'other'))::int`,
          errorCount: sql<number>`(count(*) filter (where ${agentToolCalls.error} = true))::int`,
          lastFeedbackAt: sql<number | null>`max(${agentToolCallFeedback.createdAt})::int`,
        })
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, joinOn)
        .where(where)
        .groupBy(agentToolCalls.source)
        .orderBy(sql`count(*) desc`);

      const byError = await tx
        .select({
          error: agentToolCalls.error,
          total: sql<number>`count(*)::int`,
          lastFeedbackAt: sql<number | null>`max(${agentToolCallFeedback.createdAt})::int`,
        })
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, joinOn)
        .where(where)
        .groupBy(agentToolCalls.error)
        .orderBy(agentToolCalls.error);

      const recentRows = await tx
        .select(toolCallFeedbackJoinedSelect)
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, joinOn)
        .where(where)
        .orderBy(desc(agentToolCallFeedback.createdAt), desc(agentToolCallFeedback.id))
        .limit(filters.value.limit);

      return {
        totals: totalsRow ?? emptyToolCallFeedbackTotals(),
        byLabel: withAllToolFeedbackLabels(labelRows),
        byTool,
        bySource,
        byError,
        recent: recentRows.map(toToolCallFeedbackJoinedResponse),
      };
    });

    return c.json(summary);
  });

  app.get("/api/admin/quality/tool-call-feedback/export.jsonl", async (c) => {
    const tenantId = c.var.tenantId;
    const filters = parseToolCallFeedbackQuery(
      {
        limit: c.req.query("limit"),
        source: c.req.query("source"),
        toolName: c.req.query("toolName"),
        label: c.req.query("label"),
        error: c.req.query("error"),
      },
      200,
      1000,
    );
    if (filters.kind === "invalid") return c.json({ error: filters.error }, 400);

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select(toolCallFeedbackJoinedSelect)
        .from(agentToolCallFeedback)
        .innerJoin(agentToolCalls, toolCallFeedbackJoinOn())
        .where(toolCallFeedbackWhere(tenantId, filters.value))
        .orderBy(desc(agentToolCallFeedback.createdAt), desc(agentToolCallFeedback.id))
        .limit(filters.value.limit);
    });

    const jsonl = rows
      .map((row) => JSON.stringify(toToolCallFeedbackExportRecord(row)))
      .join("\n");
    const body = jsonl ? `${jsonl}\n` : "";
    return c.body(body, 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="tool-call-feedback.jsonl"',
    });
  });

  app.get("/api/admin/quality/self-play/summary", async (c) => {
    const tenantId = c.var.tenantId;

    const summary = await withTenant(opts.db, tenantId, async (tx) => {
      const [totalsRow] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          won: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'won'))::int`,
          lost: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'lost'))::int`,
          draw: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'draw'))::int`,
          fabricationsCaught: sql<number>`coalesce(sum(${selfPlayMatches.fabricationsCaught}), 0)::int`,
          avgTurns: sql<number | null>`round(avg(${selfPlayMatches.turns})::numeric, 2)::float`,
          lastMatchAt: sql<number | null>`max(${selfPlayMatches.createdAt})::int`,
        })
        .from(selfPlayMatches)
        .where(eq(selfPlayMatches.tenantId, tenantId));

      const byStyleRows = await tx
        .select({
          styleSlug: selfPlayMatches.styleSlug,
          total: sql<number>`count(*)::int`,
          won: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'won'))::int`,
          lost: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'lost'))::int`,
          draw: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'draw'))::int`,
          fabricationsCaught: sql<number>`coalesce(sum(${selfPlayMatches.fabricationsCaught}), 0)::int`,
          avgTurns: sql<number | null>`round(avg(${selfPlayMatches.turns})::numeric, 2)::float`,
          lastMatchAt: sql<number | null>`max(${selfPlayMatches.createdAt})::int`,
        })
        .from(selfPlayMatches)
        .where(eq(selfPlayMatches.tenantId, tenantId))
        .groupBy(selfPlayMatches.styleSlug);

      const byPersonaRows = await tx
        .select({
          personaSlug: selfPlayMatches.personaSlug,
          total: sql<number>`count(*)::int`,
          won: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'won'))::int`,
          lost: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'lost'))::int`,
          draw: sql<number>`(count(*) filter (where ${selfPlayMatches.outcome} = 'draw'))::int`,
          lastMatchAt: sql<number | null>`max(${selfPlayMatches.createdAt})::int`,
        })
        .from(selfPlayMatches)
        .where(eq(selfPlayMatches.tenantId, tenantId))
        .groupBy(selfPlayMatches.personaSlug);

      const recent = await tx
        .select({
          id: selfPlayMatches.id,
          styleSlug: selfPlayMatches.styleSlug,
          personaSlug: selfPlayMatches.personaSlug,
          outcome: selfPlayMatches.outcome,
          judgeReason: selfPlayMatches.judgeReason,
          turns: selfPlayMatches.turns,
          fabricationsCaught: selfPlayMatches.fabricationsCaught,
          createdAt: selfPlayMatches.createdAt,
        })
        .from(selfPlayMatches)
        .where(eq(selfPlayMatches.tenantId, tenantId))
        .orderBy(desc(selfPlayMatches.createdAt), desc(selfPlayMatches.id))
        .limit(10);

      return {
        totals: withWinRate(
          totalsRow ?? {
            total: 0,
            won: 0,
            lost: 0,
            draw: 0,
            fabricationsCaught: 0,
            avgTurns: null,
            lastMatchAt: null,
          },
        ),
        byStyle: byStyleRows
          .map(withWinRate)
          .sort((a, b) => b.total - a.total || (b.lastMatchAt ?? 0) - (a.lastMatchAt ?? 0)),
        byPersona: byPersonaRows
          .map(withWinRate)
          .sort((a, b) => b.total - a.total || (b.lastMatchAt ?? 0) - (a.lastMatchAt ?? 0)),
        recent,
      };
    });

    return c.json(summary);
  });

  app.get("/api/admin/quality/pairwise/summary", async (c) => {
    const tenantId = c.var.tenantId;

    const summary = await withTenant(opts.db, tenantId, async (tx) => {
      const [totalsRow] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          aWins: sql<number>`(count(*) filter (where ${pairwiseMatches.winner} = 'a'))::int`,
          bWins: sql<number>`(count(*) filter (where ${pairwiseMatches.winner} = 'b'))::int`,
          draws: sql<number>`(count(*) filter (where ${pairwiseMatches.winner} = 'draw'))::int`,
          lastMatchAt: sql<number | null>`max(${pairwiseMatches.createdAt})::int`,
        })
        .from(pairwiseMatches)
        .where(eq(pairwiseMatches.tenantId, tenantId));

      const byPairRows = await tx
        .select({
          styleASlug: pairwiseMatches.styleASlug,
          styleBSlug: pairwiseMatches.styleBSlug,
          total: sql<number>`count(*)::int`,
          aWins: sql<number>`(count(*) filter (where ${pairwiseMatches.winner} = 'a'))::int`,
          bWins: sql<number>`(count(*) filter (where ${pairwiseMatches.winner} = 'b'))::int`,
          draws: sql<number>`(count(*) filter (where ${pairwiseMatches.winner} = 'draw'))::int`,
          lastMatchAt: sql<number | null>`max(${pairwiseMatches.createdAt})::int`,
        })
        .from(pairwiseMatches)
        .where(eq(pairwiseMatches.tenantId, tenantId))
        .groupBy(pairwiseMatches.styleASlug, pairwiseMatches.styleBSlug);

      const recent = await tx
        .select({
          id: pairwiseMatches.id,
          styleASlug: pairwiseMatches.styleASlug,
          styleBSlug: pairwiseMatches.styleBSlug,
          personaSlug: pairwiseMatches.personaSlug,
          winner: pairwiseMatches.winner,
          judgeReason: pairwiseMatches.judgeReason,
          matchAId: pairwiseMatches.matchAId,
          matchBId: pairwiseMatches.matchBId,
          eloAAfter: pairwiseMatches.eloAAfter,
          eloBAfter: pairwiseMatches.eloBAfter,
          createdAt: pairwiseMatches.createdAt,
        })
        .from(pairwiseMatches)
        .where(eq(pairwiseMatches.tenantId, tenantId))
        .orderBy(desc(pairwiseMatches.createdAt), desc(pairwiseMatches.id))
        .limit(10);

      return {
        totals: withPairwiseRates(
          totalsRow ?? { total: 0, aWins: 0, bWins: 0, draws: 0, lastMatchAt: null },
        ),
        byPair: byPairRows
          .map(withPairwiseRates)
          .sort((a, b) => b.total - a.total || (b.lastMatchAt ?? 0) - (a.lastMatchAt ?? 0)),
        recent,
      };
    });

    return c.json(summary);
  });

  app.get("/api/admin/quality/self-play/matches/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const row = await withTenant(opts.db, tenantId, async (tx) => {
      const [match] = await tx
        .select(selfPlayMatchSelect)
        .from(selfPlayMatches)
        .where(and(eq(selfPlayMatches.id, id), eq(selfPlayMatches.tenantId, tenantId)))
        .limit(1);
      return match ?? null;
    });
    if (!row) return c.json({ error: "self-play match not found" }, 404);

    return c.json({ match: toSelfPlayResult(row) });
  });

  app.get("/api/admin/quality/pairwise/matches/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const row = await withTenant(opts.db, tenantId, async (tx) => {
      const [pairwise] = await tx
        .select({
          id: pairwiseMatches.id,
          styleASlug: pairwiseMatches.styleASlug,
          styleBSlug: pairwiseMatches.styleBSlug,
          personaSlug: pairwiseMatches.personaSlug,
          winner: pairwiseMatches.winner,
          judgeReason: pairwiseMatches.judgeReason,
          matchAId: pairwiseMatches.matchAId,
          matchBId: pairwiseMatches.matchBId,
          eloAAfter: pairwiseMatches.eloAAfter,
          eloBAfter: pairwiseMatches.eloBAfter,
        })
        .from(pairwiseMatches)
        .where(and(eq(pairwiseMatches.id, id), eq(pairwiseMatches.tenantId, tenantId)))
        .limit(1);
      if (!pairwise) return null;

      const matchIds = [pairwise.matchAId, pairwise.matchBId].filter(isPresentId);
      const selfPlayRows = matchIds.length
        ? await tx
            .select(selfPlayMatchSelect)
            .from(selfPlayMatches)
            .where(and(eq(selfPlayMatches.tenantId, tenantId), inArray(selfPlayMatches.id, matchIds)))
        : [];
      const byId = new Map(selfPlayRows.map((match) => [match.id, match]));
      return {
        ...pairwise,
        matchA: pairwise.matchAId ? byId.get(pairwise.matchAId) : undefined,
        matchB: pairwise.matchBId ? byId.get(pairwise.matchBId) : undefined,
      };
    });
    if (!row) return c.json({ error: "pairwise match not found" }, 404);

    return c.json({ pairwise: toPairwiseResult(row) });
  });

  app.get("/api/admin/quality/run-options", async (c) => {
    const tenantId = c.var.tenantId;
    const styleRows = await withTenant(opts.db, tenantId, (tx) =>
      tx
        .select({
          id: styles.id,
          slug: styles.slug,
          displayName: styles.displayName,
          isActive: styles.isActive,
        })
        .from(styles)
        .where(and(eq(styles.tenantId, tenantId), eq(styles.isActive, true), sql`${styles.deletedAt} IS NULL`))
        .orderBy(styles.slug),
    );

    return c.json({
      styles: styleRows,
      personas: CANDIDATE_PERSONAS.map((persona) => ({
        slug: persona.slug,
        displayName: persona.displayName,
        summary: persona.summary,
      })),
    });
  });

  app.post("/api/admin/quality/self-play/matches", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json<QualitySelfPlayRunBody>().catch((): QualitySelfPlayRunBody => ({}));

    const styleSlug = parseRequiredBodyString(body.styleSlug);
    if (styleSlug.kind === "invalid") return c.json({ error: "styleSlug is required" }, 400);
    const personaSlug = parseRequiredBodyString(body.personaSlug);
    if (personaSlug.kind === "invalid") return c.json({ error: "personaSlug is required" }, 400);
    const maxTurns = parseOptionalBodyInteger(body.maxTurns, 1, 20);
    if (maxTurns.kind === "invalid") {
      return c.json({ error: "maxTurns must be an integer between 1 and 20" }, 400);
    }
    const reflect = parseOptionalBodyBoolean(body.reflect);
    if (reflect.kind === "invalid") return c.json({ error: "reflect must be a boolean" }, 400);

    const styleResult = await loadQualityStyle(opts.db, tenantId, styleSlug.value);
    if (styleResult.kind === "not_found") return c.json({ error: "active style not found" }, 404);
    if (styleResult.kind === "invalid") {
      return c.json({ error: "style failed schema validation", issues: styleResult.issues }, 422);
    }
    const persona = CANDIDATE_BY_SLUG.get(personaSlug.value);
    if (!persona) return c.json({ error: "persona not found" }, 404);

    const depsResult = await buildQualityRunnerDeps(opts, tenantId, reflect.value);
    if (depsResult.kind === "unavailable") return c.json({ error: depsResult.error }, 503);

    const match = await runSelfPlayMatch(depsResult.deps, {
      style: styleResult.style,
      styleId: styleResult.styleId,
      persona,
      ...(maxTurns.value !== undefined ? { maxTurns: maxTurns.value } : {}),
    });
    await syncPersistedSelfPlayResult(opts.db, tenantId, match);
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.self_play.run",
      targetKind: "self_play_match",
      targetId: String(match.matchId ?? "unpersisted"),
      details: {
        styleSlug: match.styleSlug,
        personaSlug: match.personaSlug,
        outcome: match.outcome,
        persisted: match.persisted,
      },
    });

    return c.json({ ok: true, match });
  });

  app.post("/api/admin/quality/pairwise/matches", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req.json<QualityPairwiseRunBody>().catch((): QualityPairwiseRunBody => ({}));

    const styleASlug = parseRequiredBodyString(body.styleASlug);
    if (styleASlug.kind === "invalid") return c.json({ error: "styleASlug is required" }, 400);
    const styleBSlug = parseRequiredBodyString(body.styleBSlug);
    if (styleBSlug.kind === "invalid") return c.json({ error: "styleBSlug is required" }, 400);
    if (styleASlug.value === styleBSlug.value) {
      return c.json({ error: "styleASlug and styleBSlug must be different" }, 400);
    }
    const personaSlug = parseRequiredBodyString(body.personaSlug);
    if (personaSlug.kind === "invalid") return c.json({ error: "personaSlug is required" }, 400);
    const maxTurns = parseOptionalBodyInteger(body.maxTurns, 1, 20);
    if (maxTurns.kind === "invalid") {
      return c.json({ error: "maxTurns must be an integer between 1 and 20" }, 400);
    }
    const reflect = parseOptionalBodyBoolean(body.reflect);
    if (reflect.kind === "invalid") return c.json({ error: "reflect must be a boolean" }, 400);

    const [styleAResult, styleBResult] = await Promise.all([
      loadQualityStyle(opts.db, tenantId, styleASlug.value),
      loadQualityStyle(opts.db, tenantId, styleBSlug.value),
    ]);
    if (styleAResult.kind === "not_found" || styleBResult.kind === "not_found") {
      return c.json({ error: "active style not found" }, 404);
    }
    if (styleAResult.kind === "invalid") {
      return c.json({ error: "style A failed schema validation", issues: styleAResult.issues }, 422);
    }
    if (styleBResult.kind === "invalid") {
      return c.json({ error: "style B failed schema validation", issues: styleBResult.issues }, 422);
    }
    const persona = CANDIDATE_BY_SLUG.get(personaSlug.value);
    if (!persona) return c.json({ error: "persona not found" }, 404);

    const depsResult = await buildQualityRunnerDeps(opts, tenantId, reflect.value);
    if (depsResult.kind === "unavailable") return c.json({ error: depsResult.error }, 503);

    const pairwise = await runPairwiseMatch(depsResult.deps, {
      styleA: styleAResult.style,
      styleAId: styleAResult.styleId,
      styleB: styleBResult.style,
      styleBId: styleBResult.styleId,
      persona,
      ...(maxTurns.value !== undefined ? { maxTurns: maxTurns.value } : {}),
    });
    await syncPersistedSelfPlayResult(opts.db, tenantId, pairwise.matchA);
    await syncPersistedSelfPlayResult(opts.db, tenantId, pairwise.matchB);
    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.pairwise.run",
      targetKind: "pairwise_match",
      targetId: String(pairwise.pairwiseId ?? "unpersisted"),
      details: {
        styleASlug: pairwise.styleASlug,
        styleBSlug: pairwise.styleBSlug,
        personaSlug: pairwise.personaSlug,
        winner: pairwise.verdict.winner,
        persisted: pairwise.persisted,
      },
    });

    return c.json({ ok: true, pairwise });
  });

  app.post("/api/admin/quality/coach/proposals", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const body = await c.req
      .json<QualityCoachProposalGenerateBody>()
      .catch((): QualityCoachProposalGenerateBody => ({}));

    const styleSlug = parseRequiredBodyString(body.styleSlug);
    if (styleSlug.kind === "invalid") return c.json({ error: "styleSlug is required" }, 400);
    const sampleSize = parseOptionalBodyInteger(body.sampleSize, 1, 50);
    if (sampleSize.kind === "invalid") {
      return c.json({ error: "sampleSize must be an integer between 1 and 50" }, 400);
    }
    const personaSlug = parseOptionalBodyString(body.personaSlug);
    if (personaSlug.kind === "invalid") {
      return c.json({ error: "personaSlug must be a non-empty string" }, 400);
    }
    const model = parseOptionalBodyString(body.model);
    if (model.kind === "invalid") return c.json({ error: "model must be a non-empty string" }, 400);

    if (personaSlug.value && !CANDIDATE_BY_SLUG.has(personaSlug.value)) {
      return c.json({ error: "persona not found" }, 404);
    }

    const chat = resolveRequiredQualityDep(opts.resolveChat, tenantId);
    if (!chat) return c.json({ error: "chat LLM is not configured" }, 503);

    const styleResult = await loadQualityStyle(opts.db, tenantId, styleSlug.value);
    if (styleResult.kind === "not_found") return c.json({ error: "active style not found" }, 404);
    if (styleResult.kind === "invalid") {
      return c.json({ error: "style failed schema validation", issues: styleResult.issues }, 422);
    }

    const adapters = makeQualityStorageAdapters(opts.db, tenantId);
    const attachedSkills = await adapters.skills.skillsForStyle(styleResult.styleId);
    const resolvedSampleSize = sampleSize.value ?? 8;
    const proposal = await proposeStyleEdits({
      style: styleResult.style,
      matchesRepo: adapters.matches,
      chat,
      sampleSize: resolvedSampleSize,
      currentSkills: attachedSkills.map((skill) => skill.slug),
      ...(personaSlug.value ? { personaSlug: personaSlug.value } : {}),
      ...(model.value ? { model: model.value } : {}),
    });

    const now = nowEpoch();
    const created = await withTenant(opts.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(coachProposals)
        .values({
          tenantId,
          styleSlug: styleResult.style.slug,
          sampleSize: resolvedSampleSize,
          personaFilter: personaSlug.value ?? null,
          summary: proposal.summary,
          editsJson: JSON.stringify(proposal.edits),
          rationaleJson: JSON.stringify(proposal.rationale),
          rawOutput: proposal.raw ?? null,
          status: "pending",
          createdAt: now,
        })
        .returning({
          id: coachProposals.id,
          styleSlug: coachProposals.styleSlug,
          sampleSize: coachProposals.sampleSize,
          personaFilter: coachProposals.personaFilter,
          summary: coachProposals.summary,
          editsJson: coachProposals.editsJson,
          rationaleJson: coachProposals.rationaleJson,
          rawOutput: coachProposals.rawOutput,
          status: coachProposals.status,
          createdAt: coachProposals.createdAt,
          decidedAt: coachProposals.decidedAt,
          decidedByAdminId: coachProposals.decidedByAdminId,
        });
      return row ?? null;
    });

    if (!created) return c.json({ error: "coach proposal was not created" }, 500);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.coach_proposal.generate",
      targetKind: "coach_proposal",
      targetId: String(created.id),
      details: {
        styleSlug: created.styleSlug,
        sampleSize: created.sampleSize,
        personaFilter: created.personaFilter,
        editKeys: Object.keys(proposal.edits),
      },
    });

    return c.json({ ok: true, proposal: toCoachProposalResponse(created) });
  });

  app.get("/api/admin/quality/coach/summary", async (c) => {
    const tenantId = c.var.tenantId;

    const summary = await withTenant(opts.db, tenantId, async (tx) => {
      const [proposalTotals] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          pending: sql<number>`(count(*) filter (where ${coachProposals.status} = 'pending'))::int`,
          applied: sql<number>`(count(*) filter (where ${coachProposals.status} = 'applied'))::int`,
          dismissed: sql<number>`(count(*) filter (where ${coachProposals.status} = 'dismissed'))::int`,
          lastProposalAt: sql<number | null>`max(${coachProposals.createdAt})::int`,
        })
        .from(coachProposals)
        .where(eq(coachProposals.tenantId, tenantId));

      const [shadowTotals] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          running: sql<number>`(count(*) filter (where ${shadowEvaluations.status} = 'running'))::int`,
          complete: sql<number>`(count(*) filter (where ${shadowEvaluations.status} = 'complete'))::int`,
          failed: sql<number>`(count(*) filter (where ${shadowEvaluations.status} = 'failed'))::int`,
          keep: sql<number>`(count(*) filter (where ${shadowEvaluations.decision} = 'keep'))::int`,
          rollback: sql<number>`(count(*) filter (where ${shadowEvaluations.decision} = 'rollback'))::int`,
          inconclusive: sql<number>`(count(*) filter (where ${shadowEvaluations.decision} = 'inconclusive'))::int`,
          lastShadowAt: sql<number | null>`max(${shadowEvaluations.startedAt})::int`,
        })
        .from(shadowEvaluations)
        .where(eq(shadowEvaluations.tenantId, tenantId));

      const proposals = await tx
        .select({
          id: coachProposals.id,
          styleSlug: coachProposals.styleSlug,
          sampleSize: coachProposals.sampleSize,
          personaFilter: coachProposals.personaFilter,
          summary: coachProposals.summary,
          editsJson: coachProposals.editsJson,
          rationaleJson: coachProposals.rationaleJson,
          rawOutput: coachProposals.rawOutput,
          status: coachProposals.status,
          createdAt: coachProposals.createdAt,
          decidedAt: coachProposals.decidedAt,
          decidedByAdminId: coachProposals.decidedByAdminId,
        })
        .from(coachProposals)
        .where(eq(coachProposals.tenantId, tenantId))
        .orderBy(desc(coachProposals.createdAt), desc(coachProposals.id))
        .limit(10);

      const shadows = await tx
        .select({
          id: shadowEvaluations.id,
          proposalId: shadowEvaluations.proposalId,
          parentStyleSlug: shadowEvaluations.parentStyleSlug,
          parentStyleId: shadowEvaluations.parentStyleId,
          newStyleSlug: shadowEvaluations.newStyleSlug,
          newStyleId: shadowEvaluations.newStyleId,
          pairsPlanned: shadowEvaluations.pairsPlanned,
          pairsDone: shadowEvaluations.pairsDone,
          aWins: shadowEvaluations.aWins,
          bWins: shadowEvaluations.bWins,
          draws: shadowEvaluations.draws,
          winRateLb: shadowEvaluations.winRateLb,
          status: shadowEvaluations.status,
          decision: shadowEvaluations.decision,
          errorMessage: shadowEvaluations.errorMessage,
          startedAt: shadowEvaluations.startedAt,
          completedAt: shadowEvaluations.completedAt,
        })
        .from(shadowEvaluations)
        .where(eq(shadowEvaluations.tenantId, tenantId))
        .orderBy(desc(shadowEvaluations.startedAt), desc(shadowEvaluations.id))
        .limit(10);

      return {
        totals: {
          proposals: proposalTotals ?? {
            total: 0,
            pending: 0,
            applied: 0,
            dismissed: 0,
            lastProposalAt: null,
          },
          shadows: shadowTotals ?? {
            total: 0,
            running: 0,
            complete: 0,
            failed: 0,
            keep: 0,
            rollback: 0,
            inconclusive: 0,
            lastShadowAt: null,
          },
        },
        proposals: proposals.map(toCoachProposalResponse),
        shadows,
      };
    });

    return c.json(summary);
  });

  app.patch("/api/admin/quality/coach/proposals/:id/status", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const body = await c.req.json<{ status?: unknown }>().catch(() => null);
    const status = body?.status;
    if (typeof status !== "string" || !COACH_PROPOSAL_DECISIONS.has(status)) {
      return c.json({ error: "status must be one of: pending, dismissed" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [proposal] = await tx
        .select({
          id: coachProposals.id,
          styleSlug: coachProposals.styleSlug,
          sampleSize: coachProposals.sampleSize,
          personaFilter: coachProposals.personaFilter,
          summary: coachProposals.summary,
          editsJson: coachProposals.editsJson,
          rationaleJson: coachProposals.rationaleJson,
          rawOutput: coachProposals.rawOutput,
          status: coachProposals.status,
          createdAt: coachProposals.createdAt,
          decidedAt: coachProposals.decidedAt,
          decidedByAdminId: coachProposals.decidedByAdminId,
        })
        .from(coachProposals)
        .where(and(eq(coachProposals.id, id), eq(coachProposals.tenantId, tenantId)))
        .limit(1);

      if (!proposal) return { kind: "not_found" as const };
      if (proposal.status === "applied") {
        return { kind: "blocked" as const, error: "applied proposals cannot be changed here" };
      }
      if (proposal.status === status) {
        return { kind: "ok" as const, proposal: toCoachProposalResponse(proposal) };
      }

      const [updated] = await tx
        .update(coachProposals)
        .set({
          status,
          decidedAt: status === "dismissed" ? now : null,
          decidedByAdminId: status === "dismissed" ? (adminId ?? null) : null,
        })
        .where(and(eq(coachProposals.id, id), eq(coachProposals.tenantId, tenantId)))
        .returning({
          id: coachProposals.id,
          styleSlug: coachProposals.styleSlug,
          sampleSize: coachProposals.sampleSize,
          personaFilter: coachProposals.personaFilter,
          summary: coachProposals.summary,
          editsJson: coachProposals.editsJson,
          rationaleJson: coachProposals.rationaleJson,
          rawOutput: coachProposals.rawOutput,
          status: coachProposals.status,
          createdAt: coachProposals.createdAt,
          decidedAt: coachProposals.decidedAt,
          decidedByAdminId: coachProposals.decidedByAdminId,
        });

      return { kind: "ok" as const, proposal: toCoachProposalResponse(updated ?? proposal) };
    });

    if (result.kind === "not_found") return c.json({ error: "coach proposal not found" }, 404);
    if (result.kind === "blocked") return c.json({ error: result.error }, 409);
    return c.json({ ok: true, proposal: result.proposal });
  });

  app.post("/api/admin/quality/coach/proposals/:id/apply", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const now = Math.floor(Date.now() / 1000);
    let result: ApplyCoachProposalResult;
    try {
      result = await withTenant(opts.db, tenantId, async (tx) => {
        const [proposal] = await tx
          .select({
            id: coachProposals.id,
            styleSlug: coachProposals.styleSlug,
            sampleSize: coachProposals.sampleSize,
            personaFilter: coachProposals.personaFilter,
            summary: coachProposals.summary,
            editsJson: coachProposals.editsJson,
            rationaleJson: coachProposals.rationaleJson,
            rawOutput: coachProposals.rawOutput,
            status: coachProposals.status,
            createdAt: coachProposals.createdAt,
            decidedAt: coachProposals.decidedAt,
            decidedByAdminId: coachProposals.decidedByAdminId,
          })
          .from(coachProposals)
          .where(and(eq(coachProposals.id, id), eq(coachProposals.tenantId, tenantId)))
          .limit(1);

        if (!proposal) return { kind: "not_found" as const };
        if (proposal.status !== "pending") {
          return {
            kind: "blocked" as const,
            error: `only pending proposals can be applied; current status is ${proposal.status}`,
          };
        }

        const [parent] = await tx
          .select({
            id: styles.id,
            slug: styles.slug,
            displayName: styles.displayName,
            configJson: styles.configJson,
            version: styles.version,
          })
          .from(styles)
          .where(
            and(
              eq(styles.tenantId, tenantId),
              eq(styles.slug, proposal.styleSlug),
              eq(styles.isActive, true),
              sql`${styles.deletedAt} IS NULL`,
            ),
          )
          .limit(1);

        if (!parent) return { kind: "parent_not_found" as const };

        const parentStyleParse = StyleSchema.safeParse(parseJsonValue(parent.configJson, null));
        if (!parentStyleParse.success) {
          return {
            kind: "invalid_parent_style" as const,
            issues: parentStyleParse.error.issues.slice(0, 5),
          };
        }

        const editsProposal = parseProposal(JSON.stringify({
          summary: proposal.summary,
          edits: parseJsonValue(proposal.editsJson, {}),
          rationale: parseStringArray(proposal.rationaleJson),
        }));
        const applied = applyEditsToStyle(parentStyleParse.data, editsProposal.edits);
        const candidateSlug = await nextCoachStyleSlug(tx, parentStyleParse.data.slug, proposal.id);
        const candidateStyle = StyleSchema.safeParse({
          ...applied,
          slug: candidateSlug,
          displayName: `${parentStyleParse.data.displayName} Coach ${proposal.id}`,
        });
        if (!candidateStyle.success) {
          return {
            kind: "invalid_candidate_style" as const,
            issues: candidateStyle.error.issues.slice(0, 5),
          };
        }

        const [createdStyle] = await tx
          .insert(styles)
          .values({
            tenantId,
            slug: candidateStyle.data.slug,
            displayName: candidateStyle.data.displayName,
            configJson: JSON.stringify(candidateStyle.data),
            isActive: false,
            version: 1,
            parentId: parent.id,
            createdAt: now,
          })
          .returning({
            id: styles.id,
            tenantId: styles.tenantId,
            slug: styles.slug,
            displayName: styles.displayName,
            configJson: styles.configJson,
            isActive: styles.isActive,
            version: styles.version,
            parentId: styles.parentId,
            createdAt: styles.createdAt,
            deletedAt: styles.deletedAt,
          });
        if (!createdStyle) {
          return { kind: "style_create_failed" as const, error: "style variant was not created" };
        }

        const [updatedProposal] = await tx
          .update(coachProposals)
          .set({
            status: "applied",
            decidedAt: now,
            decidedByAdminId: adminId ?? null,
          })
          .where(and(eq(coachProposals.id, proposal.id), eq(coachProposals.tenantId, tenantId)))
          .returning({
            id: coachProposals.id,
            styleSlug: coachProposals.styleSlug,
            sampleSize: coachProposals.sampleSize,
            personaFilter: coachProposals.personaFilter,
            summary: coachProposals.summary,
            editsJson: coachProposals.editsJson,
            rationaleJson: coachProposals.rationaleJson,
            rawOutput: coachProposals.rawOutput,
            status: coachProposals.status,
            createdAt: coachProposals.createdAt,
            decidedAt: coachProposals.decidedAt,
            decidedByAdminId: coachProposals.decidedByAdminId,
          });

        return {
          kind: "ok" as const,
          proposal: toCoachProposalResponse(updatedProposal ?? proposal),
          style: createdStyle,
          parentStyleId: parent.id,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "coach style variant already exists" }, 409);
      }
      throw err;
    }

    if (result.kind === "not_found") return c.json({ error: "coach proposal not found" }, 404);
    if (result.kind === "parent_not_found") return c.json({ error: "active parent style not found" }, 404);
    if (result.kind === "blocked") return c.json({ error: result.error }, 409);
    if (result.kind === "style_create_failed") return c.json({ error: result.error }, 500);
    if (result.kind === "invalid_parent_style") {
      return c.json({ error: "parent style failed schema validation", issues: result.issues }, 422);
    }
    if (result.kind === "invalid_candidate_style") {
      return c.json({ error: "candidate style failed schema validation", issues: result.issues }, 422);
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.coach_proposal.apply",
      targetKind: "coach_proposal",
      targetId: String(id),
      details: {
        styleId: result.style.id,
        styleSlug: result.style.slug,
        parentStyleId: result.parentStyleId,
      },
    });
    opts.onReload?.(tenantId);
    return c.json({ ok: true, proposal: result.proposal, style: result.style });
  });

  app.get("/api/admin/quality/coach/proposals/:id/shadow-preview", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be an integer between 1 and 1000" }, 400);
    const newStyleSlug = optionalQuery(c.req.query("newStyleSlug"));

    const result = await withTenant(opts.db, tenantId, (tx) =>
      resolveShadowEvaluationPlan(tx, {
        tenantId,
        proposalId: id,
        newStyleSlug,
        limit,
      }),
    );

    if (result.kind === "not_found") return c.json({ error: "coach proposal not found" }, 404);
    if (result.kind === "parent_not_found") return c.json({ error: "parent style not found" }, 404);
    if (result.kind === "candidate_not_found") return c.json({ error: "derived style not found" }, 404);
    if (result.kind === "blocked") return c.json({ error: result.error }, 409);

    return c.json({ ok: true, preview: toShadowEvaluationPreview(result.plan) });
  });

  app.post("/api/admin/quality/coach/proposals/:id/shadow-evaluations", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    type ShadowEvalCreateBody = {
      pairsPlanned?: unknown;
      limit?: unknown;
      newStyleSlug?: unknown;
    };
    const body = await c.req.json<ShadowEvalCreateBody>().catch((): ShadowEvalCreateBody => ({}));
    const pairsPlannedInput = parseOptionalBodyInteger(body.pairsPlanned, 1, 1000);
    if (pairsPlannedInput.kind === "invalid") {
      return c.json({ error: "pairsPlanned must be an integer between 1 and 1000" }, 400);
    }
    const limitInput = parseOptionalBodyInteger(body.limit, 1, 1000);
    if (limitInput.kind === "invalid") {
      return c.json({ error: "limit must be an integer between 1 and 1000" }, 400);
    }
    const newStyleSlugInput = parseOptionalBodyString(body.newStyleSlug);
    if (newStyleSlugInput.kind === "invalid") {
      return c.json({ error: "newStyleSlug must be a non-empty string" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const planResult = await resolveShadowEvaluationPlan(tx, {
        tenantId,
        proposalId: id,
        newStyleSlug: newStyleSlugInput.value,
        limit: limitInput.value ?? pairsPlannedInput.value ?? 200,
      });

      if (planResult.kind !== "ok") return planResult;
      const { plan } = planResult;
      if (plan.pairsDone === 0) return { kind: "no_pairwise" as const, plan };

      const [created] = await tx
        .insert(shadowEvaluations)
        .values({
          tenantId,
          proposalId: plan.proposal.id,
          parentStyleSlug: plan.parentStyle.slug,
          parentStyleId: plan.parentStyle.id,
          newStyleSlug: plan.candidateStyle.slug,
          newStyleId: plan.candidateStyle.id,
          pairsPlanned: plan.pairsDone,
          pairsDone: plan.pairsDone,
          aWins: plan.aWins,
          bWins: plan.bWins,
          draws: plan.draws,
          winRateLb: plan.winRateLb,
          status: "complete",
          decision: plan.decision,
          startedAt: now,
          completedAt: now,
        })
        .returning({
          id: shadowEvaluations.id,
          proposalId: shadowEvaluations.proposalId,
          parentStyleSlug: shadowEvaluations.parentStyleSlug,
          parentStyleId: shadowEvaluations.parentStyleId,
          newStyleSlug: shadowEvaluations.newStyleSlug,
          newStyleId: shadowEvaluations.newStyleId,
          pairsPlanned: shadowEvaluations.pairsPlanned,
          pairsDone: shadowEvaluations.pairsDone,
          aWins: shadowEvaluations.aWins,
          bWins: shadowEvaluations.bWins,
          draws: shadowEvaluations.draws,
          winRateLb: shadowEvaluations.winRateLb,
          status: shadowEvaluations.status,
          decision: shadowEvaluations.decision,
          errorMessage: shadowEvaluations.errorMessage,
          startedAt: shadowEvaluations.startedAt,
          completedAt: shadowEvaluations.completedAt,
        });

      return {
        kind: "ok" as const,
        shadow: created,
        pairwiseIds: plan.pairwiseRows.map((row) => row.id),
      };
    });

    if (result.kind === "not_found") return c.json({ error: "coach proposal not found" }, 404);
    if (result.kind === "parent_not_found") return c.json({ error: "parent style not found" }, 404);
    if (result.kind === "candidate_not_found") return c.json({ error: "derived style not found" }, 404);
    if (result.kind === "no_pairwise") {
      return c.json({ error: "no pairwise matches found for parent and derived style" }, 409);
    }
    if (result.kind === "blocked") return c.json({ error: result.error }, 409);
    if (!result.shadow) return c.json({ error: "shadow evaluation was not created" }, 500);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.shadow_evaluation.create",
      targetKind: "coach_proposal",
      targetId: String(id),
      details: {
        shadowEvaluationId: result.shadow.id,
        parentStyleSlug: result.shadow.parentStyleSlug,
        newStyleSlug: result.shadow.newStyleSlug,
        pairsDone: result.shadow.pairsDone,
        pairwiseIds: result.pairwiseIds,
        decision: result.shadow.decision,
      },
    });

    return c.json({ ok: true, shadow: result.shadow });
  });

  app.post("/api/admin/quality/coach/proposals/:id/shadow-evaluations/run", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);

    const body = await c.req
      .json<QualityShadowEvaluationRunBody>()
      .catch((): QualityShadowEvaluationRunBody => ({}));
    const runs = parseOptionalBodyInteger(body.runs, 1, 20);
    if (runs.kind === "invalid") {
      return c.json({ error: "runs must be an integer between 1 and 20" }, 400);
    }
    const maxTurns = parseOptionalBodyInteger(body.maxTurns, 1, 20);
    if (maxTurns.kind === "invalid") {
      return c.json({ error: "maxTurns must be an integer between 1 and 20" }, 400);
    }
    const newStyleSlugInput = parseOptionalBodyString(body.newStyleSlug);
    if (newStyleSlugInput.kind === "invalid") {
      return c.json({ error: "newStyleSlug must be a non-empty string" }, 400);
    }
    const reflect = parseOptionalBodyBoolean(body.reflect);
    if (reflect.kind === "invalid") return c.json({ error: "reflect must be a boolean" }, 400);
    const personaSlugs = parseOptionalPersonaSlugs(body.personas);
    if (personaSlugs.kind === "invalid") {
      return c.json({ error: "personas must be a non-empty array of persona slugs" }, 400);
    }

    const planResult = await withTenant(opts.db, tenantId, (tx) =>
      resolveShadowEvaluationPlan(tx, {
        tenantId,
        proposalId: id,
        newStyleSlug: newStyleSlugInput.value,
        limit: 1,
      }),
    );
    if (planResult.kind === "not_found") return c.json({ error: "coach proposal not found" }, 404);
    if (planResult.kind === "parent_not_found") return c.json({ error: "parent style not found" }, 404);
    if (planResult.kind === "candidate_not_found") return c.json({ error: "derived style not found" }, 404);
    if (planResult.kind === "blocked") return c.json({ error: planResult.error }, 409);

    const parentStyle = parseStyleFromShadowPlanRow(planResult.plan.parentStyle);
    if (parentStyle.kind === "invalid") {
      return c.json({ error: "parent style failed schema validation", issues: parentStyle.issues }, 422);
    }
    const candidateStyle = parseStyleFromShadowPlanRow(planResult.plan.candidateStyle);
    if (candidateStyle.kind === "invalid") {
      return c.json({ error: "candidate style failed schema validation", issues: candidateStyle.issues }, 422);
    }

    const selectedPersonaSlugs =
      personaSlugs.value ??
      (planResult.plan.proposal.personaFilter &&
      CANDIDATE_BY_SLUG.has(planResult.plan.proposal.personaFilter)
        ? [planResult.plan.proposal.personaFilter]
        : CANDIDATE_PERSONAS.map((persona) => persona.slug));
    const personas = selectedPersonaSlugs.map((slug) => CANDIDATE_BY_SLUG.get(slug));
    if (personas.some((persona) => !persona)) return c.json({ error: "persona not found" }, 404);

    const depsResult = await buildQualityRunnerDeps(opts, tenantId, reflect.value ?? false);
    if (depsResult.kind === "unavailable") return c.json({ error: depsResult.error }, 503);

    const resolvedRuns = runs.value ?? 1;
    const resolvedMaxTurns = maxTurns.value ?? 6;
    const pairsPlanned = personas.length * resolvedRuns;
    const now = nowEpoch();
    const created = await withTenant(opts.db, tenantId, async (tx) => {
      const [row] = await tx
        .insert(shadowEvaluations)
        .values({
          tenantId,
          proposalId: planResult.plan.proposal.id,
          parentStyleSlug: planResult.plan.parentStyle.slug,
          parentStyleId: planResult.plan.parentStyle.id,
          newStyleSlug: planResult.plan.candidateStyle.slug,
          newStyleId: planResult.plan.candidateStyle.id,
          pairsPlanned,
          pairsDone: 0,
          aWins: 0,
          bWins: 0,
          draws: 0,
          winRateLb: null,
          status: "running",
          decision: null,
          errorMessage: null,
          startedAt: now,
          completedAt: null,
        })
        .returning(shadowEvaluationResponseSelect);
      return row ?? null;
    });
    if (!created) return c.json({ error: "shadow evaluation was not created" }, 500);

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "quality.shadow_evaluation.run",
      targetKind: "coach_proposal",
      targetId: String(id),
      details: {
        shadowEvaluationId: created.id,
        parentStyleSlug: created.parentStyleSlug,
        newStyleSlug: created.newStyleSlug,
        runs: resolvedRuns,
        maxTurns: resolvedMaxTurns,
        personas: selectedPersonaSlugs,
        pairsPlanned,
      },
    });

    void runShadowEval(
      {
        ...depsResult.deps,
        shadowRepo: makeShadowEvaluationRepo(opts.db, tenantId),
      },
      {
        evalId: created.id,
        parentStyle: parentStyle.style,
        parentStyleId: planResult.plan.parentStyle.id,
        newStyle: candidateStyle.style,
        newStyleId: planResult.plan.candidateStyle.id,
        personas: personas.filter(isPresentPersona),
        runs: resolvedRuns,
        maxTurns: resolvedMaxTurns,
      },
    ).catch((err) => {
      console.warn(
        `[quality-shadow] failed to run shadow eval #${created.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    return c.json({ ok: true, shadow: created }, 202);
  });

  /**
   * GET /api/admin/quality/self-play/export.jsonl
   *
   * Query:
   *   styleSlug?: string
   *   personaSlug?: string
   *   outcome?: won|lost|draw
   *   limit?: 1..1000 (default 200)
   *   includeTranscript?: false|0|no to omit transcript
   */
  app.get("/api/admin/quality/self-play/export.jsonl", async (c) => {
    const tenantId = c.var.tenantId;
    const styleSlug = optionalQuery(c.req.query("styleSlug"));
    const personaSlug = optionalQuery(c.req.query("personaSlug"));
    const outcomeRaw = optionalQuery(c.req.query("outcome"));
    if (outcomeRaw && !OUTCOMES.has(outcomeRaw as EloOutcome)) {
      return c.json({ error: "outcome must be one of: won, lost, draw" }, 400);
    }
    const outcome = outcomeRaw as EloOutcome | undefined;
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be an integer between 1 and 1000" }, 400);
    const includeTranscript = parseIncludeTranscript(c.req.query("includeTranscript"));

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const filters = [eq(selfPlayMatches.tenantId, tenantId)];
      if (styleSlug) filters.push(eq(selfPlayMatches.styleSlug, styleSlug));
      if (personaSlug) filters.push(eq(selfPlayMatches.personaSlug, personaSlug));
      if (outcome) filters.push(eq(selfPlayMatches.outcome, outcome));

      return tx
        .select({
          id: selfPlayMatches.id,
          styleSlug: selfPlayMatches.styleSlug,
          personaSlug: selfPlayMatches.personaSlug,
          outcome: selfPlayMatches.outcome,
          judgeReason: selfPlayMatches.judgeReason,
          transcriptJson: selfPlayMatches.transcriptJson,
          turns: selfPlayMatches.turns,
          skillsJson: selfPlayMatches.skillsJson,
          leadId: selfPlayMatches.leadId,
          fabricationsCaught: selfPlayMatches.fabricationsCaught,
          createdAt: selfPlayMatches.createdAt,
        })
        .from(selfPlayMatches)
        .where(and(...filters))
        .orderBy(desc(selfPlayMatches.createdAt), desc(selfPlayMatches.id))
        .limit(limit);
    });

    const exportedAt = new Date().toISOString();
    const jsonl = rows
      .map((row) =>
        exportSelfPlayMatchJsonl(toSelfPlayResult(row), {
          exportedAt,
          includeTranscript,
          source: "admin-api",
        }).trimEnd(),
      )
      .join("\n");
    const body = jsonl ? `${jsonl}\n` : "";

    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="self-play-matches.jsonl"',
      },
    });
  });

  app.get("/api/admin/quality/pairwise/export.jsonl", async (c) => {
    const tenantId = c.var.tenantId;
    const styleASlug = optionalQuery(c.req.query("styleASlug"));
    const styleBSlug = optionalQuery(c.req.query("styleBSlug"));
    const personaSlug = optionalQuery(c.req.query("personaSlug"));
    const winnerRaw = optionalQuery(c.req.query("winner"));
    if (winnerRaw && !PAIRWISE_WINNERS.has(winnerRaw as PairwiseWinner)) {
      return c.json({ error: "winner must be one of: a, b, draw" }, 400);
    }
    const winner = winnerRaw as PairwiseWinner | undefined;
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be an integer between 1 and 1000" }, 400);
    const includeTranscript = parseIncludeTranscript(c.req.query("includeTranscript"));

    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      const filters = [eq(pairwiseMatches.tenantId, tenantId)];
      if (styleASlug) filters.push(eq(pairwiseMatches.styleASlug, styleASlug));
      if (styleBSlug) filters.push(eq(pairwiseMatches.styleBSlug, styleBSlug));
      if (personaSlug) filters.push(eq(pairwiseMatches.personaSlug, personaSlug));
      if (winner) filters.push(eq(pairwiseMatches.winner, winner));

      const pairwiseRows = await tx
        .select({
          id: pairwiseMatches.id,
          styleASlug: pairwiseMatches.styleASlug,
          styleBSlug: pairwiseMatches.styleBSlug,
          personaSlug: pairwiseMatches.personaSlug,
          winner: pairwiseMatches.winner,
          judgeReason: pairwiseMatches.judgeReason,
          matchAId: pairwiseMatches.matchAId,
          matchBId: pairwiseMatches.matchBId,
          eloAAfter: pairwiseMatches.eloAAfter,
          eloBAfter: pairwiseMatches.eloBAfter,
          createdAt: pairwiseMatches.createdAt,
        })
        .from(pairwiseMatches)
        .where(and(...filters))
        .orderBy(desc(pairwiseMatches.createdAt), desc(pairwiseMatches.id))
        .limit(limit);

      const matchIds = [
        ...new Set(
          pairwiseRows.flatMap((row) => [row.matchAId, row.matchBId]).filter(isPresentId),
        ),
      ];
      const selfPlayRows = matchIds.length
        ? await tx
            .select({
              id: selfPlayMatches.id,
              styleSlug: selfPlayMatches.styleSlug,
              personaSlug: selfPlayMatches.personaSlug,
              outcome: selfPlayMatches.outcome,
              judgeReason: selfPlayMatches.judgeReason,
              transcriptJson: selfPlayMatches.transcriptJson,
              turns: selfPlayMatches.turns,
              skillsJson: selfPlayMatches.skillsJson,
              leadId: selfPlayMatches.leadId,
              fabricationsCaught: selfPlayMatches.fabricationsCaught,
              createdAt: selfPlayMatches.createdAt,
            })
            .from(selfPlayMatches)
            .where(and(eq(selfPlayMatches.tenantId, tenantId), inArray(selfPlayMatches.id, matchIds)))
        : [];

      const byId = new Map(selfPlayRows.map((row) => [row.id, row]));
      return pairwiseRows.map((row) => ({
        ...row,
        matchA: row.matchAId ? byId.get(row.matchAId) : undefined,
        matchB: row.matchBId ? byId.get(row.matchBId) : undefined,
      }));
    });

    const exportedAt = new Date().toISOString();
    const jsonl = rows
      .map((row) =>
        exportPairwiseMatchJsonl(toPairwiseResult(row), {
          exportedAt,
          includeTranscript,
          source: "admin-api",
        }).trimEnd(),
      )
      .join("\n");
    const body = jsonl ? `${jsonl}\n` : "";

    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="pairwise-matches.jsonl"',
      },
    });
  });

  return app;
}

type QualitySelfPlayRunBody = {
  styleSlug?: unknown;
  personaSlug?: unknown;
  maxTurns?: unknown;
  reflect?: unknown;
};

type QualityPairwiseRunBody = {
  styleASlug?: unknown;
  styleBSlug?: unknown;
  personaSlug?: unknown;
  maxTurns?: unknown;
  reflect?: unknown;
};

type QualityCoachProposalGenerateBody = {
  styleSlug?: unknown;
  sampleSize?: unknown;
  personaSlug?: unknown;
  model?: unknown;
};

type QualityShadowEvaluationRunBody = {
  runs?: unknown;
  personas?: unknown;
  maxTurns?: unknown;
  newStyleSlug?: unknown;
  reflect?: unknown;
};

type QualityStyleLoadResult =
  | { kind: "ok"; styleId: number; style: Style }
  | { kind: "not_found" }
  | { kind: "invalid"; issues: unknown[] };

async function loadQualityStyle(
  db: Db,
  tenantId: number,
  slug: string,
): Promise<QualityStyleLoadResult> {
  const row = await withTenant(db, tenantId, async (tx) => {
    const [styleRow] = await tx
      .select({
        id: styles.id,
        slug: styles.slug,
        displayName: styles.displayName,
        configJson: styles.configJson,
      })
      .from(styles)
      .where(
        and(
          eq(styles.tenantId, tenantId),
          eq(styles.slug, slug),
          eq(styles.isActive, true),
          sql`${styles.deletedAt} IS NULL`,
        ),
      )
      .limit(1);
    return styleRow ?? null;
  });
  if (!row) return { kind: "not_found" };

  const raw = parseJsonValue(row.configJson, null);
  const normalized =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...raw, slug: row.slug, displayName: row.displayName }
      : raw;
  const parsed = StyleSchema.safeParse(normalized);
  if (!parsed.success) {
    return { kind: "invalid", issues: parsed.error.issues.slice(0, 5) };
  }
  return { kind: "ok", styleId: row.id, style: parsed.data };
}

type QualityRunnerDepsResult =
  | { kind: "ok"; deps: PairwiseDeps }
  | { kind: "unavailable"; error: string };

async function buildQualityRunnerDeps(
  opts: AdminQualityRoutesOpts,
  tenantId: number,
  reflect: boolean | undefined,
): Promise<QualityRunnerDepsResult> {
  const salesChat = resolveRequiredQualityDep(opts.resolveChat, tenantId);
  if (!salesChat) return { kind: "unavailable", error: "chat LLM is not configured" };

  const embedder = resolveRequiredQualityDep(opts.resolveEmbedder, tenantId);
  if (!embedder) return { kind: "unavailable", error: "embed LLM is not configured" };

  const kb =
    resolveRequiredQualityDep(opts.resolveKb, tenantId) ??
    makeTenantScopedKbStore(opts.db, tenantId);
  const candidateChat =
    resolveOptionalQualityDep(opts.resolveCandidateChat, tenantId) ?? salesChat;
  const judgeChat = resolveOptionalQualityDep(opts.resolveJudgeChat, tenantId) ?? salesChat;
  const vacanciesBlock = await buildActiveVacanciesBlock(opts.db, tenantId);

  const deps: PairwiseDeps = {
    ...makeQualityStorageAdapters(opts.db, tenantId),
    kb,
    salesChat,
    candidateChat,
    judgeChat,
    embedder,
    ...(reflect !== undefined ? { reflect } : {}),
    ...(vacanciesBlock ? { vacanciesBlock } : {}),
  };
  return { kind: "ok", deps };
}

function resolveRequiredQualityDep<T>(
  resolver: ((tenantId: number) => T) | undefined,
  tenantId: number,
): T | null {
  if (!resolver) return null;
  try {
    return resolver(tenantId);
  } catch {
    return null;
  }
}

function resolveOptionalQualityDep<T>(
  resolver: ((tenantId: number) => T | null) | undefined,
  tenantId: number,
): T | null {
  if (!resolver) return null;
  try {
    return resolver(tenantId);
  } catch {
    return null;
  }
}

function makeTenantScopedKbStore(db: Db, tenantId: number): IKbStore {
  return {
    search: (embedding, k, topic) =>
      withTenant(db, tenantId, (tx) =>
        new DrizzleKbStore({ db: tx as Db, tenantId }).search(embedding, k, topic),
      ),
    hybridSearch: (input) =>
      withTenant(db, tenantId, (tx) =>
        new DrizzleKbStore({ db: tx as Db, tenantId }).hybridSearch(input),
      ),
    prioritySearch: (input) =>
      withTenant(db, tenantId, (tx) =>
        new DrizzleKbStore({ db: tx as Db, tenantId }).prioritySearch(input),
      ),
  } as IKbStore;
}

function makeQualityStorageAdapters(
  db: Db,
  tenantId: number,
): Omit<SelfPlayDeps, "kb" | "salesChat" | "candidateChat" | "judgeChat" | "embedder"> &
  Pick<PairwiseDeps, "pairwiseMatches"> {
  const styleSlugCache = new Map<number, string>();

  async function styleSlugById(styleId: number): Promise<string | null> {
    const cached = styleSlugCache.get(styleId);
    if (cached) return cached;
    const slug = await withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select({ slug: styles.slug })
        .from(styles)
        .where(and(eq(styles.tenantId, tenantId), eq(styles.id, styleId)))
        .limit(1);
      return row?.slug ?? null;
    });
    if (slug) styleSlugCache.set(styleId, slug);
    return slug;
  }

  const ratings = {
    getRating: async (styleId: number): Promise<number> => {
      const slug = await styleSlugById(styleId);
      if (!slug) return 1500;
      return getStyleRatingBySlug(db, tenantId, slug);
    },
    setRating: async (styleId: number, rating: number): Promise<void> => {
      const slug = await styleSlugById(styleId);
      if (!slug) return;
      await setStyleRatingBySlug(db, tenantId, slug, rating);
    },
  };

  return {
    users: {
      upsert: async (input) =>
        withTenant(db, tenantId, async (tx) => {
          const now = nowEpoch();
          const [created] = await tx
            .insert(contacts)
            .values({
              tenantId,
              displayName: `Self-play ${Math.abs(input.telegramId)}`,
              attributesJson: JSON.stringify({
                source: "self_play",
                telegramId: input.telegramId,
                ...(input.username ? { username: input.username } : {}),
              }),
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: contacts.id });
          if (!created) throw new Error("self-play contact was not created");
          return created;
        }),
    },
    conversations: {
      create: async (input) =>
        withTenant(db, tenantId, async (tx) => {
          const now = nowEpoch();
          const [styleRow] = await tx
            .select({ id: styles.id })
            .from(styles)
            .where(and(eq(styles.tenantId, tenantId), eq(styles.slug, input.styleSlug)))
            .limit(1);
          const [created] = await tx
            .insert(conversations)
            .values({
              tenantId,
              userId: input.userId,
              source: "self_play",
              mode: "ai",
              status: "resolved",
              styleId: styleRow?.id ?? null,
              lastMessageAt: now,
              createdAt: now,
              metaJson: JSON.stringify({ qualityLab: true, styleSlug: input.styleSlug }),
            })
            .returning({ id: conversations.id });
          if (!created) throw new Error("self-play conversation was not created");
          return created;
        }),
    },
    leads: {
      create: async (input) =>
        withTenant(db, tenantId, async (tx) => {
          const now = nowEpoch();
          const [conversation] = await tx
            .select({ id: conversations.id, userId: conversations.userId })
            .from(conversations)
            .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, input.conversationId)))
            .limit(1);
          if (!conversation) throw new Error("self-play conversation not found");
          const [created] = await tx
            .insert(leads)
            .values({
              tenantId,
              userId: conversation.userId,
              state: "self_play",
              intakeJson: JSON.stringify({ sourceConversationId: conversation.id }),
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: leads.id });
          if (!created) throw new Error("self-play lead was not created");
          return created;
        }),
    },
    skills: {
      skillsForStyle: async (styleId) =>
        withTenant(db, tenantId, async (tx) => {
          const rows = await tx
            .select({
              slug: skills.slug,
              family: skills.family,
              displayName: skills.displayName,
              promptFragment: skills.promptFragment,
              applicableStagesJson: skills.applicableStagesJson,
              isEnabled: skills.isEnabled,
            })
            .from(styleSkills)
            .innerJoin(skills, eq(styleSkills.skillId, skills.id))
            .where(
              and(
                eq(styleSkills.tenantId, tenantId),
                eq(styleSkills.styleId, styleId),
                eq(skills.tenantId, tenantId),
              ),
            );
          return rows.map((row) => ({
            slug: row.slug,
            family: row.family,
            display_name: row.displayName,
            prompt_fragment: row.promptFragment,
            applicable_stages: parseStringArray(row.applicableStagesJson),
            is_enabled: row.isEnabled,
          }));
        }),
    },
    outcomes: {
      record: async (input) => {
        await withTenant(db, tenantId, async (tx) => {
          await tx
            .insert(skillOutcomes)
            .values({
              tenantId,
              leadId: input.leadId,
              styleSlug: input.styleSlug,
              skillSlug: input.skillSlug,
              outcome: input.outcome,
              source: input.source,
              createdAt: nowEpoch(),
            })
            .onConflictDoNothing({
              target: [skillOutcomes.leadId, skillOutcomes.skillSlug, skillOutcomes.source],
            });
        });
      },
      aggregates: async (slugs) => {
        if (slugs.length === 0) return [];
        return withTenant(db, tenantId, async (tx) => {
          const rows = await tx
            .select({
              skillSlug: skillOutcomes.skillSlug,
              wins: sql<number>`(count(*) filter (where ${skillOutcomes.outcome} = 'won'))::int`,
              losses: sql<number>`(count(*) filter (where ${skillOutcomes.outcome} = 'lost'))::int`,
              draws: sql<number>`(count(*) filter (where ${skillOutcomes.outcome} = 'draw'))::int`,
              count: sql<number>`count(*)::int`,
            })
            .from(skillOutcomes)
            .where(
              and(
                eq(skillOutcomes.tenantId, tenantId),
                inArray(skillOutcomes.skillSlug, [...slugs]),
              ),
            )
            .groupBy(skillOutcomes.skillSlug);
          return rows.map((row) => ({
            skill_slug: row.skillSlug,
            wins: row.wins,
            losses: row.losses,
            draws: row.draws,
            count: row.count,
          }));
        });
      },
    },
    ratings,
    matches: {
      insert: async (match) =>
        withTenant(db, tenantId, async (tx) => {
          const [created] = await tx
            .insert(selfPlayMatches)
            .values({
              tenantId,
              styleSlug: match.style_slug,
              personaSlug: match.persona_slug,
              outcome: match.outcome,
              judgeReason: match.judge_reason,
              transcriptJson: JSON.stringify(match.transcript),
              turns: Math.ceil(match.transcript.length / 2),
              skillsJson: JSON.stringify(match.skills),
              createdAt: nowEpoch(),
            })
            .returning({ id: selfPlayMatches.id });
          if (!created) throw new Error("self-play match was not created");
          return created.id;
        }),
      byId: async (id) =>
        withTenant(db, tenantId, async (tx) => {
          const [row] = await tx
            .select(selfPlayMatchSelect)
            .from(selfPlayMatches)
            .where(and(eq(selfPlayMatches.tenantId, tenantId), eq(selfPlayMatches.id, id)))
            .limit(1);
          return row ? toSelfPlayRecord(row) : null;
        }),
      list: async (input) =>
        withTenant(db, tenantId, async (tx) => {
          const filters = [
            eq(selfPlayMatches.tenantId, tenantId),
            eq(selfPlayMatches.styleSlug, input.styleSlug),
          ];
          if (input.outcome) filters.push(eq(selfPlayMatches.outcome, input.outcome));
          if (input.personaSlug) filters.push(eq(selfPlayMatches.personaSlug, input.personaSlug));
          const rows = await tx
            .select(selfPlayMatchSelect)
            .from(selfPlayMatches)
            .where(and(...filters))
            .orderBy(desc(selfPlayMatches.createdAt), desc(selfPlayMatches.id))
            .limit(input.limit ?? 50);
          return rows.map(toSelfPlaySummaryRecord);
        }),
    },
    pairwiseMatches: {
      insert: async (input) => {
        const [eloAAfter, eloBAfter] = await Promise.all([
          getStyleRatingBySlug(db, tenantId, input.styleASlug),
          getStyleRatingBySlug(db, tenantId, input.styleBSlug),
        ]);
        return withTenant(db, tenantId, async (tx) => {
          const [created] = await tx
            .insert(pairwiseMatches)
            .values({
              tenantId,
              styleASlug: input.styleASlug,
              styleBSlug: input.styleBSlug,
              personaSlug: input.personaSlug,
              winner: input.winner,
              judgeReason: input.reason,
              matchAId: input.matchAId > 0 ? input.matchAId : null,
              matchBId: input.matchBId > 0 ? input.matchBId : null,
              eloAAfter,
              eloBAfter,
              createdAt: nowEpoch(),
            })
            .returning({ id: pairwiseMatches.id });
          if (!created) throw new Error("pairwise match was not created");
          return created.id;
        });
      },
    },
  };
}

async function getStyleRatingBySlug(db: Db, tenantId: number, styleSlug: string): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ elo: styleRatings.elo })
      .from(styleRatings)
      .where(and(eq(styleRatings.tenantId, tenantId), eq(styleRatings.styleSlug, styleSlug)))
      .limit(1);
    return row?.elo ?? 1500;
  });
}

async function setStyleRatingBySlug(
  db: Db,
  tenantId: number,
  styleSlug: string,
  elo: number,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .insert(styleRatings)
      .values({
        tenantId,
        styleSlug,
        elo,
        updatedAt: nowEpoch(),
      })
      .onConflictDoUpdate({
        target: styleRatings.styleSlug,
        set: {
          tenantId,
          elo,
          updatedAt: nowEpoch(),
        },
      });
  });
}

async function buildActiveVacanciesBlock(db: Db, tenantId: number): Promise<string | undefined> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        title: vacancies.title,
        body: vacancies.body,
        url: vacancies.url,
      })
      .from(vacancies)
      .where(and(eq(vacancies.tenantId, tenantId), eq(vacancies.isActive, true)))
      .orderBy(desc(vacancies.updatedAt), desc(vacancies.id))
      .limit(8),
  );
  if (rows.length === 0) return undefined;
  return rows
    .map((row, index) => {
      const url = row.url ? `\nURL: ${row.url}` : "";
      return `VACANCY ${index + 1}: ${row.title}\n${row.body}${url}`;
    })
    .join("\n\n");
}

async function syncPersistedSelfPlayResult(
  db: Db,
  tenantId: number,
  match: SelfPlayMatchResult,
): Promise<void> {
  if (!match.matchId) return;
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .update(selfPlayMatches)
      .set({
        leadId: match.leadId > 0 ? match.leadId : null,
        turns: match.turns,
        fabricationsCaught: match.fabricationsCaught,
        skillsJson: JSON.stringify(match.skillsAttributed),
      })
      .where(and(eq(selfPlayMatches.tenantId, tenantId), eq(selfPlayMatches.id, match.matchId ?? 0)));
  });
}

function withWinRate<T extends { total: number; won: number }>(row: T): T & { winRate: number } {
  return {
    ...row,
    winRate: row.total > 0 ? Math.round((row.won / row.total) * 1000) / 10 : 0,
  };
}

function withPairwiseRates<T extends { total: number; aWins: number; bWins: number }>(
  row: T,
): T & { aWinRate: number; bWinRate: number } {
  return {
    ...row,
    aWinRate: row.total > 0 ? Math.round((row.aWins / row.total) * 1000) / 10 : 0,
    bWinRate: row.total > 0 ? Math.round((row.bWins / row.total) * 1000) / 10 : 0,
  };
}

function isPresentId(value: number | null): value is number {
  return typeof value === "number" && value > 0;
}

function optionalQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseLimit(value: string | undefined): number | null {
  if (!value) return 200;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return null;
  return parsed;
}

function parsePositiveIntQuery(
  raw: string | undefined,
  fallback: number,
  max: number,
): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

function parsePositiveParamId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseOptionalPositiveIntQuery(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseOptionalToolFeedbackNote(
  value: unknown,
): { kind: "ok"; value: string | null } | { kind: "invalid" } {
  if (value === undefined || value === null) return { kind: "ok", value: null };
  if (typeof value !== "string") return { kind: "invalid" };
  const trimmed = value.trim();
  if (trimmed.length > 2000) return { kind: "invalid" };
  return { kind: "ok", value: trimmed || null };
}

function toAgentToolCallFeedbackResponse(row: AgentToolCallFeedbackRow) {
  return {
    id: row.id,
    toolCallId: row.toolCallId,
    adminId: row.adminId,
    label: row.label,
    note: row.note,
    createdAt: row.createdAt,
  };
}

type ToolCallFeedbackQuery = {
  limit: number;
  source?: AgentToolCallSource;
  toolName?: string;
  label?: AgentToolCallFeedbackLabel;
  error?: boolean;
};

type ToolCallFeedbackJoinedRow = {
  feedbackId: number;
  feedbackToolCallId: number;
  adminId: number | null;
  label: string;
  note: string | null;
  feedbackCreatedAt: number;
  traceId: number;
  conversationId: number;
  contactId: number | null;
  messageId: number | null;
  outboundQueueId: number | null;
  source: string;
  toolName: string;
  argsJson: string;
  resultJson: string;
  error: boolean;
  cycle: number;
  toolCallIndex: number;
  latencyMs: number | null;
  toolCallCreatedAt: number;
};

type ToolCallFeedbackTotals = {
  total: number;
  goodReply: number;
  wrongTool: number;
  missingTool: number;
  badArgs: number;
  other: number;
  errorCount: number;
  lastFeedbackAt: number | null;
};

function parseToolCallFeedbackQuery(
  raw: {
    limit?: string;
    source?: string;
    toolName?: string;
    label?: string;
    error?: string;
  },
  defaultLimit: number,
  maxLimit: number,
): { kind: "ok"; value: ToolCallFeedbackQuery } | { kind: "invalid"; error: string } {
  const limit = parsePositiveIntQuery(raw.limit, defaultLimit, maxLimit);
  if (limit === null) return { kind: "invalid", error: "invalid limit" };

  const source =
    raw.source && TOOL_CALL_SOURCES.has(raw.source as AgentToolCallSource)
      ? (raw.source as AgentToolCallSource)
      : undefined;
  if (raw.source && !source) return { kind: "invalid", error: "invalid source" };

  const label =
    raw.label && TOOL_CALL_FEEDBACK_LABELS.has(raw.label as AgentToolCallFeedbackLabel)
      ? (raw.label as AgentToolCallFeedbackLabel)
      : undefined;
  if (raw.label && !label) return { kind: "invalid", error: "invalid label" };

  const error =
    raw.error === undefined
      ? undefined
      : raw.error === "true"
        ? true
        : raw.error === "false"
          ? false
          : null;
  if (error === null) return { kind: "invalid", error: "invalid error" };

  const toolName = raw.toolName?.trim();
  if (toolName !== undefined && toolName.length === 0) {
    return { kind: "invalid", error: "invalid toolName" };
  }

  return {
    kind: "ok",
    value: {
      limit,
      ...(source !== undefined ? { source } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(error !== undefined ? { error } : {}),
    },
  };
}

function toolCallFeedbackJoinOn() {
  return and(
    eq(agentToolCallFeedback.tenantId, agentToolCalls.tenantId),
    eq(agentToolCallFeedback.toolCallId, agentToolCalls.id),
  );
}

function toolCallFeedbackWhere(
  tenantId: number,
  filters: ToolCallFeedbackQuery,
): SQL<unknown> | undefined {
  const conditions: SQL<unknown>[] = [
    eq(agentToolCallFeedback.tenantId, tenantId),
    eq(agentToolCalls.tenantId, tenantId),
  ];
  if (filters.source !== undefined) {
    conditions.push(eq(agentToolCalls.source, filters.source));
  }
  if (filters.toolName !== undefined) {
    conditions.push(eq(agentToolCalls.toolName, filters.toolName));
  }
  if (filters.label !== undefined) {
    conditions.push(eq(agentToolCallFeedback.label, filters.label));
  }
  if (filters.error !== undefined) {
    conditions.push(eq(agentToolCalls.error, filters.error));
  }
  return and(...conditions);
}

function emptyToolCallFeedbackTotals(): ToolCallFeedbackTotals {
  return {
    total: 0,
    goodReply: 0,
    wrongTool: 0,
    missingTool: 0,
    badArgs: 0,
    other: 0,
    errorCount: 0,
    lastFeedbackAt: null,
  };
}

function withAllToolFeedbackLabels(
  rows: Array<{
    label: string;
    total: number;
    lastFeedbackAt: number | null;
  }>,
) {
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  return Array.from(TOOL_CALL_FEEDBACK_LABELS).map((label) => {
    const row = byLabel.get(label);
    return {
      label: label as AgentToolCallFeedbackLabel,
      total: row?.total ?? 0,
      lastFeedbackAt: row?.lastFeedbackAt ?? null,
    };
  });
}

function toAgentToolCallResponse(row: AgentToolCallRow) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    contactId: row.contactId,
    messageId: row.messageId,
    outboundQueueId: row.outboundQueueId,
    source: row.source,
    toolName: row.toolName,
    args: parseJsonValue(row.argsJson, null),
    result: parseJsonValue(row.resultJson, null),
    error: row.error,
    cycle: row.cycle,
    toolCallIndex: row.toolCallIndex,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}

function toToolCallFeedbackJoinedResponse(row: ToolCallFeedbackJoinedRow) {
  return {
    feedback: {
      id: row.feedbackId,
      toolCallId: row.feedbackToolCallId,
      adminId: row.adminId,
      label: row.label as AgentToolCallFeedbackLabel,
      note: row.note,
      createdAt: row.feedbackCreatedAt,
    },
    toolCall: {
      id: row.traceId,
      conversationId: row.conversationId,
      contactId: row.contactId,
      messageId: row.messageId,
      outboundQueueId: row.outboundQueueId,
      source: row.source as AgentToolCallSource,
      toolName: row.toolName,
      args: parseJsonValue(row.argsJson, null),
      result: parseJsonValue(row.resultJson, null),
      error: row.error,
      cycle: row.cycle,
      toolCallIndex: row.toolCallIndex,
      latencyMs: row.latencyMs,
      createdAt: row.toolCallCreatedAt,
    },
  };
}

function toToolCallFeedbackExportRecord(row: ToolCallFeedbackJoinedRow) {
  return {
    id: row.feedbackId,
    toolCallId: row.traceId,
    adminId: row.adminId,
    label: row.label,
    note: row.note,
    feedbackCreatedAt: row.feedbackCreatedAt,
    conversationId: row.conversationId,
    contactId: row.contactId,
    messageId: row.messageId,
    outboundQueueId: row.outboundQueueId,
    source: row.source,
    toolName: row.toolName,
    args: parseJsonValue(row.argsJson, null),
    result: parseJsonValue(row.resultJson, null),
    error: row.error,
    cycle: row.cycle,
    toolCallIndex: row.toolCallIndex,
    latencyMs: row.latencyMs,
    toolCallCreatedAt: row.toolCallCreatedAt,
  };
}

type QualityToolCallFeedbackBody = {
  label?: unknown;
  note?: unknown;
};

function parseIncludeTranscript(value: string | undefined): boolean {
  if (!value) return true;
  return !["0", "false", "no"].includes(value.trim().toLowerCase());
}

function parseJsonValue(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseOptionalBodyInteger(
  value: unknown,
  min: number,
  max: number,
): { kind: "ok"; value: number | undefined } | { kind: "invalid" } {
  if (value === undefined || value === null || value === "") return { kind: "ok", value: undefined };
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return { kind: "invalid" };
  return { kind: "ok", value: parsed };
}

function parseRequiredBodyString(
  value: unknown,
): { kind: "ok"; value: string } | { kind: "invalid" } {
  const parsed = parseOptionalBodyString(value);
  if (parsed.kind === "invalid" || !parsed.value) return { kind: "invalid" };
  return { kind: "ok", value: parsed.value };
}

function parseOptionalBodyString(
  value: unknown,
): { kind: "ok"; value: string | undefined } | { kind: "invalid" } {
  if (value === undefined || value === null) return { kind: "ok", value: undefined };
  if (typeof value !== "string") return { kind: "invalid" };
  const trimmed = value.trim();
  if (!trimmed) return { kind: "invalid" };
  return { kind: "ok", value: trimmed };
}

function parseOptionalBodyBoolean(
  value: unknown,
): { kind: "ok"; value: boolean | undefined } | { kind: "invalid" } {
  if (value === undefined || value === null || value === "") {
    return { kind: "ok", value: undefined };
  }
  if (typeof value === "boolean") return { kind: "ok", value };
  if (typeof value !== "string") return { kind: "invalid" };
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return { kind: "ok", value: true };
  if (["0", "false", "no", "off"].includes(normalized)) return { kind: "ok", value: false };
  return { kind: "invalid" };
}

function parseOptionalPersonaSlugs(
  value: unknown,
): { kind: "ok"; value: string[] | undefined } | { kind: "invalid" } {
  if (value === undefined || value === null) return { kind: "ok", value: undefined };
  if (!Array.isArray(value) || value.length === 0) return { kind: "invalid" };
  const slugs = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (slugs.some((slug) => !slug)) return { kind: "invalid" };
  return { kind: "ok", value: [...new Set(slugs)] };
}

function isPresentPersona<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function parseStyleFromShadowPlanRow(row: {
  slug: string;
  displayName: string;
  configJson: string;
}): { kind: "ok"; style: Style } | { kind: "invalid"; issues: unknown[] } {
  const raw = parseJsonValue(row.configJson, null);
  const normalized =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...raw, slug: row.slug, displayName: row.displayName }
      : raw;
  const parsed = StyleSchema.safeParse(normalized);
  if (!parsed.success) {
    return { kind: "invalid", issues: parsed.error.issues.slice(0, 5) };
  }
  return { kind: "ok", style: parsed.data };
}

function makeShadowEvaluationRepo(db: Db, tenantId: number) {
  return {
    update: async (
      evalId: number,
      patch: {
        status?: "running" | "complete" | "failed";
        decision?: "keep" | "rollback" | "inconclusive";
        totalPairs?: number;
        aWins?: number;
        bWins?: number;
        draws?: number;
        winRateLb?: number | null;
        error?: string;
      },
    ): Promise<void> => {
      const set: {
        status?: "running" | "complete" | "failed";
        decision?: "keep" | "rollback" | "inconclusive";
        pairsDone?: number;
        aWins?: number;
        bWins?: number;
        draws?: number;
        winRateLb?: number | null;
        errorMessage?: string;
        completedAt?: number | null;
      } = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.decision !== undefined) set.decision = patch.decision;
      if (patch.totalPairs !== undefined) set.pairsDone = patch.totalPairs;
      if (patch.aWins !== undefined) set.aWins = patch.aWins;
      if (patch.bWins !== undefined) set.bWins = patch.bWins;
      if (patch.draws !== undefined) set.draws = patch.draws;
      if (patch.winRateLb !== undefined) set.winRateLb = patch.winRateLb;
      if (patch.error !== undefined) set.errorMessage = patch.error;
      if (patch.status === "complete" || patch.status === "failed") {
        set.completedAt = nowEpoch();
      }

      await withTenant(db, tenantId, async (tx) => {
        await tx
          .update(shadowEvaluations)
          .set(set)
          .where(and(eq(shadowEvaluations.tenantId, tenantId), eq(shadowEvaluations.id, evalId)));
      });
    },
  };
}

type ShadowEvaluationPairwiseRow = {
  id: number;
  styleASlug: string;
  styleBSlug: string;
  winner: string;
  createdAt: number;
};

type ShadowEvaluationPlan = {
  proposal: {
    id: number;
    styleSlug: string;
    personaFilter: string | null;
    status: string;
  };
  parentStyle: {
    id: number;
    slug: string;
    displayName: string;
    configJson: string;
  };
  candidateStyle: {
    id: number;
    slug: string;
    displayName: string;
    configJson: string;
    parentId: number | null;
  };
  limit: number;
  pairwiseRows: ShadowEvaluationPairwiseRow[];
  pairsDone: number;
  aWins: number;
  bWins: number;
  draws: number;
  bWinsAdjusted: number;
  winRateLb: number | null;
  decision: ReturnType<typeof shadowDecide> | null;
};

type ShadowEvaluationPlanResult =
  | { kind: "ok"; plan: ShadowEvaluationPlan }
  | { kind: "not_found" }
  | { kind: "parent_not_found" }
  | { kind: "candidate_not_found" }
  | { kind: "blocked"; error: string };

async function resolveShadowEvaluationPlan(
  tx: Db,
  input: {
    tenantId: number;
    proposalId: number;
    newStyleSlug?: string;
    limit: number;
  },
): Promise<ShadowEvaluationPlanResult> {
  const [proposal] = await tx
    .select({
      id: coachProposals.id,
      styleSlug: coachProposals.styleSlug,
      personaFilter: coachProposals.personaFilter,
      status: coachProposals.status,
    })
    .from(coachProposals)
    .where(and(eq(coachProposals.id, input.proposalId), eq(coachProposals.tenantId, input.tenantId)))
    .limit(1);

  if (!proposal) return { kind: "not_found" };
  if (proposal.status !== "applied") {
    return {
      kind: "blocked",
      error: `only applied proposals can start shadow evaluation; current status is ${proposal.status}`,
    };
  }

  const [parentStyle] = await tx
    .select({
      id: styles.id,
      slug: styles.slug,
      displayName: styles.displayName,
      configJson: styles.configJson,
    })
    .from(styles)
    .where(
      and(
        eq(styles.tenantId, input.tenantId),
        eq(styles.slug, proposal.styleSlug),
        sql`${styles.deletedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (!parentStyle) return { kind: "parent_not_found" };

  const candidateFilters = [
    eq(styles.tenantId, input.tenantId),
    sql`${styles.deletedAt} IS NULL`,
    input.newStyleSlug ? eq(styles.slug, input.newStyleSlug) : eq(styles.parentId, parentStyle.id),
  ];
  const [candidateStyle] = await tx
    .select({
      id: styles.id,
      slug: styles.slug,
      displayName: styles.displayName,
      configJson: styles.configJson,
      parentId: styles.parentId,
    })
    .from(styles)
    .where(and(...candidateFilters))
    .orderBy(desc(styles.createdAt), desc(styles.id))
    .limit(1);
  if (!candidateStyle || candidateStyle.id === parentStyle.id) {
    return { kind: "candidate_not_found" };
  }

  const pairwiseRows = await tx
    .select({
      id: pairwiseMatches.id,
      styleASlug: pairwiseMatches.styleASlug,
      styleBSlug: pairwiseMatches.styleBSlug,
      winner: pairwiseMatches.winner,
      createdAt: pairwiseMatches.createdAt,
    })
    .from(pairwiseMatches)
    .where(
      and(
        eq(pairwiseMatches.tenantId, input.tenantId),
        or(
          and(
            eq(pairwiseMatches.styleASlug, parentStyle.slug),
            eq(pairwiseMatches.styleBSlug, candidateStyle.slug),
          ),
          and(
            eq(pairwiseMatches.styleASlug, candidateStyle.slug),
            eq(pairwiseMatches.styleBSlug, parentStyle.slug),
          ),
        ),
      ),
    )
    .orderBy(desc(pairwiseMatches.createdAt), desc(pairwiseMatches.id))
    .limit(input.limit);

  const counts = pairwiseRows.reduce(
    (acc, row) => countShadowPairwise(acc, row, parentStyle.slug, candidateStyle.slug),
    { aWins: 0, bWins: 0, draws: 0 },
  );
  const pairsDone = pairwiseRows.length;
  const bWinsAdjusted = counts.bWins + 0.5 * counts.draws;
  const winRateLb = pairsDone > 0 ? wilsonLowerBound(bWinsAdjusted, pairsDone) : null;
  const decision = pairsDone > 0 ? shadowDecide(bWinsAdjusted, pairsDone) : null;

  return {
    kind: "ok",
    plan: {
      proposal,
      parentStyle,
      candidateStyle,
      limit: input.limit,
      pairwiseRows,
      pairsDone,
      aWins: counts.aWins,
      bWins: counts.bWins,
      draws: counts.draws,
      bWinsAdjusted,
      winRateLb,
      decision,
    },
  };
}

function toShadowEvaluationPreview(plan: ShadowEvaluationPlan) {
  const ready = plan.pairsDone > 0;
  return {
    ready,
    proposalId: plan.proposal.id,
    parentStyle: {
      id: plan.parentStyle.id,
      slug: plan.parentStyle.slug,
    },
    candidateStyle: {
      id: plan.candidateStyle.id,
      slug: plan.candidateStyle.slug,
      parentId: plan.candidateStyle.parentId,
    },
    pairwise: {
      limit: plan.limit,
      total: plan.pairsDone,
      aWins: plan.aWins,
      bWins: plan.bWins,
      draws: plan.draws,
      bWinsAdjusted: plan.bWinsAdjusted,
      winRateLb: plan.winRateLb,
      decision: plan.decision,
      recentIds: plan.pairwiseRows.map((row) => row.id),
    },
    missing: ready
      ? null
      : {
          reason: "no_pairwise",
          nextAction: "run_shadow_eval",
          styleASlug: plan.parentStyle.slug,
          styleBSlug: plan.candidateStyle.slug,
        },
  };
}

function countShadowPairwise<T extends { aWins: number; bWins: number; draws: number }>(
  acc: T,
  row: { styleASlug: string; styleBSlug: string; winner: string },
  parentSlug: string,
  newSlug: string,
): T {
  if (row.winner === "draw") {
    acc.draws++;
    return acc;
  }

  const parentIsA = row.styleASlug === parentSlug && row.styleBSlug === newSlug;
  const newIsA = row.styleASlug === newSlug && row.styleBSlug === parentSlug;
  if (parentIsA) {
    if (row.winner === "a") acc.aWins++;
    else if (row.winner === "b") acc.bWins++;
    return acc;
  }
  if (newIsA) {
    if (row.winner === "a") acc.bWins++;
    else if (row.winner === "b") acc.aWins++;
  }
  return acc;
}

async function nextCoachStyleSlug(
  tx: Db,
  parentSlug: string,
  proposalId: number,
): Promise<string> {
  const base = `${sanitizeStyleSlug(parentSlug)}-coach-${proposalId}`.slice(0, 72);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [existing] = await tx
      .select({ id: styles.id })
      .from(styles)
      .where(eq(styles.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 90);
}

function sanitizeStyleSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "style";
}

type SelfPlayMatchRow = {
  id: number;
  styleSlug: string;
  personaSlug: string;
  outcome: string;
  judgeReason: string | null;
  transcriptJson: string;
  turns: number;
  skillsJson: string;
  leadId: number | null;
  fabricationsCaught: number;
};

type PairwiseMatchRow = {
  id: number;
  styleASlug: string;
  styleBSlug: string;
  personaSlug: string;
  winner: string;
  judgeReason: string | null;
  matchAId: number | null;
  matchBId: number | null;
  eloAAfter: number;
  eloBAfter: number;
  matchA?: SelfPlayMatchRow;
  matchB?: SelfPlayMatchRow;
};

type CoachProposalRow = {
  id: number;
  styleSlug: string;
  sampleSize: number;
  personaFilter: string | null;
  summary: string;
  editsJson: string;
  rationaleJson: string;
  rawOutput: string | null;
  status: string;
  createdAt: number;
  decidedAt: number | null;
  decidedByAdminId: number | null;
};

function toCoachProposalResponse(row: CoachProposalRow) {
  return {
    ...row,
    edits: parseJsonValue(row.editsJson, {}),
    rationale: parseStringArray(row.rationaleJson),
  };
}

type ApplyCoachProposalResult =
  | { kind: "ok"; proposal: ReturnType<typeof toCoachProposalResponse>; style: StyleResponseRow; parentStyleId: number }
  | { kind: "not_found" }
  | { kind: "parent_not_found" }
  | { kind: "blocked"; error: string }
  | { kind: "style_create_failed"; error: string }
  | { kind: "invalid_parent_style"; issues: unknown[] }
  | { kind: "invalid_candidate_style"; issues: unknown[] };

type StyleResponseRow = {
  id: number;
  tenantId: number;
  slug: string;
  displayName: string;
  configJson: string;
  isActive: boolean;
  version: number;
  parentId: number | null;
  createdAt: number;
  deletedAt: number | null;
};

function toPairwiseResult(row: PairwiseMatchRow): PairwiseMatchResult {
  const winner = PAIRWISE_WINNERS.has(row.winner as PairwiseWinner)
    ? (row.winner as PairwiseWinner)
    : "draw";
  return {
    styleASlug: row.styleASlug,
    styleBSlug: row.styleBSlug,
    personaSlug: row.personaSlug,
    matchA: row.matchA
      ? toSelfPlayResult(row.matchA)
      : missingSelfPlayResult({
          styleSlug: row.styleASlug,
          personaSlug: row.personaSlug,
          matchId: row.matchAId,
          outcome: winner === "a" ? "won" : winner === "b" ? "lost" : "draw",
        }),
    matchB: row.matchB
      ? toSelfPlayResult(row.matchB)
      : missingSelfPlayResult({
          styleSlug: row.styleBSlug,
          personaSlug: row.personaSlug,
          matchId: row.matchBId,
          outcome: winner === "b" ? "won" : winner === "a" ? "lost" : "draw",
        }),
    verdict: {
      winner,
      reason: row.judgeReason ?? "",
    },
    eloAAfter: row.eloAAfter,
    eloBAfter: row.eloBAfter,
    pairwiseId: row.id,
    persisted: true,
  };
}

function missingSelfPlayResult(input: {
  styleSlug: string;
  personaSlug: string;
  matchId: number | null;
  outcome: EloOutcome;
}): SelfPlayMatchResult {
  return {
    styleSlug: input.styleSlug,
    personaSlug: input.personaSlug,
    turns: 0,
    transcript: [],
    skillsAttributed: [],
    verdict: {
      outcome: input.outcome,
      reason: "self-play match unavailable",
    },
    outcome: input.outcome,
    leadId: -1,
    fabricationsCaught: 0,
    matchId: input.matchId,
    persisted: false,
    warnings: ["self-play match unavailable"],
  };
}

function toSelfPlayResult(row: SelfPlayMatchRow): SelfPlayMatchResult {
  const outcome = OUTCOMES.has(row.outcome as EloOutcome)
    ? (row.outcome as EloOutcome)
    : "draw";
  return {
    styleSlug: row.styleSlug,
    personaSlug: row.personaSlug,
    turns: row.turns,
    transcript: parseTranscript(row.transcriptJson),
    skillsAttributed: parseStringArray(row.skillsJson),
    verdict: {
      outcome,
      reason: row.judgeReason ?? "",
    },
    outcome,
    leadId: row.leadId ?? -1,
    fabricationsCaught: row.fabricationsCaught,
    matchId: row.id,
    persisted: true,
    warnings: [],
  };
}

function toSelfPlaySummaryRecord(row: SelfPlayMatchRow) {
  const outcome = OUTCOMES.has(row.outcome as EloOutcome)
    ? (row.outcome as EloOutcome)
    : "draw";
  return {
    id: row.id,
    style_slug: row.styleSlug,
    persona_slug: row.personaSlug,
    outcome,
    skills: parseStringArray(row.skillsJson),
    judge_reason: row.judgeReason,
  };
}

function toSelfPlayRecord(row: SelfPlayMatchRow) {
  return {
    ...toSelfPlaySummaryRecord(row),
    transcript: parseTranscript(row.transcriptJson),
  };
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseTranscript(raw: string): SelfPlayMatchResult["transcript"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): SelfPlayMatchResult["transcript"][number] | null => {
        if (!item || typeof item !== "object") return null;
        const role = (item as { role?: unknown }).role;
        const text = (item as { text?: unknown }).text;
        if (role !== "candidate" && role !== "salesperson") return null;
        if (typeof text !== "string") return null;
        return { role, text };
      })
      .filter((item): item is SelfPlayMatchResult["transcript"][number] => item !== null);
  } catch {
    return [];
  }
}
