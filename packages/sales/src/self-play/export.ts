import type { EloOutcome } from "../elo.ts";
import type {
  ISelfPlayMatchesRepo,
  SelfPlayMatchRecord,
  SelfPlayMatchSummary,
  SelfPlayTurn,
} from "../store.ts";
import type { SelfPlayMatchResult } from "./orchestrator.ts";
import type { PairwiseMatchResult, PairwiseWinner } from "./pairwise.ts";

export const QUALITY_LAB_JSONL_SCHEMA_VERSION = 1 as const;

export interface QualityLabExportOptions {
  /**
   * Stable timestamp for deterministic exports/tests. Defaults to now.
   */
  exportedAt?: Date | string;
  /**
   * Include full dialog transcripts. Defaults to true because self-play
   * transcripts are synthetic quality-lab artifacts; set false for compact
   * dashboards or when exporting mixed data with stricter privacy needs.
   */
  includeTranscript?: boolean;
  /**
   * Free-form producer name, e.g. "admin-api", "nightly-eval", "ci".
   */
  source?: string;
}

export interface ExportSelfPlayMatchesQuery extends QualityLabExportOptions {
  styleSlug: string;
  outcome?: EloOutcome;
  limit?: number;
  personaSlug?: string;
}

export interface QualityLabSelfPlayExport {
  matchId: number | null;
  styleSlug: string;
  personaSlug: string;
  outcome: EloOutcome;
  turns: number | null;
  leadId?: number;
  persisted?: boolean;
  skills: string[];
  judge: {
    outcome: EloOutcome;
    reason: string | null;
  };
  fabricationsCaught?: number;
  warnings?: string[];
  transcript?: SelfPlayTurn[];
  transcriptUnavailable?: true;
}

export interface QualityLabSelfPlayRecord {
  schemaVersion: typeof QUALITY_LAB_JSONL_SCHEMA_VERSION;
  kind: "self_play_match";
  exportedAt: string;
  source?: string;
  match: QualityLabSelfPlayExport;
}

export interface QualityLabPairwiseRecord {
  schemaVersion: typeof QUALITY_LAB_JSONL_SCHEMA_VERSION;
  kind: "pairwise_match";
  exportedAt: string;
  source?: string;
  pairwiseId: number | null;
  styleASlug: string;
  styleBSlug: string;
  personaSlug: string;
  winner: PairwiseWinner;
  reason: string;
  persisted: boolean;
  elo: {
    aAfter: number;
    bAfter: number;
  };
  matchA: QualityLabSelfPlayExport;
  matchB: QualityLabSelfPlayExport;
}

export type QualityLabJsonlRecord =
  | QualityLabSelfPlayRecord
  | QualityLabPairwiseRecord;

export type ExportableSelfPlayMatch =
  | SelfPlayMatchResult
  | SelfPlayMatchRecord
  | SelfPlayMatchSummary;

interface ExportContext {
  exportedAt: string;
  includeTranscript: boolean;
  source?: string;
}

export function toQualityLabSelfPlayRecord(
  match: ExportableSelfPlayMatch,
  opts: QualityLabExportOptions = {},
): QualityLabSelfPlayRecord {
  const ctx = makeExportContext(opts);
  return {
    schemaVersion: QUALITY_LAB_JSONL_SCHEMA_VERSION,
    kind: "self_play_match",
    exportedAt: ctx.exportedAt,
    ...(ctx.source ? { source: ctx.source } : {}),
    match: toSelfPlayExport(match, ctx),
  };
}

export function toQualityLabPairwiseRecord(
  result: PairwiseMatchResult,
  opts: QualityLabExportOptions = {},
): QualityLabPairwiseRecord {
  const ctx = makeExportContext(opts);
  return {
    schemaVersion: QUALITY_LAB_JSONL_SCHEMA_VERSION,
    kind: "pairwise_match",
    exportedAt: ctx.exportedAt,
    ...(ctx.source ? { source: ctx.source } : {}),
    pairwiseId: result.pairwiseId,
    styleASlug: result.styleASlug,
    styleBSlug: result.styleBSlug,
    personaSlug: result.personaSlug,
    winner: result.verdict.winner,
    reason: result.verdict.reason,
    persisted: result.persisted,
    elo: {
      aAfter: result.eloAAfter,
      bAfter: result.eloBAfter,
    },
    matchA: toSelfPlayExport(result.matchA, ctx),
    matchB: toSelfPlayExport(result.matchB, ctx),
  };
}

