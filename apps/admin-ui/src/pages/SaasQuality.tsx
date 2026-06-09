import {
  AlertTriangleIcon,
  BugIcon,
  CheckCircleIcon,
  DownloadIcon,
  EyeIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TargetIcon,
  TimerIcon,
  TrophyIcon,
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
  type QualityRunOptions,
  type QualityShadowDecision,
  type QualityShadowStatus,
  type QualitySelfPlayMatch,
  type QualitySelfPlaySummary,
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

export function SaasQuality() {
  const navigate = useNavigate();
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
  const [runningKind, setRunningKind] = useState<"self-play" | "pairwise" | null>(null);
  const [generatingCoach, setGeneratingCoach] = useState(false);

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
  const [runReflect, setRunReflect] = useState(false);
  const [coachStyleSlug, setCoachStyleSlug] = useState("");
  const [coachPersonaSlug, setCoachPersonaSlug] = useState("all");
  const [coachSampleSize, setCoachSampleSize] = useState("8");

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

  function load() {
    setLoading(true);
    setError("");
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

  async function handleSelfPlayRun() {
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
    setProposalActionId(id);
    try {
      const preview = await saas.getQualityShadowPreview(id, { limit: 200 });
      if (!preview.preview.ready) {
        const missing = preview.preview.missing;
        toast.error(
          missing
            ? `Нет pairwise для ${missing.styleASlug} vs ${missing.styleBSlug}`
            : "Недостаточно pairwise для shadow eval",
        );
        return;
      }

      const result = await saas.createQualityShadowEvaluation(id, { limit: 200 });
      setCoach(await saas.getQualityCoachSummary());
      toast.success(`Shadow eval: ${result.shadow.decision ?? result.shadow.status}`);
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

  const totals = summary?.totals;
  const pairwiseTotals = pairwise?.totals;
  const proposalTotals = coach?.totals.proposals;
  const shadowTotals = coach?.totals.shadows;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Качество"
        description="Self-play, pairwise сравнения, coach proposals и JSONL выгрузка."
        actions={
          <>
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

      <Card>
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
                <Label htmlFor="quality-run-reflect">Reflect</Label>
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

      <Card>
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
              <label className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                <span>Transcript</span>
                <Switch checked={includeTranscript} onCheckedChange={setIncludeTranscript} />
              </label>
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
              <label className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                <span>Transcript</span>
                <Switch checked={pairIncludeTranscript} onCheckedChange={setPairIncludeTranscript} />
              </label>
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
                      {item.status === "pending" && (
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
                      {item.status === "dismissed" && (
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
                      {item.status === "applied" && (
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

      <QualityInspectorDialog inspector={inspector} onOpenChange={(open) => !open && setInspector(null)} />
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
        {transcript.map((turn, index) => (
          <div
            key={`${turn.role}-${index}-${turn.text.slice(0, 12)}`}
            className="rounded-md bg-muted/35 px-3 py-2"
          >
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
