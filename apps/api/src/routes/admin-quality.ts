import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  exportPairwiseMatchJsonl,
  exportSelfPlayMatchJsonl,
  type EloOutcome,
  type PairwiseMatchResult,
  type PairwiseWinner,
  type SelfPlayMatchResult,
} from "@chatman-media/sales";
import {
  coachProposals,
  pairwiseMatches,
  selfPlayMatches,
  shadowEvaluations,
} from "@chatman-media/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";

const OUTCOMES = new Set<EloOutcome>(["won", "lost", "draw"]);
const PAIRWISE_WINNERS = new Set<PairwiseWinner>(["a", "b", "draw"]);
const COACH_PROPOSAL_DECISIONS = new Set(["pending", "dismissed"]);

export interface AdminQualityRoutesOpts {
  db: Db;
}

export function makeAdminQualityRoutes(opts: AdminQualityRoutesOpts): Hono {
  const app = new Hono();

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
