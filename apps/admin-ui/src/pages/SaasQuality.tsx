import {
  AlertTriangleIcon,
  BugIcon,
  DownloadIcon,
  RefreshCwIcon,
  TargetIcon,
  TimerIcon,
  TrophyIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  ApiError,
  clearToken,
  type QualityExportOptions,
  type QualityOutcome,
  type QualitySelfPlaySummary,
  saas,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function outcomeBadge(outcome: string) {
  const value = outcome as QualityOutcome;
  return (
    <Badge className={cn("border-transparent font-mono text-[11px]", OUTCOME_CLASS[value])}>
      {OUTCOME_LABEL[value] ?? outcome}
    </Badge>
  );
}

export function SaasQuality() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<QualitySelfPlaySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  const [styleSlug, setStyleSlug] = useState("all");
  const [personaSlug, setPersonaSlug] = useState("all");
  const [outcome, setOutcome] = useState<"all" | QualityOutcome>("all");
  const [limit, setLimit] = useState("200");
  const [includeTranscript, setIncludeTranscript] = useState(true);

  const styleOptions = useMemo(() => summary?.byStyle.map((item) => item.styleSlug) ?? [], [summary]);
  const personaOptions = useMemo(
    () => summary?.byPersona.map((item) => item.personaSlug) ?? [],
    [summary],
  );

  function load() {
    setLoading(true);
    setError("");
    saas
      .getQualitySelfPlaySummary()
      .then(setSummary)
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

  const totals = summary?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Качество"
        description="Self-play результаты, win-rate и JSONL выгрузка для анализа."
        actions={
          <>
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
              Обновить
            </Button>
            <Button onClick={handleExport} disabled={exporting}>
              <DownloadIcon className="size-4" />
              {exporting ? "Экспорт…" : "JSONL"}
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
        <div className="grid gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Card key={item}>
              <CardContent className="space-y-3 py-4">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-4">
          <MetricCard icon={TargetIcon} label="Матчи" value={totals?.total ?? 0} />
          <MetricCard icon={TrophyIcon} label="Win-rate" value={`${totals?.winRate ?? 0}%`} />
          <MetricCard icon={BugIcon} label="Фабрикации" value={totals?.fabricationsCaught ?? 0} />
          <MetricCard icon={TimerIcon} label="Avg turns" value={totals?.avgTurns ?? "нет"} />
        </div>
      )}

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
                </TableRow>
              </TableHeader>
              <TableBody>
                {(summary?.recent ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
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