export function formatQualityLabJsonl(
  records: readonly QualityLabJsonlRecord[],
): string {
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function exportSelfPlayMatchJsonl(
  match: ExportableSelfPlayMatch,
  opts: QualityLabExportOptions = {},
): string {
  return formatQualityLabJsonl([toQualityLabSelfPlayRecord(match, opts)]);
}

export function exportPairwiseMatchJsonl(
  result: PairwiseMatchResult,
  opts: QualityLabExportOptions = {},
): string {
  return formatQualityLabJsonl([toQualityLabPairwiseRecord(result, opts)]);
}

export async function exportSelfPlayMatchesFromRepoJsonl(
  repo: Pick<ISelfPlayMatchesRepo, "byId" | "list">,
  query: ExportSelfPlayMatchesQuery,
): Promise<string> {
  const summaries = await repo.list({
    styleSlug: query.styleSlug,
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.personaSlug ? { personaSlug: query.personaSlug } : {}),
  });
  const ctx = makeExportContext(query);
  const records: QualityLabSelfPlayRecord[] = [];

  for (const summary of summaries) {
    let match: ExportableSelfPlayMatch = summary;
    let transcriptUnavailable = false;
    if (ctx.includeTranscript) {
      const full = await repo.byId(summary.id);
      if (full) {
        match = full;
      } else {
        transcriptUnavailable = true;
      }
    }

    const exported = toSelfPlayExport(match, ctx);
    records.push({
      schemaVersion: QUALITY_LAB_JSONL_SCHEMA_VERSION,
      kind: "self_play_match",
      exportedAt: ctx.exportedAt,
      ...(ctx.source ? { source: ctx.source } : {}),
      match: transcriptUnavailable
        ? { ...exported, transcriptUnavailable: true }
        : exported,
    });
  }

  return formatQualityLabJsonl(records);
}

function makeExportContext(opts: QualityLabExportOptions): ExportContext {
  const exportedAt =
    opts.exportedAt instanceof Date
      ? opts.exportedAt.toISOString()
      : (opts.exportedAt ?? new Date().toISOString());
  return {
    exportedAt,
    includeTranscript: opts.includeTranscript !== false,
    ...(opts.source ? { source: opts.source } : {}),
  };
}

function toSelfPlayExport(
  match: ExportableSelfPlayMatch,
  ctx: Pick<ExportContext, "includeTranscript">,
): QualityLabSelfPlayExport {
  if (isRuntimeSelfPlayResult(match)) {
    const exported: QualityLabSelfPlayExport = {
      matchId: match.matchId,
      styleSlug: match.styleSlug,
      personaSlug: match.personaSlug,
      outcome: match.outcome,
      turns: match.turns,
      leadId: match.leadId,
      persisted: match.persisted,
      skills: [...match.skillsAttributed],
      judge: {
        outcome: match.verdict.outcome,
        reason: match.verdict.reason,
      },
      fabricationsCaught: match.fabricationsCaught,
      ...(match.warnings.length > 0 ? { warnings: [...match.warnings] } : {}),
      ...(ctx.includeTranscript
        ? { transcript: normalizeTranscript(match.transcript) }
        : {}),
    };
    return exported;
  }

  const transcript = hasTranscript(match)
    ? normalizeTranscript(match.transcript)
    : undefined;
  return {
    matchId: match.id,
    styleSlug: match.style_slug,
    personaSlug: match.persona_slug,
    outcome: match.outcome,
    turns: transcript ? Math.ceil(transcript.length / 2) : null,
    skills: [...match.skills],
    judge: {
      outcome: match.outcome,
      reason: match.judge_reason,
    },
    ...(ctx.includeTranscript && transcript ? { transcript } : {}),
  };
}

function isRuntimeSelfPlayResult(
  match: ExportableSelfPlayMatch,
): match is SelfPlayMatchResult {
  return "styleSlug" in match;
}

function hasTranscript(
  match: SelfPlayMatchRecord | SelfPlayMatchSummary,
): match is SelfPlayMatchRecord {
  return Array.isArray((match as SelfPlayMatchRecord).transcript);
}

function normalizeTranscript(
  transcript: readonly SelfPlayTurn[],
): SelfPlayTurn[] {
  return transcript.map((turn) => ({
    role: turn.role,
    text: turn.text,
  }));
}
