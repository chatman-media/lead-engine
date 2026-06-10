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
  TrophyIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  ApiError,
  clearToken,
  type ExchangeAnswerQualityEvalResult,
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
  type QualitySelfPlayMatch,
  type QualitySelfPlaySummary,
  type QualityShadowDecision,
  type QualityShadowStatus,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const OUTCOME_LABEL: Record<QualityOutcome, string> = {
  won: "победа",
  lost: "провал",
  draw: "ничья",
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

const PROPOSAL_LABEL: Record<QualityCoachProposalStatus, string> = {
  pending: "на ревью",
  applied: "применено",
  dismissed: "отклонено",
};

const SHADOW_STATUS_CLASS: Record<QualityShadowStatus, string> = {
  running: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  complete: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  failed: "bg-destructive/10 text-destructive",
};

const SHADOW_STATUS_LABEL: Record<QualityShadowStatus, string> = {
  running: "идёт",
  complete: "готово",
  failed: "ошибка",
};

const DECISION_CLASS: Record<QualityShadowDecision, string> = {
  keep: "bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  rollback: "bg-destructive/10 text-destructive",
  inconclusive: "bg-muted text-muted-foreground",
};

const DECISION_LABEL: Record<QualityShadowDecision, string> = {
  keep: "оставить",
  rollback: "откатить",
  inconclusive: "неясно",
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
      {value === "draw" ? "ничья" : value.toUpperCase()}
    </Badge>
  );
}

function proposalBadge(status: string) {
  const value = status as QualityCoachProposalStatus;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", PROPOSAL_CLASS[value])}>
      {PROPOSAL_LABEL[value] ?? status}
    </Badge>
  );
}

function shadowBadge(status: string) {
  const value = status as QualityShadowStatus;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", SHADOW_STATUS_CLASS[value])}>
      {SHADOW_STATUS_LABEL[value] ?? status}
    </Badge>
  );
}

