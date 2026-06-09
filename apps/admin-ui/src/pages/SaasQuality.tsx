import {
  AlertTriangleIcon,
  BugIcon,
  CheckCircleIcon,
  DownloadIcon,
  EyeIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  MessageSquareTextIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TargetIcon,
  TimerIcon,
  TrophyIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  ApiError,
  clearToken,
  type QualityCoachProposalDecisionStatus,
  type QualityCoachProposalStatus,
  type QualityCoachSummary,
  type QualityExportOptions,
  type QualityOutcome,
  type QualityPairwiseExportOptions,
  type QualityPairwiseMatch,
  type QualityPairwiseSummary,
  type QualityPairwiseWinner,
  type QualityPersistedToolCallImprovementProposal,
  type QualityRunOptions,
  type QualityShadowDecision,
  type QualityShadowStatus,
  type QualitySelfPlayMatch,
  type QualitySelfPlaySummary,
  type QualityToolCall,
  type QualityToolCallFeedback,
  type QualityToolCallFeedbackLabel,
  type QualityToolCallFeedbackSummary,
  type QualityToolCallFeedbackSummaryOptions,
  type QualityToolCallImprovementKind,
  type QualityToolCallImprovementProposal,
  type QualityToolCallImprovementResolutionKind,
  type QualityToolCallImprovementSeverity,
  type QualityToolCallImprovementStatus,
  type QualityToolCallSource,
  type QualityTranscriptTurn,
  saas,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const OUTCOME_LABEL: Record<QualityOutcome, string> = {
  won: "win",
  lost: "loss",
  draw: "draw",
};

const OUTCOME_CLASS: Record<QualityOutcome, string> = {
  won: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  lost: "bg-destructive/10 text-destructive",
  draw: "bg-muted text-muted-foreground",
};

const WINNER_CLASS: Record<QualityPairwiseWinner, string> = {
  a: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  b: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  draw: "bg-muted text-muted-foreground",
};

const PROPOSAL_CLASS: Record<QualityCoachProposalStatus, string> = {
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  applied: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  dismissed: "bg-muted text-muted-foreground",
};

const SHADOW_STATUS_CLASS: Record<QualityShadowStatus, string> = {
  running: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  complete: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  failed: "bg-destructive/10 text-destructive",
};

const DECISION_CLASS: Record<QualityShadowDecision, string> = {
  keep: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  rollback: "bg-destructive/10 text-destructive",
  inconclusive: "bg-muted text-muted-foreground",
};

const TOOL_CALL_SOURCES: QualityToolCallSource[] = [
  "rag_reply",
  "llm_reply",
  "admin_sim",
  "self_play",
];

const TOOL_FEEDBACK_LABELS: Array<{ value: QualityToolCallFeedbackLabel; label: string }> = [
  { value: "good_reply", label: "Good" },
  { value: "wrong_tool", label: "Wrong tool" },
  { value: "missing_tool", label: "Missing tool" },
  { value: "bad_args", label: "Bad args" },
  { value: "other", label: "Other" },
];

const TOOL_FEEDBACK_CLASS: Record<QualityToolCallFeedbackLabel, string> = {
  good_reply: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  wrong_tool: "bg-destructive/10 text-destructive",
  missing_tool: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad_args: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  other: "bg-muted text-muted-foreground",
};

const TOOL_PROPOSAL_KIND_LABEL: Record<QualityToolCallImprovementKind, string> = {
  schema_fix: "Schema",
  routing_prompt_fix: "Routing",
  tool_candidate: "Tool",
};

const TOOL_PROPOSAL_SEVERITY_CLASS: Record<QualityToolCallImprovementSeverity, string> = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  low: "bg-muted text-muted-foreground",
};

const TOOL_PROPOSAL_STATUS_CLASS: Record<QualityToolCallImprovementStatus, string> = {
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  applied: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  dismissed: "bg-muted text-muted-foreground",
};

const TOOL_PROPOSAL_RESOLUTION_KIND_LABEL: Record<
  QualityToolCallImprovementResolutionKind,
  string
> = {
  prompt_patch: "Prompt patch",
  tool_schema_patch: "Tool schema",
  regression_case: "Regression",
  coach_proposal: "Coach proposal",
  shadow_eval: "Shadow eval",
  pull_request: "Pull request",
  other: "Other",
};

const TOOL_PROPOSAL_RESOLUTION_KINDS = Object.keys(
  TOOL_PROPOSAL_RESOLUTION_KIND_LABEL,
) as QualityToolCallImprovementResolutionKind[];

function formatDate(epoch: number | null | undefined): string {
  if (!epoch) return "нет";
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseLimit(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return null;
  return parsed;
}

function parseRunMaxTurns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) return null;
  return parsed;
}

function parseCoachSampleSize(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) return null;
  return parsed;
}

function parseFeedbackLimit(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return null;
  return parsed;
}

function outcomeBadge(outcome: string) {
  const value = outcome as QualityOutcome;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", OUTCOME_CLASS[value])}>
      {OUTCOME_LABEL[value] ?? outcome}
    </Badge>
  );
}

function winnerBadge(winner: string) {
  const value = winner as QualityPairwiseWinner;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", WINNER_CLASS[value])}>
      {value === "draw" ? "draw" : value.toUpperCase()}
    </Badge>
  );
}

function proposalBadge(status: string) {
  const value = status as QualityCoachProposalStatus;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", PROPOSAL_CLASS[value])}>
      {status}
    </Badge>
  );
}

function shadowBadge(status: string) {
  const value = status as QualityShadowStatus;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", SHADOW_STATUS_CLASS[value])}>
      {status}
    </Badge>
  );
}

function decisionBadge(decision: string | null) {
  if (!decision) return <span className="text-muted-foreground">нет</span>;
  const value = decision as QualityShadowDecision;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", DECISION_CLASS[value])}>
      {decision}
    </Badge>
  );
}

function editSummary(edits: unknown): string {
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return "нет";
  const keys = Object.keys(edits);
  return keys.length > 0 ? keys.join(", ") : "нет";
}

function formatPercent(value: number | null): string {
  if (value === null) return "нет";
  return `${Math.round(value * 1000) / 10}%`;
}

function formatLatency(value: number | null): string {
  return value === null ? "нет" : `${value} ms`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function toolErrorBadge(error: boolean) {
  return (
    <Badge
      className={cn(
        "border-transparent font-mono text-[11px]",
        error
          ? "bg-destructive/10 text-destructive"
          : "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
      )}
    >
      {error ? "error" : "ok"}
    </Badge>
  );
}

function sourceBadge(source: QualityToolCallSource) {
  return <Badge className="border-transparent bg-muted font-mono text-[11px]">{source}</Badge>;
}

function feedbackBadge(label: QualityToolCallFeedbackLabel) {
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", TOOL_FEEDBACK_CLASS[label])}>
      {label}
    </Badge>
  );
}

function proposalKindBadge(kind: QualityToolCallImprovementKind) {
  return (
    <Badge className="border-transparent bg-blue-500/10 font-mono text-[11px] text-blue-600 dark:text-blue-400">
      {TOOL_PROPOSAL_KIND_LABEL[kind]}
    </Badge>
  );
}

function proposalSeverityBadge(severity: QualityToolCallImprovementSeverity) {
  return (
    <Badge
      className={cn(
        "border-transparent font-mono text-[11px]",
        TOOL_PROPOSAL_SEVERITY_CLASS[severity],
      )}
    >
      {severity}
    </Badge>
  );
}

function proposalStatusBadge(status: QualityToolCallImprovementStatus) {
  return (
    <Badge
      className={cn(
        "border-transparent font-mono text-[11px]",
        TOOL_PROPOSAL_STATUS_CLASS[status],
      )}
    >
      {status}
    </Badge>
  );
}

