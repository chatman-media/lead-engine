import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  exportSelfPlayMatchJsonl,
  type EloOutcome,
  type SelfPlayMatchResult,
} from "@chatman-media/sales";
import { selfPlayMatches } from "@chatman-media/storage";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

const OUTCOMES = new Set<EloOutcome>(["won", "lost", "draw"]);

export interface AdminQualityRoutesOpts {
  db: Db;
}

export function makeAdminQualityRoutes(opts: AdminQualityRoutesOpts): Hono {
  const app = new Hono();

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

  return app;
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