function decisionBadge(decision: string | null) {
  if (!decision) return <span className="text-muted-foreground">нет</span>;
  const value = decision as QualityShadowDecision;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", DECISION_CLASS[value])}>
      {DECISION_LABEL[value] ?? decision}
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

type QualityRunResult =
  | {
      kind: "self-play";
      match: QualitySelfPlayMatch;
    }
  | {
      kind: "pairwise";
      pairwise: QualityPairwiseMatch;
    };

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
  const [lastResult, setLastResult] = useState<QualityRunResult | null>(null);
  const [runningKind, setRunningKind] = useState<"self-play" | "pairwise" | null>(null);
  const [generatingCoach, setGeneratingCoach] = useState(false);
  const [exchangeSafetyEval, setExchangeSafetyEval] =
    useState<ExchangeAnswerQualityEvalResult | null>(null);
  const [runningExchangeSafety, setRunningExchangeSafety] = useState(false);

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

  const styleOptions = useMemo(
    () => summary?.byStyle.map((item) => item.styleSlug) ?? [],
    [summary],
  );
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
  const styleNameBySlug = useMemo(
    () =>
      new Map(
        (runOptions?.styles ?? []).map((style) => [style.slug, style.displayName || style.slug]),
      ),
    [runOptions],
  );
  const personaNameBySlug = useMemo(
    () =>
      new Map(
        (runOptions?.personas ?? []).map((persona) => [
          persona.slug,
          persona.displayName || persona.slug,
        ]),
      ),
    [runOptions],
  );
  const styleName = (slug: string) => styleNameBySlug.get(slug) ?? slug;
  const personaName = (slug: string) => personaNameBySlug.get(slug) ?? slug;

  async function load() {
    setLoading(true);
    setError("");
    const [selfPlayResult, pairwiseResult, coachResult, optionsResult] = await Promise.allSettled([
      saas.getQualitySelfPlaySummary(),
      saas.getQualityPairwiseSummary(),
      saas.getQualityCoachSummary(),
      saas.getQualityRunOptions(),
    ]);

    const authError = [selfPlayResult, pairwiseResult, coachResult, optionsResult].some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof ApiError &&
        result.reason.status === 401,
    );
    if (authError) {
      clearToken();
      navigate("/login", { replace: true });
      return;
    }

    if (selfPlayResult.status === "fulfilled") setSummary(selfPlayResult.value);
    if (pairwiseResult.status === "fulfilled") setPairwise(pairwiseResult.value);
    if (coachResult.status === "fulfilled") setCoach(coachResult.value);
    if (optionsResult.status === "fulfilled") {
      const options = optionsResult.value;
      setRunOptions(options);
      const firstStyle = options.styles[0]?.slug ?? "";
      const secondStyle = options.styles.find((style) => style.slug !== firstStyle)?.slug ?? "";
      const firstPersona = options.personas[0]?.slug ?? "";
      setRunStyleSlug((current) => current || firstStyle);
      setRunStyleBSlug((current) => current || secondStyle || firstStyle);
      setRunPersonaSlug((current) => current || firstPersona);
      setCoachStyleSlug((current) => current || firstStyle);
    }

    const failed = [
      selfPlayResult.status === "rejected" ? "self-play" : null,
      pairwiseResult.status === "rejected" ? "pairwise" : null,
      coachResult.status === "rejected" ? "coach" : null,
      optionsResult.status === "rejected" ? "варианты запуска" : null,
    ].filter(Boolean);
    if (failed.length > 0) {
      setError(`Не загрузились блоки: ${failed.join(", ")}`);
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      toast.error("Лимит: 1-1000");
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
      toast.error("Лимит сравнений: 1-1000");
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
      toast.success("JSONL сравнений выгружен");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось выгрузить JSONL сравнений");
    } finally {
      setPairwiseExporting(false);
    }
  }

  async function handleSelfPlayRun() {
    const maxTurns = parseRunMaxTurns(runMaxTurns);
    if (maxTurns === null) {
      toast.error("Ходов: 1-20");
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
      setLastResult({ kind: "self-play", match: result.match });
      void load();
      toast.success(`Проверка: ${OUTCOME_LABEL[result.match.outcome] ?? result.match.outcome}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось запустить проверку стиля");
    } finally {
      setRunningKind(null);
    }
  }

  async function handlePairwiseRun() {
    const maxTurns = parseRunMaxTurns(runMaxTurns);
    if (maxTurns === null) {
      toast.error("Ходов: 1-20");
      return;
    }
    if (!runStyleSlug || !runStyleBSlug || !runPersonaSlug) {
      toast.error("Выберите оба стиля и персону");
      return;
    }
    if (runStyleSlug === runStyleBSlug) {
      toast.error("Для сравнения нужны разные стили");
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
      setLastResult({ kind: "pairwise", pairwise: result.pairwise });
      void load();
      toast.success(
        `Сравнение: ${
          result.pairwise.verdict.winner === "draw"
            ? "ничья"
            : result.pairwise.verdict.winner.toUpperCase()
        }`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось запустить сравнение стилей");
    } finally {
      setRunningKind(null);
    }
  }

  async function handleExchangeSafetyRun() {
    setRunningExchangeSafety(true);
    const tid = toast.loading("Проверяем exchange safety contracts…");
    try {
      const result = await saas.runExchangeAnswerQualityEval();
      setExchangeSafetyEval(result);
      if (result.summary.failed > 0) {
        toast.error(
          `Exchange safety: ${result.summary.failed}/${result.summary.total} кейсов требуют внимания`,
          { id: tid },
        );
      } else {
        toast.success(
          `Exchange safety: ${result.summary.passed}/${result.summary.total} кейсов прошли`,
          { id: tid },
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось проверить exchange contracts", {
        id: tid,
      });
    } finally {
      setRunningExchangeSafety(false);
    }
  }

  async function handleCoachGenerate() {
    const sampleSize = parseCoachSampleSize(coachSampleSize);
    if (sampleSize === null) {
      toast.error("Диалогов: 1-50");
      return;
    }
    if (!coachStyleSlug) {
      toast.error("Выберите стиль для улучшения");
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
      toast.success(`Идея улучшения: ${result.proposal.summary}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось подготовить идею улучшения");
    } finally {
      setGeneratingCoach(false);
    }
  }

  async function handleProposalStatus(id: number, status: QualityCoachProposalDecisionStatus) {
    setProposalActionId(id);
    try {
      await saas.setQualityCoachProposalStatus(id, status);
      setCoach(await saas.getQualityCoachSummary());
      toast.success(status === "dismissed" ? "Идея отклонена" : "Идея вернулась на ревью");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось обновить идею");
    } finally {
      setProposalActionId(null);
    }
  }

  async function handleProposalApply(id: number) {
    setProposalActionId(id);
    try {
      const result = await saas.applyQualityCoachProposal(id);
      setCoach(await saas.getQualityCoachSummary());
      toast.success(`Новый вариант стиля создан: ${result.style.slug}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось применить идею");
    } finally {
      setProposalActionId(null);
    }
  }

  async function handleShadowEvaluationCreate(id: number) {
    setProposalActionId(id);
    try {
      const preview = await saas.getQualityShadowPreview(id, { limit: 200 });
      if (!preview.preview.ready) {
        const result = await saas.runQualityShadowEvaluation(id, { runs: 1, maxTurns: 6 });
        toast.success(`Проверка версии запущена: ${result.shadow.pairsPlanned} пар`);
      } else {
        const result = await saas.createQualityShadowEvaluation(id, { limit: 200 });
        toast.success(`Проверка версии: ${result.shadow.decision ?? result.shadow.status}`);
      }
      setCoach(await saas.getQualityCoachSummary());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Не удалось создать проверку версии");
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
        error: err instanceof Error ? err.message : "Не удалось открыть проверку",
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
        error: err instanceof Error ? err.message : "Не удалось открыть сравнение",
      });
    }
  }

  const totals = summary?.totals;
  const pairwiseTotals = pairwise?.totals;
  const proposalTotals = coach?.totals.proposals;
  const shadowTotals = coach?.totals.shadows;

  function openLastResult() {
    if (!lastResult) return;
    if (lastResult.kind === "self-play") {
      setInspector({ kind: "self-play", loading: false, match: lastResult.match });
      return;
    }
    setInspector({ kind: "pairwise", loading: false, pairwise: lastResult.pairwise });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Проверка бота"
        description="Синтетические диалоги для проверки стиля, сравнения вариантов и отбора улучшений."
        actions={
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
            Обновить
          </Button>
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading && !summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((item) => (
            <Card key={item}>
              <CardContent className="space-y-3 py-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <MetricCard icon={TargetIcon} label="Проверки" value={totals?.total ?? 0} />
          <MetricCard icon={TrophyIcon} label="Успех" value={`${totals?.winRate ?? 0}%`} />
          <MetricCard icon={BugIcon} label="Ошибки" value={totals?.fabricationsCaught ?? 0} />
          <MetricCard icon={TargetIcon} label="Сравнения" value={pairwiseTotals?.total ?? 0} />
          <MetricCard icon={LightbulbIcon} label="Идеи" value={proposalTotals?.pending ?? 0} />
        </div>
      )}

      <ExchangeSafetyContractsCard
        result={exchangeSafetyEval}
        running={runningExchangeSafety}
        onRun={() => void handleExchangeSafetyRun()}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <PlayIcon className="size-4 text-primary" />
            Новая проверка
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px_180px]">
            <div className="space-y-1.5">
              <Label>Стиль бота</Label>
              <Select value={runStyleSlug} onValueChange={setRunStyleSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runStyleOptions.map((style) => (
                    <SelectItem key={style.id} value={style.slug}>
                      {style.displayName || style.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Тестовый клиент</Label>
              <Select value={runPersonaSlug} onValueChange={setRunPersonaSlug}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runPersonaOptions.map((persona) => (
                    <SelectItem key={persona.slug} value={persona.slug}>
                      {persona.displayName || persona.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="run-max-turns">Ходов</Label>
              <Input
                id="run-max-turns"
                inputMode="numeric"
                className="font-mono"
                value={runMaxTurns}
                onChange={(event) =>
                  setRunMaxTurns(event.target.value.replace(/\D/g, "").slice(0, 2))
                }
              />
            </div>

            <div className="flex items-end">
              <div className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                <Label htmlFor="quality-run-reflect">Проверять факты</Label>
                <Switch
                  id="quality-run-reflect"
                  checked={runReflect}
                  onCheckedChange={setRunReflect}
                />
              </div>
            </div>

            <div className="flex items-end sm:col-span-2 xl:col-span-1">
              <Button
                className="w-full"
                onClick={() => void handleSelfPlayRun()}
                disabled={
                  runningKind !== null ||
                  runStyleOptions.length === 0 ||
                  runPersonaOptions.length === 0
                }
              >
                <FlaskConicalIcon className="size-4" />
                {runningKind === "self-play" ? "Запуск…" : "Проверить стиль"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {lastResult && (
        <QualityRunResultCard
          result={lastResult}
          styleName={styleName}
          personaName={personaName}
          onInspect={openLastResult}
        />
      )}

      {(totals?.total ?? 0) === 0 && !lastResult && (
        <FirstRunHint
          disabled={
            runningKind !== null || runStyleOptions.length === 0 || runPersonaOptions.length === 0
          }
          running={runningKind === "self-play"}
          onRun={() => void handleSelfPlayRun()}
        />
      )}

      <details className="rounded-lg border border-dashed bg-muted/20">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium marker:text-muted-foreground">
          <span>Расширенная проверка</span>
          <span className="text-xs font-normal text-muted-foreground">
            сравнение стилей и идеи улучшений
          </span>
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <PlayIcon className="size-4 text-primary" />
                Сравнение стилей
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_180px]">
                <div className="space-y-1.5">
                  <Label>Стиль A</Label>
                  <Select value={runStyleSlug} onValueChange={setRunStyleSlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {runStyleOptions.map((style) => (
                        <SelectItem key={style.id} value={style.slug}>
                          {style.displayName || style.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Стиль B</Label>
                  <Select value={runStyleBSlug} onValueChange={setRunStyleBSlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {runStyleOptions.map((style) => (
                        <SelectItem key={style.id} value={style.slug}>
                          {style.displayName || style.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Тестовый клиент</Label>
                  <Select value={runPersonaSlug} onValueChange={setRunPersonaSlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {runPersonaOptions.map((persona) => (
                        <SelectItem key={persona.slug} value={persona.slug}>
                          {persona.displayName || persona.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-end">
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() => void handlePairwiseRun()}
                    disabled={
                      runningKind !== null ||
                      runStyleOptions.length < 2 ||
                      runPersonaOptions.length === 0
                    }
                  >
                    <PlayIcon className="size-4" />
                    {runningKind === "pairwise" ? "Запуск…" : "Сравнить"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <LightbulbIcon className="size-4 text-amber-500" />
                Идеи улучшений
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_110px_180px]">
                <div className="space-y-1.5">
                  <Label>Стиль</Label>
                  <Select value={coachStyleSlug} onValueChange={setCoachStyleSlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {runStyleOptions.map((style) => (
                        <SelectItem key={style.id} value={style.slug}>
                          {style.displayName || style.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Тестовый клиент</Label>
                  <Select value={coachPersonaSlug} onValueChange={setCoachPersonaSlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все персоны</SelectItem>
                      {runPersonaOptions.map((persona) => (
                        <SelectItem key={persona.slug} value={persona.slug}>
                          {persona.displayName || persona.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="coach-sample-size">Диалогов</Label>
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
                    {generatingCoach ? "Готовим…" : "Предложить"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </details>

      <details className="rounded-lg border border-dashed bg-muted/20">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium marker:text-muted-foreground">
          <span>История, сравнения и экспорт</span>
          <span className="text-xs font-normal text-muted-foreground">
            {totals?.total ?? 0} проверок · {pairwiseTotals?.total ?? 0} сравнений ·{" "}
            {shadowTotals?.running ?? 0} фоновых
          </span>
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Выгрузка проверок</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_110px_150px_150px]">
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
                          {styleName(slug)}
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
                          {personaName(slug)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Результат</Label>
                  <Select
                    value={outcome}
                    onValueChange={(value) => setOutcome(value as "all" | QualityOutcome)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все</SelectItem>
                      <SelectItem value="won">Победа</SelectItem>
                      <SelectItem value="lost">Провал</SelectItem>
                      <SelectItem value="draw">Ничья</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="quality-limit">Лимит</Label>
                  <Input
                    id="quality-limit"
                    inputMode="numeric"
                    className="font-mono"
                    value={limit}
                    onChange={(event) =>
                      setLimit(event.target.value.replace(/\D/g, "").slice(0, 4))
                    }
                  />
                </div>

                <div className="flex items-end">
                  <div className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                    <span>Диалог</span>
                    <Switch checked={includeTranscript} onCheckedChange={setIncludeTranscript} />
                  </div>
                </div>

                <div className="flex items-end">
                  <Button className="w-full" onClick={handleExport} disabled={exporting}>
                    <DownloadIcon className="size-4" />
                    {exporting ? "Экспорт…" : "Выгрузить"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Выгрузка сравнений</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1.5">
                  <Label>Стиль A</Label>
                  <Select value={pairStyleASlug} onValueChange={setPairStyleASlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все A</SelectItem>
                      {pairStyleAOptions.map((slug) => (
                        <SelectItem key={slug} value={slug}>
                          {styleName(slug)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Стиль B</Label>
                  <Select value={pairStyleBSlug} onValueChange={setPairStyleBSlug}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все B</SelectItem>
                      {pairStyleBOptions.map((slug) => (
                        <SelectItem key={slug} value={slug}>
                          {styleName(slug)}
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
                          {personaName(slug)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Победитель</Label>
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
                      <SelectItem value="draw">Ничья</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pairwise-limit">Лимит</Label>
                  <Input
                    id="pairwise-limit"
                    inputMode="numeric"
                    className="font-mono"
                    value={pairLimit}
                    onChange={(event) =>
                      setPairLimit(event.target.value.replace(/\D/g, "").slice(0, 4))
                    }
                  />
                </div>

                <div className="flex items-end">
                  <div className="flex h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-sm">
                    <span>Диалог</span>
                    <Switch
                      checked={pairIncludeTranscript}
                      onCheckedChange={setPairIncludeTranscript}
                    />
                  </div>
                </div>

                <div className="flex items-end">
                  <Button
                    className="w-full"
                    onClick={handlePairwiseExport}
                    disabled={pairwiseExporting}
                  >
                    <DownloadIcon className="size-4" />
                    {pairwiseExporting ? "Экспорт…" : "Выгрузить"}
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
                      <TableHead>Стиль</TableHead>
                      <TableHead className="text-right">Успешность</TableHead>
                      <TableHead className="text-right">Итоги</TableHead>
                      <TableHead className="text-right">Ходов</TableHead>
                      <TableHead className="text-right">Когда</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(summary?.byStyle ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                          Проверок пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {summary?.byStyle.map((item) => (
                      <TableRow key={item.styleSlug}>
                        <TableCell className="text-xs font-medium">
                          {styleName(item.styleSlug)}
                        </TableCell>
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
                <CardTitle className="text-sm">Последние проверки</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Результат</TableHead>
                      <TableHead>Стиль</TableHead>
                      <TableHead>Клиент</TableHead>
                      <TableHead className="text-right">Когда</TableHead>
                      <TableHead className="text-right">Действие</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(summary?.recent ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                          Проверок пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {summary?.recent.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{outcomeBadge(item.outcome)}</TableCell>
                        <TableCell className="max-w-[160px] truncate text-xs font-medium">
                          {styleName(item.styleSlug)}
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate text-xs font-medium">
                          {personaName(item.personaSlug)}
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
                            Открыть
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
                <CardTitle className="text-sm">Пары стилей</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Пара</TableHead>
                      <TableHead className="text-right">Итоги</TableHead>
                      <TableHead className="text-right">A выигрывает</TableHead>
                      <TableHead className="text-right">B выигрывает</TableHead>
                      <TableHead className="text-right">Когда</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(pairwise?.byPair ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                          Сравнений пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {pairwise?.byPair.map((item) => (
                      <TableRow key={`${item.styleASlug}:${item.styleBSlug}`}>
                        <TableCell className="max-w-[260px] truncate text-xs font-medium">
                          {styleName(item.styleASlug)} / {styleName(item.styleBSlug)}
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
                <CardTitle className="text-sm">Последние сравнения</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Победил</TableHead>
                      <TableHead>Пара</TableHead>
                      <TableHead>Клиент</TableHead>
                      <TableHead className="text-right">ELO</TableHead>
                      <TableHead className="text-right">Действие</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(pairwise?.recent ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                          Сравнений пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {pairwise?.recent.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{winnerBadge(item.winner)}</TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs font-medium">
                          {styleName(item.styleASlug)} / {styleName(item.styleBSlug)}
                        </TableCell>
                        <TableCell className="max-w-[160px] truncate text-xs font-medium">
                          {personaName(item.personaSlug)}
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
                            Открыть
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
                  Идеи улучшений
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Статус</TableHead>
                      <TableHead>Стиль</TableHead>
                      <TableHead>Идея</TableHead>
                      <TableHead>Что меняет</TableHead>
                      <TableHead className="text-right">Когда</TableHead>
                      <TableHead className="text-right">Действие</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(coach?.proposals ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                          Идей улучшений пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {coach?.proposals.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{proposalBadge(item.status)}</TableCell>
                        <TableCell className="max-w-[140px] truncate text-xs font-medium">
                          {styleName(item.styleSlug)}
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate text-sm">
                          {item.summary}
                        </TableCell>
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
                                Применить
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                                disabled={proposalActionId === item.id}
                                onClick={() => void handleProposalStatus(item.id, "dismissed")}
                              >
                                <XCircleIcon className="size-3.5" />
                                Отклонить
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
                              Вернуть
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
                              Проверить
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
                <CardTitle className="text-sm">Проверки версии</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Статус</TableHead>
                      <TableHead>Стили</TableHead>
                      <TableHead>Решение</TableHead>
                      <TableHead className="text-right">Pairs</TableHead>
                      <TableHead className="text-right">LB</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(coach?.shadows ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                          Проверок версии пока нет
                        </TableCell>
                      </TableRow>
                    )}
                    {coach?.shadows.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{shadowBadge(item.status)}</TableCell>
                        <TableCell className="max-w-[190px] truncate text-xs font-medium">
                          {styleName(item.parentStyleSlug)} → {styleName(item.newStyleSlug)}
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
        </div>
      </details>

      <QualityInspectorDialog
        inspector={inspector}
        styleName={styleName}
        personaName={personaName}
        onOpenChange={(open) => !open && setInspector(null)}
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

function ExchangeSafetyContractsCard({
  result,
  running,
  onRun,
}: {
  result: ExchangeAnswerQualityEvalResult | null;
  running: boolean;
  onRun: () => void;
}) {
  const failed = result?.summary.failed ?? 0;
  const passed = result?.summary.passed ?? 0;
  const total = result?.summary.total ?? 0;
  const hasFailures = failed > 0;

  return (
    <Card
      className={cn(
        "border-l-4",
        result
          ? hasFailures
            ? "border-l-destructive"
            : "border-l-[var(--success)]"
          : "border-l-blue-500",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-sm">
              {result ? (
                hasFailures ? (
                  <XCircleIcon className="size-4 text-destructive" />
                ) : (
                  <CheckCircleIcon className="size-4 text-[var(--success)]" />
                )
              ) : (
                <TargetIcon className="size-4 text-blue-500" />
              )}
              Exchange safety contracts
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Детерминированная проверка KYC-видео, чека оплаты, выдачи в офисе и handoff до
              оператора.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={result ? "outline" : "default"}
            className="w-fit"
            onClick={onRun}
            disabled={running}
          >
            <RefreshCwIcon className={cn("size-4", running && "animate-spin")} />
            {running ? "Проверяем…" : "Прогнать contracts"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={hasFailures ? "destructive" : result ? "success" : "outline"}>
            {result ? `${passed}/${total} passed` : "not run"}
          </Badge>
          <Badge variant={hasFailures ? "destructive" : "outline"}>{failed} failed</Badge>
          <span className="text-xs text-muted-foreground">
            state-pack → deterministic contract → final policy guard
          </span>
        </div>

        {result ? (
          <>
            {result.failuresText && (
              <pre className="max-h-40 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs whitespace-pre-wrap text-destructive">
                {result.failuresText}
              </pre>
            )}
            <div className="grid min-w-0 gap-2 md:grid-cols-2">
              {result.report.map((item) => (
                <div key={item.id} className="min-w-0 rounded-md border bg-muted/25 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.title}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="secondary">{item.expectedContract ?? "contract"}</Badge>
                        {item.expectedDeterministic && (
                          <Badge variant="outline">deterministic</Badge>
                        )}
                      </div>
                    </div>
                    <Badge variant={item.passed ? "success" : "destructive"}>
                      {item.passed ? "pass" : "fail"}
                    </Badge>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {item.trace.map((line) => (
                      <div key={line} className="break-words">
                        {line}
                      </div>
                    ))}
                  </div>
                  {item.failures.length > 0 && (
                    <div className="mt-2 space-y-1 text-xs text-destructive">
                      {item.failures.map((failure) => (
                        <div
                          key={`${item.id}-${failure.expected}-${failure.actual}`}
                          className="break-words"
                        >
                          {failure.expected}: {failure.actual}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Этот быстрый replay не создаёт диалоги и не требует LLM. Он ловит опасные ответы:
            авто-верификацию документов, авто-подтверждение оплаты, преждевременные реквизиты и
            выдачу без подтверждённого статуса.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QualityInspectorDialog({
  inspector,
  styleName,
  personaName,
  onOpenChange,
}: {
  inspector: QualityInspectorState | null;
  styleName: (slug: string) => string;
  personaName: (slug: string) => string;
  onOpenChange: (open: boolean) => void;
}) {
  const open = inspector !== null;
  const title = inspector?.kind === "pairwise" ? "Сравнение стилей" : "Проверка стиля";

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
            <SelfPlayInspector
              match={inspector.match}
              styleName={styleName}
              personaName={personaName}
            />
          )}
          {inspector?.kind === "pairwise" && inspector.pairwise && (
            <PairwiseInspector
              pairwise={inspector.pairwise}
              styleName={styleName}
              personaName={personaName}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SelfPlayInspector({
  match,
  styleName,
  personaName,
}: {
  match: QualitySelfPlayMatch;
  styleName: (slug: string) => string;
  personaName: (slug: string) => string;
}) {
  return (
    <>
      <div className="grid gap-3 text-sm md:grid-cols-4">
        <InspectorMetric label="Стиль" value={styleName(match.styleSlug)} />
        <InspectorMetric label="Клиент" value={personaName(match.personaSlug)} />
        <InspectorMetric label="Результат" value={OUTCOME_LABEL[match.outcome] ?? match.outcome} />
        <InspectorMetric label="Ходов" value={match.turns} />
      </div>
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {match.verdict.reason || "нет пояснения"}
      </p>
      <TranscriptPane title="Диалог" transcript={match.transcript} />
    </>
  );
}

function PairwiseInspector({
  pairwise,
  styleName,
  personaName,
}: {
  pairwise: QualityPairwiseMatch;
  styleName: (slug: string) => string;
  personaName: (slug: string) => string;
}) {
  return (
    <>
      <div className="grid gap-3 text-sm md:grid-cols-4">
        <InspectorMetric
          label="Победил"
          value={
            pairwise.verdict.winner === "draw" ? "ничья" : pairwise.verdict.winner.toUpperCase()
          }
        />
        <InspectorMetric label="Клиент" value={personaName(pairwise.personaSlug)} />
        <InspectorMetric label="Стиль A" value={styleName(pairwise.styleASlug)} />
        <InspectorMetric label="Стиль B" value={styleName(pairwise.styleBSlug)} />
      </div>
      <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {pairwise.verdict.reason || "нет пояснения"}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <TranscriptPane
          title={`A: ${styleName(pairwise.styleASlug)}`}
          transcript={pairwise.matchA.transcript}
        />
        <TranscriptPane
          title={`B: ${styleName(pairwise.styleBSlug)}`}
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

function FirstRunHint({
  disabled,
  running,
  onRun,
}: {
  disabled: boolean;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/25 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium">Проверок пока нет</p>
          <p className="text-muted-foreground">
            Запустите тестовый диалог, чтобы увидеть первый вердикт по стилю бота.
          </p>
        </div>
      </div>
      <Button className="w-full sm:w-auto" disabled={disabled} onClick={onRun}>
        <FlaskConicalIcon className="size-4" />
        {running ? "Запуск…" : "Запустить первую проверку"}
      </Button>
    </div>
  );
}

function QualityRunResultCard({
  result,
  styleName,
  personaName,
  onInspect,
}: {
  result: QualityRunResult;
  styleName: (slug: string) => string;
  personaName: (slug: string) => string;
  onInspect: () => void;
}) {
  if (result.kind === "pairwise") {
    const winner = result.pairwise.verdict.winner;
    const winnerName =
      winner === "draw"
        ? "Стили показали близкий результат"
        : `Лучше сработал: ${styleName(
            winner === "a" ? result.pairwise.styleASlug : result.pairwise.styleBSlug,
          )}`;

    return (
      <Card className="border-l-4 border-l-blue-500">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrophyIcon className="size-4 text-blue-500" />
            {winnerName}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <ResultFact label="Стиль A" value={styleName(result.pairwise.styleASlug)} />
            <ResultFact label="Стиль B" value={styleName(result.pairwise.styleBSlug)} />
            <ResultFact label="Клиент" value={personaName(result.pairwise.personaSlug)} />
          </div>
          <p className="rounded-md bg-muted/35 px-3 py-2 text-sm">
            {result.pairwise.verdict.reason || "Судья не дал пояснение по сравнению."}
          </p>
          <Button variant="outline" onClick={onInspect}>
            <EyeIcon className="size-4" />
            Открыть диалоги
          </Button>
        </CardContent>
      </Card>
    );
  }

  const match = result.match;
  const hasRisk = match.outcome === "lost" || match.fabricationsCaught > 0;
  const isNeutral = match.outcome === "draw" && !hasRisk;
  const title = hasRisk
    ? "Есть риск в ответах"
    : isNeutral
      ? "Нужна ручная проверка"
      : "Бот прошёл проверку";
  const Icon = hasRisk ? XCircleIcon : isNeutral ? AlertTriangleIcon : CheckCircleIcon;
  const accentClass = hasRisk
    ? "border-l-destructive"
    : isNeutral
      ? "border-l-amber-500"
      : "border-l-[var(--success)]";

  return (
    <Card className={cn("border-l-4", accentClass)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon
            className={cn(
              "size-4",
              hasRisk ? "text-destructive" : isNeutral ? "text-amber-500" : "text-[var(--success)]",
            )}
          />
          {title}
          {outcomeBadge(match.outcome)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <ResultFact label="Стиль" value={styleName(match.styleSlug)} />
          <ResultFact label="Клиент" value={personaName(match.personaSlug)} />
          <ResultFact label="Ходов" value={match.turns} />
          <ResultFact label="Ошибок фактов" value={match.fabricationsCaught} />
        </div>
        <p className="rounded-md bg-muted/35 px-3 py-2 text-sm">
          {match.verdict.reason || "Судья не дал пояснение по проверке."}
        </p>
        {match.warnings.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            {match.warnings.slice(0, 2).join(" · ")}
          </div>
        )}
        <Button variant="outline" onClick={onInspect}>
          <EyeIcon className="size-4" />
          Открыть диалог
        </Button>
      </CardContent>
    </Card>
  );
}

function ResultFact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value}</p>
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
  const seenKeys = new Map<string, number>();

  return (
    <div className="rounded-md border">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      <div className="max-h-[420px] space-y-2 overflow-y-auto p-3">
        {transcript.length === 0 && (
          <p className="text-sm text-muted-foreground">Диалог недоступен</p>
        )}
        {transcript.map((turn) => {
          const baseKey = `${turn.role}-${turn.text}`;
          const seenCount = seenKeys.get(baseKey) ?? 0;
          seenKeys.set(baseKey, seenCount + 1);
          return (
            <div
              key={seenCount === 0 ? baseKey : `${baseKey}-${seenCount}`}
              className="rounded-md bg-muted/35 px-3 py-2"
            >
              <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                {turn.role === "candidate" ? "Клиент" : "Бот"}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{turn.text}</p>
            </div>
          );
        })}
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
