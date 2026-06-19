import {
  ArrowRightIcon,
  Building2Icon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  Clock3Icon,
  FlameIcon,
  GitBranchIcon,
  HourglassIcon,
  RouteIcon,
  TriangleAlertIcon,
  TrophyIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";

import type { FunnelAnalytics, LeadListItem, StageDefinition } from "@/api/saas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type FlowFilter = "all" | "hot" | "idle";

interface FunnelFlowProps {
  stages: StageDefinition[];
  leads: LeadListItem[];
  /** Сквозная аналитика воронки (конверсия + скорость). null у необменных тенантов. */
  analytics: FunnelAnalytics | null;
  onOpenLead: (leadId: number) => void;
  onOpenLeads: () => void;
  onOpenFunnel: () => void;
}

interface FlowStage {
  id: number | "unassigned";
  displayName: string;
  kind: StageDefinition["kind"] | "unassigned";
  stageType: StageDefinition["stageType"] | "unassigned";
  color: string;
  fields: StageDefinition["fields"];
  leads: LeadListItem[];
  /** Сколько лидов когда-либо вошло в этап (из аналитики). */
  entered: number | null;
  /** Среднее время в этапе, дни (из аналитики). */
  avgDays: number | null;
  /** Конверсия из предыдущего активного этапа, %. null = нет входящего / нет данных. */
  conversion: number | null;
  /** Отток лидов на входе в этап (entered[prev] - entered[this]). */
  drop: number | null;
}

const FILTER_LABEL: Record<FlowFilter, string> = {
  all: "Все",
  hot: "Горячие",
  idle: "Застряли",
};

const FALLBACK_COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#a855f7", "#10b981", "#f43f5e"];

const STAGE_ACTION: Record<string, string> = {
  form_fill: "собрать анкету",
  document_upload: "получить документ",
  document_signature: "провести подпись",
  rate_confirmation: "подтвердить курс",
  external_approval: "дождаться проверки",
  payment: "довести до оплаты",
  waiting: "снять ожидание",
  awaiting_operator: "подключить оператора",
  interaction: "задать следующий вопрос",
  assessment: "оценить заявку",
  milestone: "зафиксировать результат",
  unassigned: "назначить первый этап",
};

function normalizeMs(value: number | null | undefined): number | null {
  if (!value) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function activityMs(lead: LeadListItem): number {
  return (
    normalizeMs(lead.lastMessageAt) ??
    normalizeMs(lead.updatedAt) ??
    normalizeMs(lead.createdAt) ??
    0
  );
}

function ageHours(lead: LeadListItem): number {
  const last = activityMs(lead);
  if (!last) return 0;
  return Math.max(0, (Date.now() - last) / 3_600_000);
}

function formatAge(lead: LeadListItem): string {
  const hours = ageHours(lead);
  if (hours < 1) return "только что";
  if (hours < 24) return `${Math.round(hours)} ч назад`;
  return `${Math.round(hours / 24)} д назад`;
}

function formatDays(days: number): string {
  if (days <= 0) return "0 д";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} ч`;
  return `${Math.round(days * 10) / 10} д`;
}

function pluralLeads(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "лид";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "лида";
  return "лидов";
}

function usableColor(color: string | null | undefined, index: number): string {
  const clean = color?.trim();
  return clean && /^#[0-9a-f]{6}$/i.test(clean)
    ? clean
    : FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function shortName(lead: LeadListItem): string {
  return lead.contactName?.trim() || lead.applicationId || `Лид #${lead.id}`;
}

function leadProgress(lead: LeadListItem): number {
  if (lead.requiredFieldsTotal <= 0) return 20;
  return Math.round((lead.requiredFieldsFilled / lead.requiredFieldsTotal) * 100);
}

function isTerminalStage(stage: FlowStage | StageDefinition | null | undefined): boolean {
  return stage?.kind === "terminal_won" || stage?.kind === "terminal_lost";
}

function isWonLead(lead: LeadListItem, stage: StageDefinition | null | undefined) {
  return lead.state === "won" || stage?.kind === "terminal_won";
}

function isLostLead(lead: LeadListItem, stage: StageDefinition | null | undefined) {
  return lead.state === "lost" || stage?.kind === "terminal_lost";
}

function isTerminalLead(lead: LeadListItem, stageById: Map<number, StageDefinition>): boolean {
  const stage = lead.stageDefinitionId ? stageById.get(lead.stageDefinitionId) : null;
  return lead.state === "won" || lead.state === "lost" || isTerminalStage(stage);
}

function isHotLead(lead: LeadListItem, stageById: Map<number, StageDefinition>): boolean {
  if (isTerminalLead(lead, stageById)) return false;
  return ageHours(lead) <= 24;
}

function isIdleLead(lead: LeadListItem, stageById: Map<number, StageDefinition>): boolean {
  if (isTerminalLead(lead, stageById)) return false;
  return ageHours(lead) >= 72 || lead.state === "stale";
}

function stateLabel(lead: LeadListItem | null): string {
  if (!lead) return "нет лида";
  if (lead.state === "won") return "выигран";
  if (lead.state === "lost") return "потерян";
  if (lead.state === "stale") return "застрял";
  return "в работе";
}

function questionForStage(stage: FlowStage | null, lead: LeadListItem | null): string {
  if (!stage) return "выбрать этап";
  const missingField = stage.fields.find((field) => field.required);
  if (missingField) return `спросить: ${missingField.displayName}`;
  if (lead?.lastMessageText) return "ответить на последнее сообщение";
  return STAGE_ACTION[stage.stageType] ?? "сделать следующий шаг";
}

function filterLead(
  lead: LeadListItem,
  filter: FlowFilter,
  stageById: Map<number, StageDefinition>,
): boolean {
  if (filter === "hot") return isHotLead(lead, stageById);
  if (filter === "idle") return isIdleLead(lead, stageById);
  return true;
}

function stageLoadTone(
  stage: FlowStage,
  stageById: Map<number, StageDefinition>,
): "hot" | "idle" | "ok" {
  if (stage.leads.some((lead) => isIdleLead(lead, stageById))) return "idle";
  if (stage.leads.some((lead) => isHotLead(lead, stageById))) return "hot";
  return "ok";
}

function stageStyle(stage: FlowStage): CSSProperties {
  return { "--flow-color": stage.color } as CSSProperties;
}

interface BuiltFunnel {
  /** Активные этапы слева-направо (с буфером «Входящие» при наличии). */
  active: FlowStage[];
  won: number;
  lost: number;
}

/**
 * Строит ленту активных этапов с конверсией/скоростью и считает исходы.
 * Конверсия/время берутся из сквозной аналитики (не зависят от фильтра),
 * текущие лиды/чипы — из переданного (отфильтрованного) списка.
 */
function buildFunnel(
  stages: StageDefinition[],
  leads: LeadListItem[],
  analytics: FunnelAnalytics | null,
): BuiltFunnel {
  const sorted = [...stages].sort((a, b) => a.position - b.position || a.id - b.id);
  const stageIds = new Set(sorted.map((stage) => stage.id));
  const analyticsById = new Map((analytics?.stages ?? []).map((stage) => [stage.id, stage]));
  const unassignedLeads = leads.filter(
    (lead) => !lead.stageDefinitionId || !stageIds.has(lead.stageDefinitionId),
  );

  const mapped: FlowStage[] = sorted.map((stage, index) => {
    const a = analyticsById.get(stage.id) ?? null;
    return {
      id: stage.id,
      displayName: stage.displayName,
      kind: stage.kind,
      stageType: stage.stageType,
      color: usableColor(stage.color, index),
      fields: stage.fields,
      leads: leads.filter((lead) => lead.stageDefinitionId === stage.id),
      entered: a?.leadsEntered ?? null,
      avgDays: a?.avgDaysInStage ?? null,
      conversion: null,
      drop: null,
    };
  });

  // Цепочка конверсии — только проходные этапы (терминалы — это исходы, не шаги).
  const chain = mapped.filter((stage) => stage.kind === "intake" || stage.kind === "active");
  let prevEntered: number | null = null;
  for (const stage of chain) {
    if (prevEntered != null && prevEntered > 0 && stage.entered != null) {
      stage.conversion = Math.round((stage.entered / prevEntered) * 100);
      stage.drop = Math.max(0, prevEntered - stage.entered);
    }
    if (stage.entered != null) prevEntered = stage.entered;
  }

  const active: FlowStage[] = [];
  if (unassignedLeads.length > 0 || chain.length === 0) {
    active.push({
      id: "unassigned",
      displayName: "Входящие",
      kind: "unassigned",
      stageType: "unassigned",
      color: "#64748b",
      fields: [],
      leads: unassignedLeads,
      entered: null,
      avgDays: null,
      conversion: null,
      drop: null,
    });
  }
  active.push(...chain);

  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const won = leads.filter((lead) =>
    isWonLead(lead, lead.stageDefinitionId ? stageById.get(lead.stageDefinitionId) : null),
  ).length;
  const lost = leads.filter((lead) =>
    isLostLead(lead, lead.stageDefinitionId ? stageById.get(lead.stageDefinitionId) : null),
  ).length;

  return { active, won, lost };
}

export function FunnelFlow({
  stages,
  leads,
  analytics,
  onOpenLead,
  onOpenLeads,
  onOpenFunnel,
}: FunnelFlowProps) {
  const [filter, setFilter] = useState<FlowFilter>("all");
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);

  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);

  const filteredLeads = useMemo(
    () => leads.filter((lead) => filterLead(lead, filter, stageById)),
    [filter, leads, stageById],
  );

  const funnel = useMemo(
    () => buildFunnel(stages, filteredLeads, analytics),
    [stages, filteredLeads, analytics],
  );
  const active = funnel.active;
  const maxCurrent = useMemo(
    () => Math.max(1, ...active.map((stage) => stage.leads.length)),
    [active],
  );

  // Сквозные номера присваиваем только проходным этапам, буфер «Входящие» — без номера.
  const stageNumbers = useMemo(() => {
    let n = 0;
    return active.map((stage) => (typeof stage.id === "number" ? ++n : null));
  }, [active]);

  const flowStageById = useMemo(() => {
    const map = new Map<number, FlowStage>();
    for (const stage of active) {
      if (typeof stage.id === "number") map.set(stage.id, stage);
    }
    return map;
  }, [active]);

  // Узкое место: проходной этап с минимальной конверсией (тай-брейк — медленнее).
  const bottleneck = useMemo(() => {
    const candidates = active.filter((stage) => stage.conversion != null);
    if (candidates.length === 0) return null;
    return candidates.reduce((worst, stage) => {
      const c = stage.conversion ?? 100;
      const wc = worst.conversion ?? 100;
      if (c < wc) return stage;
      if (c === wc && (stage.avgDays ?? 0) > (worst.avgDays ?? 0)) return stage;
      return worst;
    });
  }, [active]);

  useEffect(() => {
    if (filteredLeads.length === 0) {
      setSelectedLeadId(null);
      return;
    }
    if (!selectedLeadId || !filteredLeads.some((lead) => lead.id === selectedLeadId)) {
      setSelectedLeadId(filteredLeads[0]?.id ?? null);
    }
  }, [filteredLeads, selectedLeadId]);

  const selectedLead = filteredLeads.find((lead) => lead.id === selectedLeadId) ?? null;
  const selectedStage =
    (selectedLead?.stageDefinitionId ? flowStageById.get(selectedLead.stageDefinitionId) : null) ??
    active.find((stage) => stage.id === "unassigned") ??
    active[0] ??
    null;
  const selectedQuestion = questionForStage(selectedStage, selectedLead);
  const selectedRequiredTotal = selectedLead?.requiredFieldsTotal ?? 0;
  const selectedRequiredFilled = selectedLead?.requiredFieldsFilled ?? 0;
  const selectedProgress = selectedLead ? leadProgress(selectedLead) : 0;

  const metrics = useMemo(
    () => ({
      total: leads.length,
      hot: leads.filter((lead) => isHotLead(lead, stageById)).length,
      idle: leads.filter((lead) => isIdleLead(lead, stageById)).length,
      won: leads.filter((lead) =>
        isWonLead(lead, lead.stageDefinitionId ? stageById.get(lead.stageDefinitionId) : null),
      ).length,
    }),
    [leads, stageById],
  );

  const stageCount = active.filter((stage) => typeof stage.id === "number").length;
  const firstEntered = active.find(
    (stage) => stage.kind !== "unassigned" && stage.entered != null,
  )?.entered;
  const overall =
    firstEntered && firstEntered > 0 ? Math.round((funnel.won / firstEntered) * 100) : null;
  const subtitle =
    `${stageCount} ${stageCount === 1 ? "этап" : "этапов"} в потоке` +
    (overall != null ? ` · сквозная конверсия ${overall}%` : "");

  function focusBottleneck() {
    if (!bottleneck) return;
    const target =
      bottleneck.leads.find((lead) => isIdleLead(lead, stageById)) ?? bottleneck.leads[0];
    if (target) {
      setSelectedLeadId(target.id);
    } else {
      onOpenLeads();
    }
  }

  const visibleLeadRows = filteredLeads.slice(0, 8);

  return (
    <section className="funnel-flow-shell">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <RouteIcon className="size-4" />
              Поток воронки
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">Где сейчас лиды</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Объём, конверсия между этапами и узкое место — слева направо по воронке.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border p-0.5">
              {(Object.keys(FILTER_LABEL) as FlowFilter[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    filter === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {FILTER_LABEL[value]}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={onOpenFunnel}>
              <RouteIcon />
              Воронка
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FlowMetric
            icon={<UsersRoundIcon className="size-4" />}
            label="Лидов в схеме"
            value={metrics.total}
          />
          <FlowMetric
            icon={<FlameIcon className="size-4" />}
            label="Горячих"
            value={metrics.hot}
            tone="hot"
          />
          <FlowMetric
            icon={<HourglassIcon className="size-4" />}
            label="Застряли"
            value={metrics.idle}
            tone="idle"
          />
          <FlowMetric
            icon={<TrophyIcon className="size-4" />}
            label="Выдано"
            value={metrics.won}
            tone="won"
          />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
          <div className="funnel-flow-board">
            <div className="funnel-flow-toolbar">
              <div>
                <p className="text-sm font-semibold">{subtitle}</p>
                <p className="text-xs text-muted-foreground">
                  {filteredLeads.length} {pluralLeads(filteredLeads.length)} в текущем фильтре
                </p>
              </div>
              <Badge variant="secondary">
                <GitBranchIcon className="mr-1 size-3" />
                Live
              </Badge>
            </div>

            {bottleneck && (
              <div className="funnel-flow-bottleneck">
                <TriangleAlertIcon className="size-4 shrink-0" />
                <p className="min-w-0 flex-1 text-sm">
                  Узкое место: <span className="font-semibold">{bottleneck.displayName}</span> —
                  конверсия {bottleneck.conversion}%
                  {bottleneck.drop != null && bottleneck.drop > 0
                    ? `, теряется ${bottleneck.drop} ${pluralLeads(bottleneck.drop)}`
                    : ""}
                  {bottleneck.avgDays != null
                    ? `, ср. ожидание ${formatDays(bottleneck.avgDays)}`
                    : ""}
                  .
                </p>
                <Button size="sm" variant="outline" onClick={focusBottleneck}>
                  Разобрать
                </Button>
              </div>
            )}

            <div className="funnel-flow-lane">
              {active.map((stage, index) => (
                <Fragment key={stage.id}>
                  {index > 0 && <StageConnector conversion={stage.conversion} />}
                  <StageColumn
                    stage={stage}
                    number={stageNumbers[index]}
                    maxCurrent={maxCurrent}
                    stageById={stageById}
                    isBottleneck={bottleneck?.id === stage.id}
                    selectedStageId={selectedStage?.id ?? null}
                    selectedLeadId={selectedLeadId}
                    onSelectStage={(target) => setSelectedLeadId(target.leads[0]?.id ?? null)}
                    onSelectLead={setSelectedLeadId}
                  />
                </Fragment>
              ))}
              <StageConnector outcome />
              <OutcomeTiles won={funnel.won} lost={funnel.lost} />
            </div>
          </div>

          <aside className="funnel-flow-panel">
            {selectedLead ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold">{shortName(selectedLead)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedStage?.displayName ?? "Без этапа"} · {formatAge(selectedLead)}
                    </p>
                  </div>
                  <Badge variant={isIdleLead(selectedLead, stageById) ? "warning" : "secondary"}>
                    {stateLabel(selectedLead)}
                  </Badge>
                </div>

                <div className="funnel-flow-action">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Следующий шаг
                  </p>
                  <p className="mt-1 text-sm font-medium">{selectedQuestion}</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Прогресс анкеты</span>
                    <span>
                      {selectedRequiredFilled}/{selectedRequiredTotal}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${selectedProgress}%` }}
                    />
                  </div>
                </div>

                {selectedLead.lastMessageText && (
                  <p className="line-clamp-3 rounded-md border bg-muted/35 p-3 text-sm text-muted-foreground">
                    {selectedLead.lastMessageText}
                  </p>
                )}

                <Button size="sm" onClick={() => onOpenLead(selectedLead.id)}>
                  Открыть лид
                  <ArrowRightIcon />
                </Button>
              </>
            ) : (
              <div className="grid min-h-48 place-items-center rounded-md border border-dashed text-center">
                <div className="px-6">
                  <Building2Icon className="mx-auto size-8 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">Лидов для этого фильтра нет</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Схема заполнится, когда заявки попадут в воронку.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Лиды</p>
                <Button variant="ghost" size="sm" onClick={onOpenLeads}>
                  Все
                </Button>
              </div>
              <div className="space-y-1.5">
                {visibleLeadRows.map((lead) => {
                  const stage = lead.stageDefinitionId
                    ? flowStageById.get(lead.stageDefinitionId)
                    : null;
                  const leadColor = stage?.color ?? "#64748b";
                  return (
                    <button
                      key={lead.id}
                      type="button"
                      className={`funnel-flow-row ${lead.id === selectedLeadId ? "is-selected" : ""}`}
                      onClick={() => setSelectedLeadId(lead.id)}
                    >
                      <span
                        className="funnel-flow-row-avatar"
                        style={{ backgroundColor: leadColor }}
                      >
                        <CircleDotIcon className="size-3" />
                      </span>
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-medium">
                          {shortName(lead)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {stage?.displayName ?? lead.stageName ?? "Входящие"}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">{formatAge(lead)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function StageConnector({
  conversion,
  outcome,
}: {
  conversion?: number | null;
  outcome?: boolean;
}) {
  if (outcome) {
    return (
      <div className="funnel-flow-connector is-outcome" aria-hidden="true">
        <ChevronRightIcon className="funnel-flow-connector-icon size-4" />
      </div>
    );
  }
  const tone =
    conversion == null ? "na" : conversion >= 75 ? "good" : conversion >= 50 ? "warn" : "bad";
  return (
    <div className={`funnel-flow-connector is-${tone}`}>
      <ChevronRightIcon className="funnel-flow-connector-icon size-4" />
      {conversion != null && <span className="funnel-flow-pill">{conversion}%</span>}
    </div>
  );
}

function StageColumn({
  stage,
  number,
  maxCurrent,
  stageById,
  isBottleneck,
  selectedStageId,
  selectedLeadId,
  onSelectStage,
  onSelectLead,
}: {
  stage: FlowStage;
  number: number | null;
  maxCurrent: number;
  stageById: Map<number, StageDefinition>;
  isBottleneck: boolean;
  selectedStageId: FlowStage["id"] | null;
  selectedLeadId: number | null;
  onSelectStage: (stage: FlowStage) => void;
  onSelectLead: (leadId: number) => void;
}) {
  const current = stage.leads.length;
  const hotCount = stage.leads.filter((lead) => isHotLead(lead, stageById)).length;
  const idleCount = stage.leads.filter((lead) => isIdleLead(lead, stageById)).length;
  const tone = stageLoadTone(stage, stageById);
  const barWidth = current > 0 ? Math.max(8, Math.round((current / maxCurrent) * 100)) : 0;

  return (
    <button
      type="button"
      className={`funnel-flow-col is-${tone} ${isBottleneck ? "is-bottleneck" : ""} ${
        stage.id === selectedStageId ? "is-selected" : ""
      }`}
      style={stageStyle(stage)}
      onClick={() => onSelectStage(stage)}
    >
      <span className="funnel-flow-col-head">
        <span className="funnel-flow-col-index">
          {number ?? <CircleDotIcon className="size-3" />}
        </span>
        <span className="block min-w-0 flex-1 text-sm font-semibold leading-tight">
          {stage.displayName}
        </span>
      </span>

      <span className="funnel-flow-count">
        {current}
        <small>сейчас</small>
      </span>

      <span className="funnel-flow-bar">
        <span style={{ width: `${barWidth}%` }} />
      </span>

      <span className="funnel-flow-meta">
        {stage.avgDays != null && (
          <span className="inline-flex items-center gap-1">
            <Clock3Icon className="size-3" />
            {formatDays(stage.avgDays)}
          </span>
        )}
        {hotCount > 0 && (
          <span className="funnel-flow-tag is-hot">
            <FlameIcon className="size-3" />
            {hotCount}
          </span>
        )}
        {idleCount > 0 && (
          <span className="funnel-flow-tag is-idle">
            <HourglassIcon className="size-3" />
            {idleCount}
          </span>
        )}
      </span>

      <span className="funnel-flow-chips">
        {stage.leads.slice(0, 3).map((lead) => (
          <span
            key={lead.id}
            className={`funnel-flow-chip ${lead.id === selectedLeadId ? "is-selected" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelectLead(lead.id);
            }}
          >
            <span className="funnel-flow-chip-dot" />
            <span className="truncate">{shortName(lead)}</span>
          </span>
        ))}
        {stage.leads.length > 3 && (
          <span className="funnel-flow-chip-more">+{stage.leads.length - 3}</span>
        )}
        {stage.leads.length === 0 && <span className="funnel-flow-empty">пусто</span>}
      </span>
    </button>
  );
}

function OutcomeTiles({ won, lost }: { won: number; lost: number }) {
  return (
    <div className="funnel-flow-outcomes">
      <div className="funnel-flow-outcome is-won">
        <CircleCheckIcon className="size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block text-lg font-semibold tabular-nums">{won}</span>
          <span className="block text-xs">Выдано</span>
        </span>
      </div>
      <div className="funnel-flow-outcome is-lost">
        <CircleXIcon className="size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block text-lg font-semibold tabular-nums">{lost}</span>
          <span className="block text-xs">Отменено</span>
        </span>
      </div>
    </div>
  );
}

function FlowMetric({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: "hot" | "idle" | "won";
}) {
  return (
    <div className={`funnel-flow-metric ${tone ? `is-${tone}` : ""}`}>
      <span className="funnel-flow-metric-icon">{icon}</span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}