export function SaasQuality() {
  const navigate = useNavigate();
  const [adminRole, setAdminRole] = useState<"superadmin" | "manager" | null>(null);
  const [summary, setSummary] = useState<QualitySelfPlaySummary | null>(null);
  const [pairwise, setPairwise] = useState<QualityPairwiseSummary | null>(null);
  const [coach, setCoach] = useState<QualityCoachSummary | null>(null);
  const [runOptions, setRunOptions] = useState<QualityRunOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [pairwiseExporting, setPairwiseExporting] = useState(false);
  const [proposalActionId, setProposalActionId] = useState<number | null>(null);
  const [inspector, setInspector] = useState<QualityInspectorState | null>(null);
  const [toolCallInspector, setToolCallInspector] = useState<QualityToolCallInspectorState | null>(
    null,
  );
  const [runningKind, setRunningKind] = useState<"self-play" | "pairwise" | null>(null);
  const [generatingCoach, setGeneratingCoach] = useState(false);
  const [toolCalls, setToolCalls] = useState<QualityToolCall[]>([]);
  const [toolCallsLoading, setToolCallsLoading] = useState(false);
  const [toolCallError, setToolCallError] = useState("");
  const [toolFeedbackSummary, setToolFeedbackSummary] =
    useState<QualityToolCallFeedbackSummary | null>(null);
  const [toolFeedbackProposals, setToolFeedbackProposals] = useState<
    QualityToolCallImprovementProposal[]
  >([]);
  const [trackedToolProposals, setTrackedToolProposals] = useState<
    QualityPersistedToolCallImprovementProposal[]
  >([]);
  const [toolFeedbackLoading, setToolFeedbackLoading] = useState(false);
  const [toolFeedbackProposalsLoading, setToolFeedbackProposalsLoading] = useState(false);
  const [trackedToolProposalsLoading, setTrackedToolProposalsLoading] = useState(false);
  const [toolFeedbackError, setToolFeedbackError] = useState("");
  const [toolFeedbackProposalsError, setToolFeedbackProposalsError] = useState("");
  const [trackedToolProposalsError, setTrackedToolProposalsError] = useState("");
  const [toolFeedbackExporting, setToolFeedbackExporting] = useState(false);
  const [trackedToolProposalCreating, setTrackedToolProposalCreating] = useState(false);
  const [trackedToolProposalActionId, setTrackedToolProposalActionId] = useState<number | null>(
    null,
  );
  const [trackedToolProposalApply, setTrackedToolProposalApply] =
    useState<ToolProposalApplyDialogState | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  const [styleSlug, setStyleSlug] = useState("all");
  const [personaSlug, setPersonaSlug] = useState("all");
  const [outcome, setOutcome] = useState<"all" | QualityOutcome>("all");
  const [limit, setLimit] = useState("200");
  const [includeTranscript, setIncludeTranscript] = useState(true);

  const [pairStyleASlug, setPairStyleASlug] = useState("all");
  const [pairStyleBSlug, setPairStyleBSlug] = useState("all");
  const [pairPersonaSlug, setPairPersonaSlug] = useState("all");
  const [pairWinner, setPairWinner] = useState<"all" | QualityPairwiseWinner>("all");
  const [pairLimit, setPairLimit] = useState("200");
  const [pairIncludeTranscript, setPairIncludeTranscript] = useState(false);

  const [runStyleSlug, setRunStyleSlug] = useState("");
  const [runStyleBSlug, setRunStyleBSlug] = useState("");
  const [runPersonaSlug, setRunPersonaSlug] = useState("");
  const [runMaxTurns, setRunMaxTurns] = useState("6");
  const [runReflect, setRunReflect] = useState(true);
  const [coachStyleSlug, setCoachStyleSlug] = useState("");
  const [coachPersonaSlug, setCoachPersonaSlug] = useState("all");
  const [coachSampleSize, setCoachSampleSize] = useState("8");
  const [toolCallLimit, setToolCallLimit] = useState("50");
  const [toolCallSource, setToolCallSource] = useState<"all" | QualityToolCallSource>("all");
  const [toolCallErrorFilter, setToolCallErrorFilter] = useState<"all" | "true" | "false">(
    "all",
  );
  const [toolCallName, setToolCallName] = useState("");
  const [toolFeedbackLimit, setToolFeedbackLimit] = useState("25");
  const [toolFeedbackSource, setToolFeedbackSource] = useState<"all" | QualityToolCallSource>(
    "all",
  );
  const [toolFeedbackLabel, setToolFeedbackLabel] = useState<"all" | QualityToolCallFeedbackLabel>(
    "all",
  );
  const [toolFeedbackErrorFilter, setToolFeedbackErrorFilter] = useState<
    "all" | "true" | "false"
  >("all");
  const [toolFeedbackName, setToolFeedbackName] = useState("");
  const [trackedToolProposalStatus, setTrackedToolProposalStatus] = useState<
    "all" | QualityToolCallImprovementStatus
  >("pending");

  const styleOptions = useMemo(() => summary?.byStyle.map((item) => item.styleSlug) ?? [], [summary]);
  const personaOptions = useMemo(
    () => summary?.byPersona.map((item) => item.personaSlug) ?? [],
    [summary],
  );
  const runStyleOptions = useMemo(() => runOptions?.styles ?? [], [runOptions]);
  const runPersonaOptions = useMemo(() => runOptions?.personas ?? [], [runOptions]);
  const pairStyleAOptions = useMemo(
    () => [...new Set(pairwise?.byPair.map((item) => item.styleASlug) ?? [])],
    [pairwise],
  );
  const pairStyleBOptions = useMemo(
    () => [...new Set(pairwise?.byPair.map((item) => item.styleBSlug) ?? [])],
    [pairwise],
  );
  const pairPersonaOptions = useMemo(
    () => [...new Set(pairwise?.recent.map((item) => item.personaSlug) ?? [])],
    [pairwise],
  );
  const canWriteQuality = adminRole === "superadmin";

  function redirectOnUnauthorized(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function loadToolCalls() {
    const parsedLimit = parseLimit(toolCallLimit);
    if (parsedLimit === null) {
      toast.error("Tool calls limit: 1-1000");
      return;
    }

    setToolCallsLoading(true);
    setToolCallError("");
    try {
      const result = await saas.getQualityToolCalls({
        limit: parsedLimit,
        ...(toolCallSource !== "all" ? { source: toolCallSource } : {}),
        ...(toolCallErrorFilter !== "all" ? { error: toolCallErrorFilter === "true" } : {}),
        ...(toolCallName.trim() ? { toolName: toolCallName.trim() } : {}),
      });
      setToolCalls(result.items);
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      setToolCallError(err instanceof Error ? err.message : "Не удалось загрузить tool calls");
    } finally {
      setToolCallsLoading(false);
    }
  }

  function buildToolFeedbackOptions(): QualityToolCallFeedbackSummaryOptions | null {
    const parsedLimit = parseFeedbackLimit(toolFeedbackLimit);
    if (parsedLimit === null) {
      toast.error("Feedback limit: 1-200");
      return null;
    }

    return {
      limit: parsedLimit,
      ...(toolFeedbackSource !== "all" ? { source: toolFeedbackSource } : {}),
      ...(toolFeedbackLabel !== "all" ? { label: toolFeedbackLabel } : {}),
      ...(toolFeedbackErrorFilter !== "all" ? { error: toolFeedbackErrorFilter === "true" } : {}),
      ...(toolFeedbackName.trim() ? { toolName: toolFeedbackName.trim() } : {}),
    };
  }

  async function loadToolFeedbackSummary(optsArg?: QualityToolCallFeedbackSummaryOptions) {
    const opts = optsArg ?? buildToolFeedbackOptions();
    if (!opts) return;

    setToolFeedbackLoading(true);
    setToolFeedbackError("");
    try {
      const result = await saas.getQualityToolCallFeedbackSummary(opts);
      setToolFeedbackSummary(result);
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      setToolFeedbackError(err instanceof Error ? err.message : "Не удалось загрузить feedback");
    } finally {
      setToolFeedbackLoading(false);
    }
  }

  async function loadToolFeedbackProposals(optsArg?: QualityToolCallFeedbackSummaryOptions) {
    const opts = optsArg ?? buildToolFeedbackOptions();
    if (!opts) return;

    setToolFeedbackProposalsLoading(true);
    setToolFeedbackProposalsError("");
    try {
      const result = await saas.getQualityToolCallFeedbackProposals(opts);
      setToolFeedbackProposals(result.items);
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      setToolFeedbackProposalsError(
        err instanceof Error ? err.message : "Не удалось загрузить proposals",
      );
    } finally {
      setToolFeedbackProposalsLoading(false);
    }
  }

  async function loadTrackedToolProposals(
    status: "all" | QualityToolCallImprovementStatus = trackedToolProposalStatus,
  ) {
    setTrackedToolProposalsLoading(true);
    setTrackedToolProposalsError("");
    try {
      const result = await saas.getQualityTrackedToolCallImprovementProposals({
        status,
        limit: 100,
      });
      setTrackedToolProposals(result.items);
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      setTrackedToolProposalsError(
        err instanceof Error ? err.message : "Не удалось загрузить tracked proposals",
      );
    } finally {
      setTrackedToolProposalsLoading(false);
    }
  }

  function loadToolFeedbackInsights() {
    const opts = buildToolFeedbackOptions();
    if (!opts) return;
    void loadToolFeedbackSummary(opts);
    void loadToolFeedbackProposals(opts);
    void loadTrackedToolProposals();
  }

  function load() {
    setLoading(true);
    setError("");
    void loadToolCalls();
    loadToolFeedbackInsights();
    Promise.all([
      saas.getQualitySelfPlaySummary(),
      saas.getQualityPairwiseSummary(),
      saas.getQualityCoachSummary(),
      saas.getQualityRunOptions(),
    ])
      .then(([selfPlaySummary, pairwiseSummary, coachSummary, options]) => {
        setSummary(selfPlaySummary);
        setPairwise(pairwiseSummary);
        setCoach(coachSummary);
        setRunOptions(options);
        const firstStyle = options.styles[0]?.slug ?? "";
        const secondStyle = options.styles.find((style) => style.slug !== firstStyle)?.slug ?? "";
        const firstPersona = options.personas[0]?.slug ?? "";
        setRunStyleSlug((current) => current || firstStyle);
        setRunStyleBSlug((current) => current || secondStyle || firstStyle);
        setRunPersonaSlug((current) => current || firstPersona);
        setCoachStyleSlug((current) => current || firstStyle);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        }
        setError("Не удалось загрузить quality-lab данные");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    saas
      .me()
      .then((res) => {
        if (!cancelled) setAdminRole(res.admin.role);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        }
        setAdminRole("manager");
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if ((coach?.totals.shadows.running ?? 0) <= 0) return;
    const interval = window.setInterval(() => {
      saas
        .getQualityCoachSummary()
        .then(setCoach)
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(interval);
  }, [coach?.totals.shadows.running]);

  async function handleExport() {
    const parsedLimit = parseLimit(limit);
    if (parsedLimit === null) {
      toast.error("Limit: 1-1000");
      return;
    }

    const opts: QualityExportOptions = {
      limit: parsedLimit,
      includeTranscript,
      ...(styleSlug !== "all" ? { styleSlug } : {}),
      ...(personaSlug !== "all" ? { personaSlug } : {}),
      ...(outcome !== "all" ? { outcome } : {}),
    };

    setExporting(true);
    try {
      await saas.exportQualitySelfPlayJsonl(opts);
      toast.success("JSONL выгружен");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось выгрузить JSONL");
    } finally {
      setExporting(false);
    }
  }

  async function handlePairwiseExport() {
    const parsedLimit = parseLimit(pairLimit);
    if (parsedLimit === null) {
      toast.error("Pairwise limit: 1-1000");
      return;
    }

    const opts: QualityPairwiseExportOptions = {
      limit: parsedLimit,
      includeTranscript: pairIncludeTranscript,
      ...(pairStyleASlug !== "all" ? { styleASlug: pairStyleASlug } : {}),
      ...(pairStyleBSlug !== "all" ? { styleBSlug: pairStyleBSlug } : {}),
      ...(pairPersonaSlug !== "all" ? { personaSlug: pairPersonaSlug } : {}),
      ...(pairWinner !== "all" ? { winner: pairWinner } : {}),
    };

    setPairwiseExporting(true);
    try {
      await saas.exportQualityPairwiseJsonl(opts);
      toast.success("Pairwise JSONL выгружен");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось выгрузить pairwise JSONL");
    } finally {
      setPairwiseExporting(false);
    }
  }

  async function handleToolFeedbackExport() {
    const opts = buildToolFeedbackOptions();
    if (!opts) return;

    setToolFeedbackExporting(true);
    try {
      await saas.exportQualityToolCallFeedbackJsonl(opts);
      toast.success("Tool-call feedback JSONL выгружен");
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      toast.error(err instanceof Error ? err.message : "Не удалось выгрузить feedback JSONL");
    } finally {
      setToolFeedbackExporting(false);
    }
  }

  async function handleTrackedToolProposalCreate() {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }

    const opts = buildToolFeedbackOptions();
    if (!opts) return;

    setTrackedToolProposalCreating(true);
    try {
      const result = await saas.createQualityTrackedToolCallImprovementProposals(opts);
      await loadTrackedToolProposals(trackedToolProposalStatus);
      toast.success(`Tracked proposals: ${result.items.length}`);
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      toast.error(err instanceof Error ? err.message : "Не удалось создать tracked proposals");
    } finally {
      setTrackedToolProposalCreating(false);
    }
  }

  async function handleTrackedToolProposalStatus(
    id: number,
    status: QualityToolCallImprovementStatus,
  ) {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }

    setTrackedToolProposalActionId(id);
    try {
      await saas.setQualityTrackedToolCallImprovementProposalStatus(id, status);
      await loadTrackedToolProposals(trackedToolProposalStatus);
      toast.success(status === "pending" ? "Proposal restored" : `Proposal ${status}`);
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      toast.error(err instanceof Error ? err.message : "Не удалось обновить tracked proposal");
    } finally {
      setTrackedToolProposalActionId(null);
    }
  }

  function openTrackedToolProposalApply(proposal: QualityPersistedToolCallImprovementProposal) {
    setTrackedToolProposalApply({
      proposal,
      kind: proposal.resolution?.kind ?? "pull_request",
      ref: proposal.resolution?.ref ?? "",
      url: proposal.resolution?.url ?? "",
      note: proposal.resolution?.note ?? "",
    });
  }

  async function handleTrackedToolProposalApply() {
    if (!trackedToolProposalApply) return;
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }

    const ref = trackedToolProposalApply.ref.trim();
    const url = trackedToolProposalApply.url.trim();
    const note = trackedToolProposalApply.note.trim();
    if (!ref && !url) {
      toast.error("Укажите artifact ref или URL");
      return;
    }

    setTrackedToolProposalActionId(trackedToolProposalApply.proposal.id);
    try {
      await saas.setQualityTrackedToolCallImprovementProposalStatus(
        trackedToolProposalApply.proposal.id,
        "applied",
        {
          resolution: {
            kind: trackedToolProposalApply.kind,
            ref: ref || null,
            url: url || null,
            note: note || null,
          },
        },
      );
      setTrackedToolProposalApply(null);
      await loadTrackedToolProposals(trackedToolProposalStatus);
      toast.success("Proposal applied");
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      toast.error(err instanceof Error ? err.message : "Не удалось применить tracked proposal");
    } finally {
      setTrackedToolProposalActionId(null);
    }
  }

  async function handleSelfPlayRun() {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    const maxTurns = parseRunMaxTurns(runMaxTurns);
    if (maxTurns === null) {
      toast.error("Max turns: 1-20");
      return;
    }
    if (!runStyleSlug || !runPersonaSlug) {
      toast.error("Выберите стиль и персону");
      return;
    }

    setRunningKind("self-play");
    try {
      const result = await saas.runQualitySelfPlay({
        styleSlug: runStyleSlug,
        personaSlug: runPersonaSlug,
        maxTurns,
        reflect: runReflect,
      });
      setInspector({ kind: "self-play", loading: false, match: result.match });
      load();
      toast.success(`Self-play: ${OUTCOME_LABEL[result.match.outcome] ?? result.match.outcome}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось запустить self-play");
    } finally {
      setRunningKind(null);
    }
  }

  async function handlePairwiseRun() {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    const maxTurns = parseRunMaxTurns(runMaxTurns);
    if (maxTurns === null) {
      toast.error("Max turns: 1-20");
      return;
    }
    if (!runStyleSlug || !runStyleBSlug || !runPersonaSlug) {
      toast.error("Выберите оба стиля и персону");
      return;
    }
    if (runStyleSlug === runStyleBSlug) {
      toast.error("Для pairwise нужны разные стили");
      return;
    }

    setRunningKind("pairwise");
    try {
      const result = await saas.runQualityPairwise({
        styleASlug: runStyleSlug,
        styleBSlug: runStyleBSlug,
        personaSlug: runPersonaSlug,
        maxTurns,
        reflect: runReflect,
      });
      setInspector({ kind: "pairwise", loading: false, pairwise: result.pairwise });
      load();
      toast.success(`Pairwise: ${result.pairwise.verdict.winner.toUpperCase()}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось запустить pairwise");
    } finally {
      setRunningKind(null);
    }
  }

  async function handleCoachGenerate() {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    const sampleSize = parseCoachSampleSize(coachSampleSize);
    if (sampleSize === null) {
      toast.error("Sample: 1-50");
      return;
    }
    if (!coachStyleSlug) {
      toast.error("Выберите стиль для coach proposal");
      return;
    }

    setGeneratingCoach(true);
    try {
      const result = await saas.generateQualityCoachProposal({
        styleSlug: coachStyleSlug,
        sampleSize,
        ...(coachPersonaSlug !== "all" ? { personaSlug: coachPersonaSlug } : {}),
      });
      setCoach(await saas.getQualityCoachSummary());
      toast.success(`Coach proposal: ${result.proposal.summary}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось сгенерировать coach proposal");
    } finally {
      setGeneratingCoach(false);
    }
  }

  async function handleProposalStatus(id: number, status: QualityCoachProposalDecisionStatus) {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    setProposalActionId(id);
    try {
      await saas.setQualityCoachProposalStatus(id, status);
      setCoach(await saas.getQualityCoachSummary());
      toast.success(status === "dismissed" ? "Proposal dismissed" : "Proposal restored");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось обновить proposal");
    } finally {
      setProposalActionId(null);
    }
  }

  async function handleProposalApply(id: number) {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    setProposalActionId(id);
    try {
      const result = await saas.applyQualityCoachProposal(id);
      setCoach(await saas.getQualityCoachSummary());
      toast.success(`Style variant created: ${result.style.slug}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось применить proposal");
    } finally {
      setProposalActionId(null);
    }
  }

  async function handleShadowEvaluationCreate(id: number) {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    setProposalActionId(id);
    try {
      const preview = await saas.getQualityShadowPreview(id, { limit: 200 });
      if (!preview.preview.ready) {
        const result = await saas.runQualityShadowEvaluation(id, { runs: 1, maxTurns: 6 });
        toast.success(`Shadow eval запущен: ${result.shadow.pairsPlanned} pairs`);
      } else {
        const result = await saas.createQualityShadowEvaluation(id, { limit: 200 });
        toast.success(`Shadow eval: ${result.shadow.decision ?? result.shadow.status}`);
      }
      setCoach(await saas.getQualityCoachSummary());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось создать shadow eval");
    } finally {
      setProposalActionId(null);
    }
  }

  async function handleSelfPlayInspect(id: number) {
    setInspector({ kind: "self-play", loading: true });
    try {
      const result = await saas.getQualitySelfPlayMatch(id);
      setInspector({ kind: "self-play", loading: false, match: result.match });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setInspector({
        kind: "self-play",
        loading: false,
        error: err instanceof Error ? err.message : "Не удалось открыть match",
      });
    }
  }

  async function handlePairwiseInspect(id: number) {
    setInspector({ kind: "pairwise", loading: true });
    try {
      const result = await saas.getQualityPairwiseMatch(id);
      setInspector({ kind: "pairwise", loading: false, pairwise: result.pairwise });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setInspector({
        kind: "pairwise",
        loading: false,
        error: err instanceof Error ? err.message : "Не удалось открыть pairwise",
      });
    }
  }

  async function handleToolCallInspect(toolCall: QualityToolCall) {
    setToolCallInspector({
      toolCall,
      feedback: [],
      loading: true,
      note: "",
    });
    try {
      const result = await saas.getQualityToolCallFeedback(toolCall.id);
      setToolCallInspector((current) =>
        current?.toolCall.id === toolCall.id
          ? {
              ...current,
              feedback: result.items,
              loading: false,
            }
          : current,
      );
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      setToolCallInspector((current) =>
        current?.toolCall.id === toolCall.id
          ? {
              ...current,
              error: err instanceof Error ? err.message : "Не удалось загрузить feedback",
              loading: false,
            }
          : current,
      );
    }
  }

  function handleToolCallNoteChange(note: string) {
    setToolCallInspector((current) => (current ? { ...current, note } : current));
  }

  async function handleToolCallFeedback(label: QualityToolCallFeedbackLabel) {
    if (!canWriteQuality) {
      toast.error("Quality Lab доступен только для просмотра");
      return;
    }
    if (!toolCallInspector) return;
    const toolCallId = toolCallInspector.toolCall.id;
    const note = toolCallInspector.note.trim();

    setFeedbackSubmitting(true);
    try {
      const result = await saas.createQualityToolCallFeedback(toolCallId, {
        label,
        ...(note ? { note } : {}),
      });
      setToolCallInspector((current) =>
        current?.toolCall.id === toolCallId
          ? {
              ...current,
              feedback: [result.feedback, ...current.feedback],
              note: "",
            }
          : current,
      );
      toast.success("Tool-call feedback сохранён");
      loadToolFeedbackInsights();
    } catch (err) {
      if (redirectOnUnauthorized(err)) return;
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить feedback");
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  const totals = summary?.totals;
  const pairwiseTotals = pairwise?.totals;
  const proposalTotals = coach?.totals.proposals;
  const shadowTotals = coach?.totals.shadows;
  const feedbackTotals = toolFeedbackSummary?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Качество"
        description="Self-play, pairwise сравнения, coach proposals и JSONL выгрузка."
        actions={
          <>
            {adminRole === "manager" && <Badge variant="outline">только просмотр</Badge>}
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
              Обновить
            </Button>
            <Button onClick={handleExport} disabled={exporting}>
              <DownloadIcon className="size-4" />
              {exporting ? "Экспорт…" : "Self-play JSONL"}
            </Button>
          </>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading && !summary ? (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          {[0, 1, 2, 3, 4, 5, 6].map((item) => (
            <Card key={item}>
              <CardContent className="space-y-3 py-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <MetricCard icon={TargetIcon} label="Матчи" value={totals?.total ?? 0} />
          <MetricCard icon={TrophyIcon} label="Win-rate" value={`${totals?.winRate ?? 0}%`} />
          <MetricCard icon={BugIcon} label="Фабрикации" value={totals?.fabricationsCaught ?? 0} />
          <MetricCard icon={TimerIcon} label="Avg turns" value={totals?.avgTurns ?? "нет"} />
          <MetricCard icon={TargetIcon} label="Pairwise" value={pairwiseTotals?.total ?? 0} />
          <MetricCard icon={LightbulbIcon} label="Coach pending" value={proposalTotals?.pending ?? 0} />
          <MetricCard icon={TimerIcon} label="Shadow running" value={shadowTotals?.running ?? 0} />
        </div>
      )}

      <Card hidden={!canWriteQuality}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <PlayIcon className="size-4 text-primary" />
            Запуск quality run
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_110px_140px_160px_160px]">
            <div className="space-y-1.5">
              <Label>Style A</Label>
              <Select value={runStyleSlug} onValueChange={setRunStyleSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runStyleOptions.map((style) => (
                    <SelectItem key={style.id} value={style.slug}>
                      {style.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Style B</Label>
              <Select value={runStyleBSlug} onValueChange={setRunStyleBSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runStyleOptions.map((style) => (
                    <SelectItem key={style.id} value={style.slug}>
                      {style.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Persona</Label>
              <Select value={runPersonaSlug} onValueChange={setRunPersonaSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runPersonaOptions.map((persona) => (
                    <SelectItem key={persona.slug} value={persona.slug}>
                      {persona.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-max-turns">Turns</Label>
              <Input
                id="run-max-turns"
                inputMode="numeric"
                className="font-mono"
                value={runMaxTurns}
                onChange={(event) => setRunMaxTurns(event.target.value.replace(/\D/g, "").slice(0, 2))}
              />
            </div>

            <div className="flex items-end">
              <div className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                <Label htmlFor="quality-run-reflect">Fact-check</Label>
                <Switch id="quality-run-reflect" checked={runReflect} onCheckedChange={setRunReflect} />
              </div>
            </div>

            <div className="flex items-end">
              <Button
                className="w-full"
                variant="outline"
                onClick={() => void handleSelfPlayRun()}
                disabled={runningKind !== null || runStyleOptions.length === 0 || runPersonaOptions.length === 0}
              >
                <FlaskConicalIcon className="size-4" />
                {runningKind === "self-play" ? "Running…" : "Self-play"}
              </Button>
            </div>

            <div className="flex items-end">
              <Button
                className="w-full"
                onClick={() => void handlePairwiseRun()}
                disabled={runningKind !== null || runStyleOptions.length < 2 || runPersonaOptions.length === 0}
              >
                <PlayIcon className="size-4" />
                {runningKind === "pairwise" ? "Running…" : "Pairwise"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card hidden={!canWriteQuality}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <LightbulbIcon className="size-4 text-amber-500" />
            Coach proposal
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px_180px]">
            <div className="space-y-1.5">
              <Label>Style</Label>
              <Select value={coachStyleSlug} onValueChange={setCoachStyleSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runStyleOptions.map((style) => (
                    <SelectItem key={style.id} value={style.slug}>
                      {style.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Persona</Label>
              <Select value={coachPersonaSlug} onValueChange={setCoachPersonaSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все персоны</SelectItem>
                  {runPersonaOptions.map((persona) => (
                    <SelectItem key={persona.slug} value={persona.slug}>
                      {persona.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="coach-sample-size">Sample</Label>
              <Input
                id="coach-sample-size"
                inputMode="numeric"
                className="font-mono"
                value={coachSampleSize}
                onChange={(event) =>
                  setCoachSampleSize(event.target.value.replace(/\D/g, "").slice(0, 2))
                }
              />
            </div>

            <div className="flex items-end">
              <Button
                className="w-full"
                onClick={() => void handleCoachGenerate()}
                disabled={generatingCoach || runStyleOptions.length === 0}
              >
                <LightbulbIcon className="size-4" />
                {generatingCoach ? "Generating…" : "Generate"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Выгрузка self-play</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_120px_170px]">
            <div className="space-y-1.5">
              <Label>Стиль</Label>
              <Select value={styleSlug} onValueChange={setStyleSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все стили</SelectItem>
                  {styleOptions.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Персона</Label>
              <Select value={personaSlug} onValueChange={setPersonaSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все персоны</SelectItem>
                  {personaOptions.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Исход</Label>
              <Select value={outcome} onValueChange={(value) => setOutcome(value as "all" | QualityOutcome)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  <SelectItem value="won">Win</SelectItem>
                  <SelectItem value="lost">Loss</SelectItem>
                  <SelectItem value="draw">Draw</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="quality-limit">Limit</Label>
              <Input
                id="quality-limit"
                inputMode="numeric"
                className="font-mono"
                value={limit}
                onChange={(event) => setLimit(event.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </div>

            <div className="flex items-end">
              <div className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                <span>Transcript</span>
                <Switch checked={includeTranscript} onCheckedChange={setIncludeTranscript} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Выгрузка pairwise</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_130px_110px_150px_150px]">
            <div className="space-y-1.5">
              <Label>Style A</Label>
              <Select value={pairStyleASlug} onValueChange={setPairStyleASlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все A</SelectItem>
                  {pairStyleAOptions.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Style B</Label>
              <Select value={pairStyleBSlug} onValueChange={setPairStyleBSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все B</SelectItem>
                  {pairStyleBOptions.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Персона</Label>
              <Select value={pairPersonaSlug} onValueChange={setPairPersonaSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все персоны</SelectItem>
                  {pairPersonaOptions.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Winner</Label>
              <Select
                value={pairWinner}
                onValueChange={(value) => setPairWinner(value as "all" | QualityPairwiseWinner)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  <SelectItem value="a">A</SelectItem>
                  <SelectItem value="b">B</SelectItem>
                  <SelectItem value="draw">Draw</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pairwise-limit">Limit</Label>
              <Input
                id="pairwise-limit"
                inputMode="numeric"
                className="font-mono"
                value={pairLimit}
                onChange={(event) => setPairLimit(event.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </div>

            <div className="flex items-end">
              <div className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                <span>Transcript</span>
                <Switch checked={pairIncludeTranscript} onCheckedChange={setPairIncludeTranscript} />
              </div>
            </div>

            <div className="flex items-end">
              <Button className="w-full" onClick={handlePairwiseExport} disabled={pairwiseExporting}>
                <DownloadIcon className="size-4" />
                {pairwiseExporting ? "Экспорт…" : "Pairwise"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <WrenchIcon className="size-4 text-primary" />
            Agent tool calls
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_130px_110px_150px]">
            <div className="space-y-1.5">
              <Label htmlFor="tool-call-name">Tool</Label>
              <Input
                id="tool-call-name"
                className="font-mono"
                value={toolCallName}
                onChange={(event) => setToolCallName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select
                value={toolCallSource}
                onValueChange={(value) => setToolCallSource(value as "all" | QualityToolCallSource)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  {TOOL_CALL_SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Error</Label>
              <Select
                value={toolCallErrorFilter}
                onValueChange={(value) =>
                  setToolCallErrorFilter(value as "all" | "true" | "false")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  <SelectItem value="false">OK</SelectItem>
                  <SelectItem value="true">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-call-limit">Limit</Label>
              <Input
                id="tool-call-limit"
                inputMode="numeric"
                className="font-mono"
                value={toolCallLimit}
                onChange={(event) =>
                  setToolCallLimit(event.target.value.replace(/\D/g, "").slice(0, 4))
                }
              />
            </div>

            <div className="flex items-end">
              <Button
                className="w-full"
                variant="outline"
                onClick={() => void loadToolCalls()}
                disabled={toolCallsLoading}
              >
                <RefreshCwIcon className={cn("size-4", toolCallsLoading && "animate-spin")} />
                Обновить
              </Button>
            </div>
          </div>

          {toolCallError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {toolCallError}
            </p>
          )}

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Conversation</TableHead>
                  <TableHead className="text-right">Cycle</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">When</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {toolCallsLoading && toolCalls.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      Загрузка tool calls…
                    </TableCell>
                  </TableRow>
                )}
                {!toolCallsLoading && toolCalls.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      Tool calls пока нет
                    </TableCell>
                  </TableRow>
                )}
                {toolCalls.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{toolErrorBadge(item.error)}</TableCell>
                    <TableCell className="max-w-[260px] truncate font-mono text-xs">
                      {item.toolName}
                    </TableCell>
                    <TableCell>{sourceBadge(item.source)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.conversationId}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.cycle}.{item.toolCallIndex}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatLatency(item.latencyMs)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1.5 px-2 text-xs"
                        onClick={() => void handleToolCallInspect(item)}
                      >
                        <EyeIcon className="size-3.5" />
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MessageSquareTextIcon className="size-4 text-primary" />
            Tool feedback
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_150px_130px_110px_140px_160px]">
            <div className="space-y-1.5">
              <Label htmlFor="tool-feedback-name">Tool</Label>
              <Input
                id="tool-feedback-name"
                className="font-mono"
                value={toolFeedbackName}
                onChange={(event) => setToolFeedbackName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select
                value={toolFeedbackSource}
                onValueChange={(value) =>
                  setToolFeedbackSource(value as "all" | QualityToolCallSource)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  {TOOL_CALL_SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Label</Label>
              <Select
                value={toolFeedbackLabel}
                onValueChange={(value) =>
                  setToolFeedbackLabel(value as "all" | QualityToolCallFeedbackLabel)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  {TOOL_FEEDBACK_LABELS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Error</Label>
              <Select
                value={toolFeedbackErrorFilter}
                onValueChange={(value) =>
                  setToolFeedbackErrorFilter(value as "all" | "true" | "false")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все</SelectItem>
                  <SelectItem value="false">OK</SelectItem>
                  <SelectItem value="true">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-feedback-limit">Limit</Label>
              <Input
                id="tool-feedback-limit"
                inputMode="numeric"
                className="font-mono"
                value={toolFeedbackLimit}
                onChange={(event) =>
                  setToolFeedbackLimit(event.target.value.replace(/\D/g, "").slice(0, 3))
                }
              />
            </div>

            <div className="flex items-end">
              <Button
                className="w-full"
                variant="outline"
                onClick={loadToolFeedbackInsights}
                disabled={toolFeedbackLoading || toolFeedbackProposalsLoading}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-4",
                    (toolFeedbackLoading || toolFeedbackProposalsLoading) && "animate-spin",
                  )}
                />
                Обновить
              </Button>
            </div>

            <div className="flex items-end">
              <Button
                className="w-full"
                onClick={() => void handleToolFeedbackExport()}
                disabled={toolFeedbackExporting}
              >
                <DownloadIcon className="size-4" />
                {toolFeedbackExporting ? "Экспорт…" : "JSONL"}
              </Button>
            </div>
          </div>

          {toolFeedbackError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {toolFeedbackError}
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-5">
            <FeedbackMetric label="Total" value={feedbackTotals?.total ?? 0} />
            <FeedbackMetric label="Wrong tool" value={feedbackTotals?.wrongTool ?? 0} />
            <FeedbackMetric label="Missing tool" value={feedbackTotals?.missingTool ?? 0} />
            <FeedbackMetric label="Bad args" value={feedbackTotals?.badArgs ?? 0} />
            <FeedbackMetric label="Errors" value={feedbackTotals?.errorCount ?? 0} />
          </div>

          <div className="flex flex-wrap gap-2">
            {(toolFeedbackSummary?.byLabel ?? []).map((item) => (
              <span
                key={item.label}
                className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs"
              >
                {feedbackBadge(item.label)}
                <span className="font-mono">{item.total}</span>
              </span>
            ))}
            {(toolFeedbackSummary?.bySource ?? []).map((item) => (
              <span
                key={item.source}
                className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs"
              >
                {sourceBadge(item.source)}
                <span className="font-mono">{item.total}</span>
              </span>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tool</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Wrong</TableHead>
                    <TableHead className="text-right">Missing</TableHead>
                    <TableHead className="text-right">Args</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {toolFeedbackLoading && !toolFeedbackSummary && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        Загрузка feedback…
                      </TableCell>
                    </TableRow>
                  )}
                  {!toolFeedbackLoading && (toolFeedbackSummary?.byTool ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        Feedback пока нет
                      </TableCell>
                    </TableRow>
                  )}
                  {toolFeedbackSummary?.byTool.map((item) => (
                    <TableRow key={item.toolName}>
                      <TableCell className="max-w-[260px] truncate font-mono text-xs">
                        {item.toolName}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{item.total}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {item.wrongTool}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {item.missingTool}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {item.badArgs}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {item.errorCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead>Tool</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {toolFeedbackLoading && !toolFeedbackSummary && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                        Загрузка feedback…
                      </TableCell>
                    </TableRow>
                  )}
                  {!toolFeedbackLoading && (toolFeedbackSummary?.recent ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                        Feedback пока нет
                      </TableCell>
                    </TableRow>
                  )}
                  {toolFeedbackSummary?.recent.map((item) => (
                    <TableRow key={item.feedback.id}>
                      <TableCell>{feedbackBadge(item.feedback.label)}</TableCell>
                      <TableCell className="max-w-[180px] truncate font-mono text-xs">
                        {item.toolCall.toolName}
                      </TableCell>
                      <TableCell>{sourceBadge(item.toolCall.source)}</TableCell>
                      <TableCell className="max-w-[260px] truncate text-xs">
                        {item.feedback.note || "нет"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatDate(item.feedback.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {toolFeedbackProposalsError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {toolFeedbackProposalsError}
            </p>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-[180px] space-y-1.5">
                <Label>Tracked status</Label>
                <Select
                  value={trackedToolProposalStatus}
                  onValueChange={(value) => {
                    const next = value as "all" | QualityToolCallImprovementStatus;
                    setTrackedToolProposalStatus(next);
                    void loadTrackedToolProposals(next);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">pending</SelectItem>
                    <SelectItem value="applied">applied</SelectItem>
                    <SelectItem value="dismissed">dismissed</SelectItem>
                    <SelectItem value="all">all</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                onClick={() => void loadTrackedToolProposals(trackedToolProposalStatus)}
                disabled={trackedToolProposalsLoading}
              >
                <RefreshCwIcon
                  className={cn("size-4", trackedToolProposalsLoading && "animate-spin")}
                />
                Tracked
              </Button>
            </div>
            <Button
              onClick={() => void handleTrackedToolProposalCreate()}
              disabled={trackedToolProposalCreating || !canWriteQuality}
            >
              <LightbulbIcon className="size-4" />
              {trackedToolProposalCreating ? "Creating…" : "Create tracked"}
            </Button>
          </div>

          {trackedToolProposalsError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {trackedToolProposalsError}
            </p>
          )}

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trackedToolProposalsLoading && trackedToolProposals.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      Загрузка tracked proposals…
                    </TableCell>
                  </TableRow>
                )}
                {!trackedToolProposalsLoading && trackedToolProposals.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      Tracked proposals пока нет
                    </TableCell>
                  </TableRow>
                )}
                {trackedToolProposals.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{proposalStatusBadge(item.status)}</TableCell>
                    <TableCell>{proposalSeverityBadge(item.severity)}</TableCell>
                    <TableCell>{proposalKindBadge(item.kind)}</TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">
                      {item.toolName}
                    </TableCell>
                    <TableCell className="min-w-[210px]">
                      <div className="flex flex-wrap items-center gap-2">
                        {feedbackBadge(item.label)}
                        {sourceBadge(item.source)}
                        <span className="font-mono text-xs text-muted-foreground">
                          {item.feedbackCount}/{item.errorCount}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[340px] max-w-[620px]">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{item.summary}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {item.actionItems.slice(0, 2).map((action) => (
                            <span
                              key={action}
                              className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground"
                            >
                              {action}
                            </span>
                          ))}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[180px] text-right">
                      {item.status === "pending" ? (
                        <div className="space-y-1.5">
                          {item.resolution && <ToolProposalResolutionLine proposal={item} />}
                          {canWriteQuality && (
                            <div className="flex justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1.5 px-2 text-xs"
                                disabled={trackedToolProposalActionId === item.id}
                                onClick={() => openTrackedToolProposalApply(item)}
                              >
                                <CheckCircleIcon className="size-3.5" />
                                Apply
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1.5 px-2 text-xs"
                                disabled={trackedToolProposalActionId === item.id}
                                onClick={() =>
                                  void handleTrackedToolProposalStatus(item.id, "dismissed")
                                }
                              >
                                <XCircleIcon className="size-3.5" />
                                Dismiss
                              </Button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {item.resolution && <ToolProposalResolutionLine proposal={item} />}
                          {canWriteQuality && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 gap-1.5 px-2 text-xs"
                              disabled={trackedToolProposalActionId === item.id}
                              onClick={() =>
                                void handleTrackedToolProposalStatus(item.id, "pending")
                              }
                            >
                              <RotateCcwIcon className="size-3.5" />
                              Restore
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {toolFeedbackProposalsLoading && toolFeedbackProposals.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Загрузка proposals…
                    </TableCell>
                  </TableRow>
                )}
                {!toolFeedbackProposalsLoading && toolFeedbackProposals.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Proposals пока нет
                    </TableCell>
                  </TableRow>
                )}
                {toolFeedbackProposals.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{proposalSeverityBadge(item.severity)}</TableCell>
                    <TableCell>{proposalKindBadge(item.kind)}</TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">
                      {item.toolName}
                    </TableCell>
                    <TableCell className="min-w-[210px]">
                      <div className="flex flex-wrap items-center gap-2">
                        {feedbackBadge(item.label)}
                        {sourceBadge(item.source)}
                        <span className="font-mono text-xs text-muted-foreground">
                          {item.feedbackCount}/{item.errorCount}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[340px] max-w-[620px]">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{item.summary}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {item.actionItems.slice(0, 2).map((action) => (
                            <span
                              key={action}
                              className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground"
                            >
                              {action}
                            </span>
                          ))}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Стили</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Style</TableHead>
                  <TableHead className="text-right">Win-rate</TableHead>
                  <TableHead className="text-right">W/L/D</TableHead>
                  <TableHead className="text-right">Avg</TableHead>
                  <TableHead className="text-right">Last</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(summary?.byStyle ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Матчей пока нет
                    </TableCell>
                  </TableRow>
                )}
                {summary?.byStyle.map((item) => (
                  <TableRow key={item.styleSlug}>
                    <TableCell className="font-mono text-xs">{item.styleSlug}</TableCell>
                    <TableCell className="text-right font-mono">{item.winRate}%</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.won}/{item.lost}/{item.draw}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.avgTurns ?? "нет"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(item.lastMatchAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Последние матчи</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Style</TableHead>
                  <TableHead>Persona</TableHead>
                  <TableHead className="text-right">When</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(summary?.recent ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Матчей пока нет
                    </TableCell>
                  </TableRow>
                )}
                {summary?.recent.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{outcomeBadge(item.outcome)}</TableCell>
                    <TableCell className="max-w-[160px] truncate font-mono text-xs">
                      {item.styleSlug}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate font-mono text-xs">
                      {item.personaSlug}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1.5 px-2 text-xs"
                        onClick={() => void handleSelfPlayInspect(item.id)}
                      >
                        <EyeIcon className="size-3.5" />
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Pairwise пары</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pair</TableHead>
                  <TableHead className="text-right">A/B/Draw</TableHead>
                  <TableHead className="text-right">A win-rate</TableHead>
                  <TableHead className="text-right">B win-rate</TableHead>
                  <TableHead className="text-right">Last</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pairwise?.byPair ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Pairwise сравнений пока нет
                    </TableCell>
                  </TableRow>
                )}
                {pairwise?.byPair.map((item) => (
                  <TableRow key={`${item.styleASlug}:${item.styleBSlug}`}>
                    <TableCell className="max-w-[260px] truncate font-mono text-xs">
                      {item.styleASlug} / {item.styleBSlug}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.aWins}/{item.bWins}/{item.draws}
                    </TableCell>
                    <TableCell className="text-right font-mono">{item.aWinRate}%</TableCell>
                    <TableCell className="text-right font-mono">{item.bWinRate}%</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(item.lastMatchAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Последние pairwise</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Winner</TableHead>
                  <TableHead>Pair</TableHead>
                  <TableHead>Persona</TableHead>
                  <TableHead className="text-right">ELO</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(pairwise?.recent ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Pairwise сравнений пока нет
                    </TableCell>
                  </TableRow>
                )}
                {pairwise?.recent.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{winnerBadge(item.winner)}</TableCell>
                    <TableCell className="max-w-[200px] truncate font-mono text-xs">
                      {item.styleASlug} / {item.styleBSlug}
                    </TableCell>
                    <TableCell className="max-w-[160px] truncate font-mono text-xs">
                      {item.personaSlug}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.eloAAfter}/{item.eloBAfter}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1.5 px-2 text-xs"
                        onClick={() => void handlePairwiseInspect(item.id)}
                      >
                        <EyeIcon className="size-3.5" />
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <LightbulbIcon className="size-4 text-amber-500" />
              Coach proposals
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Style</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Edits</TableHead>
                  <TableHead className="text-right">When</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(coach?.proposals ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                      Coach proposals пока нет
                    </TableCell>
                  </TableRow>
                )}
                {coach?.proposals.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{proposalBadge(item.status)}</TableCell>
                    <TableCell className="max-w-[140px] truncate font-mono text-xs">
                      {item.styleSlug}
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate text-sm">{item.summary}</TableCell>
                    <TableCell className="max-w-[210px] truncate font-mono text-xs text-muted-foreground">
                      {editSummary(item.edits)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.status === "pending" && canWriteQuality && (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5 px-2 text-xs"
                            disabled={proposalActionId === item.id}
                            onClick={() => void handleProposalApply(item.id)}
                          >
                            <CheckCircleIcon className="size-3.5" />
                            Apply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                            disabled={proposalActionId === item.id}
                            onClick={() => void handleProposalStatus(item.id, "dismissed")}
                          >
                            <XCircleIcon className="size-3.5" />
                            Dismiss
                          </Button>
                        </div>
                      )}
                      {item.status === "dismissed" && canWriteQuality && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 px-2 text-xs"
                          disabled={proposalActionId === item.id}
                          onClick={() => void handleProposalStatus(item.id, "pending")}
                        >
                          <RotateCcwIcon className="size-3.5" />
                          Restore
                        </Button>
                      )}
                      {item.status === "applied" && canWriteQuality && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 px-2 text-xs"
                          disabled={proposalActionId === item.id}
                          onClick={() => void handleShadowEvaluationCreate(item.id)}
                        >
                          <FlaskConicalIcon className="size-3.5" />
                          Shadow
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Shadow evals</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Styles</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead className="text-right">Pairs</TableHead>
                  <TableHead className="text-right">LB</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(coach?.shadows ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Shadow evals пока нет
                    </TableCell>
                  </TableRow>
                )}
                {coach?.shadows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{shadowBadge(item.status)}</TableCell>
                    <TableCell className="max-w-[190px] truncate font-mono text-xs">
                      {item.parentStyleSlug} → {item.newStyleSlug}
                    </TableCell>
                    <TableCell>{decisionBadge(item.decision)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {item.pairsDone}/{item.pairsPlanned}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatPercent(item.winRateLb)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {totals?.total === 0 && (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <span>Нет сохранённых self-play матчей для текущего tenant.</span>
        </div>
      )}

      <ToolProposalApplyDialog
        state={trackedToolProposalApply}
        submitting={trackedToolProposalActionId === trackedToolProposalApply?.proposal.id}
        onChange={(patch) =>
          setTrackedToolProposalApply((current) =>
            current ? { ...current, ...patch } : current,
          )
        }
        onSubmit={() => void handleTrackedToolProposalApply()}
        onOpenChange={(open) => !open && setTrackedToolProposalApply(null)}
      />
      <QualityInspectorDialog inspector={inspector} onOpenChange={(open) => !open && setInspector(null)} />
      <ToolCallInspectorDialog
        inspector={toolCallInspector}
        canSubmitFeedback={canWriteQuality}
        submitting={feedbackSubmitting}
        onFeedback={(label) => void handleToolCallFeedback(label)}
        onNoteChange={handleToolCallNoteChange}
        onOpenChange={(open) => !open && setToolCallInspector(null)}
      />
    </div>
  );
}

type QualityInspectorState =
  | {
      kind: "self-play";
      loading: boolean;
      match?: QualitySelfPlayMatch;
      error?: string;
    }
  | {
      kind: "pairwise";
      loading: boolean;
      pairwise?: QualityPairwiseMatch;
      error?: string;
    };

type QualityToolCallInspectorState = {
  toolCall: QualityToolCall;
  feedback: QualityToolCallFeedback[];
  loading: boolean;
  note: string;
  error?: string;
};

type ToolProposalApplyDialogState = {
  proposal: QualityPersistedToolCallImprovementProposal;
  kind: QualityToolCallImprovementResolutionKind;
  ref: string;
  url: string;
  note: string;
};

function ToolProposalResolutionLine({
  proposal,
}: {
  proposal: QualityPersistedToolCallImprovementProposal;
}) {
  const resolution = proposal.resolution;
  if (!resolution) return null;

  const label = resolution.kind
    ? TOOL_PROPOSAL_RESOLUTION_KIND_LABEL[resolution.kind]
    : "Resolution";
  const target = resolution.ref ?? resolution.url ?? resolution.note ?? "saved";

  return (
    <div className="text-right text-[11px] leading-snug text-muted-foreground">
      <span className="font-medium">{label}:</span>{" "}
      {resolution.url ? (
        <a
          href={resolution.url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          {resolution.ref || resolution.url}
        </a>
      ) : (
        <span>{target}</span>
      )}
      {resolution.note && <div className="line-clamp-2">{resolution.note}</div>}
    </div>
  );
}

function ToolProposalApplyDialog({
  state,
  submitting,
  onChange,
  onSubmit,
  onOpenChange,
}: {
  state: ToolProposalApplyDialogState | null;
  submitting: boolean;
  onChange: (
    patch: Partial<Pick<ToolProposalApplyDialogState, "kind" | "ref" | "url" | "note">>,
  ) => void;
  onSubmit: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const open = state !== null;
  const hasTarget = Boolean(state?.ref.trim() || state?.url.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Apply tool proposal</DialogTitle>
        </DialogHeader>
        {state && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tool-proposal-resolution-kind">Artifact type</Label>
              <Select
                value={state.kind}
                onValueChange={(value) =>
                  onChange({ kind: value as QualityToolCallImprovementResolutionKind })
                }
              >
                <SelectTrigger id="tool-proposal-resolution-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOOL_PROPOSAL_RESOLUTION_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {TOOL_PROPOSAL_RESOLUTION_KIND_LABEL[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tool-proposal-resolution-ref">Artifact ref</Label>
                <Input
                  id="tool-proposal-resolution-ref"
                  value={state.ref}
                  maxLength={240}
                  onChange={(event) => onChange({ ref: event.target.value })}
                  placeholder="PR-433"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tool-proposal-resolution-url">URL</Label>
                <Input
                  id="tool-proposal-resolution-url"
                  type="url"
                  value={state.url}
                  maxLength={2000}
                  onChange={(event) => onChange({ url: event.target.value })}
                  placeholder="https://github.com/..."
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-proposal-resolution-note">Note</Label>
              <Textarea
                id="tool-proposal-resolution-note"
                value={state.note}
                maxLength={2000}
                rows={3}
                onChange={(event) => onChange({ note: event.target.value })}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={submitting || !hasTarget}>
                {submitting ? "Applying…" : "Apply"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function QualityInspectorDialog({
  inspector,
  onOpenChange,
}: {
  inspector: QualityInspectorState | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = inspector !== null;
  const title = inspector?.kind === "pairwise" ? "Pairwise detail" : "Self-play detail";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-5xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-5 pb-5">
          {inspector?.loading && (
            <div className="space-y-3 py-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {inspector?.error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {inspector.error}
            </p>
          )}
          {inspector?.kind === "self-play" && inspector.match && (
            <SelfPlayInspector match={inspector.match} />
          )}
          {inspector?.kind === "pairwise" && inspector.pairwise && (
            <PairwiseInspector pairwise={inspector.pairwise} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToolCallInspectorDialog({
  inspector,
  canSubmitFeedback,
  submitting,
  onFeedback,
  onNoteChange,
  onOpenChange,
}: {
  inspector: QualityToolCallInspectorState | null;
  canSubmitFeedback: boolean;
  submitting: boolean;
  onFeedback: (label: QualityToolCallFeedbackLabel) => void;
  onNoteChange: (note: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const open = inspector !== null;
  const toolCall = inspector?.toolCall;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-6xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <WrenchIcon className="size-4 text-primary" />
            {toolCall?.toolName ?? "Tool call detail"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-5 pb-5">
          {toolCall && (
            <>
              <div className="grid gap-3 text-sm md:grid-cols-4">
                <InspectorMetric label="Status" value={toolCall.error ? "error" : "ok"} />
                <InspectorMetric label="Source" value={toolCall.source} />
                <InspectorMetric label="Conversation" value={toolCall.conversationId} />
                <InspectorMetric label="Contact" value={toolCall.contactId ?? "нет"} />
                <InspectorMetric label="Message" value={toolCall.messageId ?? "нет"} />
                <InspectorMetric
                  label="Outbound"
                  value={toolCall.outboundQueueId ?? "нет"}
                />
                <InspectorMetric
                  label="Cycle"
                  value={`${toolCall.cycle}.${toolCall.toolCallIndex}`}
                />
                <InspectorMetric label="Latency" value={formatLatency(toolCall.latencyMs)} />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <JsonBlock title="Args" value={toolCall.args} />
                <JsonBlock title="Result" value={toolCall.result} />
              </div>

              <div className="rounded-md border">
                <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                  <MessageSquareTextIcon className="size-4 text-muted-foreground" />
                  Feedback
                </div>
                <div className="space-y-3 p-3">
                  {inspector.error && (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {inspector.error}
                    </p>
                  )}
                  {canSubmitFeedback && (
                    <>
                      <Textarea
                        value={inspector.note}
                        maxLength={2000}
                        rows={3}
                        onChange={(event) => onNoteChange(event.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        {TOOL_FEEDBACK_LABELS.map((item) => (
                          <Button
                            key={item.value}
                            size="sm"
                            variant={item.value === "good_reply" ? "default" : "outline"}
                            disabled={submitting || inspector.loading}
                            onClick={() => onFeedback(item.value)}
                          >
                            {item.label}
                          </Button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Note</TableHead>
                      <TableHead className="text-right">Admin</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inspector.loading && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                          Загрузка feedback…
                        </TableCell>
                      </TableRow>
                    )}
                    {!inspector.loading && inspector.feedback.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                          Feedback пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {inspector.feedback.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{feedbackBadge(item.label)}</TableCell>
                        <TableCell className="max-w-[520px] whitespace-pre-wrap break-words text-sm">
                          {item.note || "нет"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {item.adminId ?? "нет"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {formatDate(item.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SelfPlayInspector({ match }: { match: QualitySelfPlayMatch }) {
  return (
    <>
      <div className="grid gap-3 text-sm md:grid-cols-4">
        <InspectorMetric label="Style" value={match.styleSlug} />
        <InspectorMetric label="Persona" value={match.personaSlug} />
        <InspectorMetric label="Outcome" value={OUTCOME_LABEL[match.outcome] ?? match.outcome} />
        <InspectorMetric label="Turns" value={match.turns} />
      </div>
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {match.verdict.reason || "нет reason"}
      </p>
      <TranscriptPane title="Transcript" transcript={match.transcript} />
    </>
  );
}

function PairwiseInspector({ pairwise }: { pairwise: QualityPairwiseMatch }) {
  return (
    <>
      <div className="grid gap-3 text-sm md:grid-cols-4">
        <InspectorMetric label="Winner" value={pairwise.verdict.winner.toUpperCase()} />
        <InspectorMetric label="Persona" value={pairwise.personaSlug} />
        <InspectorMetric label="Style A" value={pairwise.styleASlug} />
        <InspectorMetric label="Style B" value={pairwise.styleBSlug} />
      </div>
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {pairwise.verdict.reason || "нет reason"}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <TranscriptPane
          title={`A: ${pairwise.styleASlug}`}
          transcript={pairwise.matchA.transcript}
        />
        <TranscriptPane
          title={`B: ${pairwise.styleBSlug}`}
          transcript={pairwise.matchB.transcript}
        />
      </div>
    </>
  );
}

function InspectorMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-xs">{value}</p>
    </div>
  );
}

function FeedbackMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-lg font-semibold">{value}</p>
    </div>
  );
}

function TranscriptPane({
  title,
  transcript,
}: {
  title: string;
  transcript: QualityTranscriptTurn[];
}) {
  return (
    <div className="rounded-md border">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      <div className="max-h-[420px] space-y-2 overflow-y-auto p-3">
        {transcript.length === 0 && (
          <p className="text-sm text-muted-foreground">Transcript unavailable</p>
        )}
        {transcript.map((turn) => (
          <div key={`${turn.role}-${turn.text}`} className="rounded-md bg-muted/35 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
              {turn.role === "candidate" ? "Candidate" : "Salesperson"}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{turn.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-md border">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      <pre className="max-h-[420px] overflow-auto p-3 text-xs leading-relaxed">
        {formatJson(value)}
      </pre>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof TargetIcon;
  label: string;
  value: string | number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-semibold tracking-tight">{value}</p>
        </div>
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      </CardContent>
    </Card>
  );
}
