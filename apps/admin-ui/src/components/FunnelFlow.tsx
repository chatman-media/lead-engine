import {
  ArrowDownRightIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  Clock3Icon,
  GitBranchIcon,
  RouteIcon,
  TableIcon,
  TriangleAlertIcon,
  TrophyIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { FunnelAnalytics, LeadListItem, StageDefinition } from "@/api/saas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type FlowFilter = "all" | "hot" | "idle";
type FlowView = "flow" | "table";
type SortKey = "position" | "current" | "entered" | "conversion" | "avgDays" | "hot" | "idle";

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
  position: number;
  displayName: string;
  kind: StageDefinition["kind"] | "unassigned";
  stageType: StageDefinition["stageType"] | "unassigned";
  color: string;
  leads: LeadListItem[];
  current: number;
  hot: number;
  active: number;
  idle: number;
  /** Сколько лидов когда-либо вошло в этап (из аналитики). */
  entered: number | null;
  /** Среднее время в этапе, дни (из аналитики). */
  avgDays: number | null;
  /** Конверсия из предыдущего проходного этапа, %. null = старт / нет данных. */
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

function formatDays(days: number | null): string {
  if (days == null) return "—";
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

function isTerminalStage(stage: { kind?: string } | null | undefined): boolean {
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

function leadHealth(
  lead: LeadListItem,
  stageById: Map<number, StageDefinition>,
): "hot" | "idle" | "active" {
  if (isHotLead(lead, stageById)) return "hot";
  if (isIdleLead(lead, stageById)) return "idle";
  return "active";
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

function convTone(conversion: number | null): "good" | "warn" | "bad" | null {
  if (conversion == null) return null;
  if (conversion >= 75) return "good";
  if (conversion >= 50) return "warn";
  return "bad";
}

interface BuiltFunnel {
  /** Активные этапы слева-направо (с буфером «Входящие» при наличии). */
  active: FlowStage[];
  won: number;
  lost: number;
  inWork: number;
}

/**
 * Строит ленту активных этапов с конверсией/скоростью/здоровьем и считает исходы.
 * Конверсия/время — из сквозной аналитики (не зависят от фильтра); текущие лиды,
 * чипы и health-бар — из переданного (отфильтрованного) списка.
 */
function buildFunnel(
  stages: StageDefinition[],
  leads: LeadListItem[],
  analytics: FunnelAnalytics | null,
): BuiltFunnel {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const sorted = [...stages].sort((a, b) => a.position - b.position || a.id - b.id);
  const stageIds = new Set(sorted.map((stage) => stage.id));
  const analyticsById = new Map((analytics?.stages ?? []).map((stage) => [stage.id, stage]));
  const unassignedLeads = leads.filter(
    (lead) => !lead.stageDefinitionId || !stageIds.has(lead.stageDefinitionId),
  );

  const counts = (stageLeads: LeadListItem[]) => {
    const hot = stageLeads.filter((lead) => isHotLead(lead, stageById)).length;
    const idle = stageLeads.filter((lead) => isIdleLead(lead, stageById)).length;
    return { hot, idle, active: Math.max(0, stageLeads.length - hot - idle) };
  };

  const mapped: FlowStage[] = sorted.map((stage, index) => {
    const stageLeads = leads.filter((lead) => lead.stageDefinitionId === stage.id);
    const a = analyticsById.get(stage.id) ?? null;
    const c = counts(stageLeads);
    return {
      id: stage.id,
      position: stage.position,
      displayName: stage.displayName,
      kind: stage.kind,
      stageType: stage.stageType,
      color: usableColor(stage.color, index),
      leads: stageLeads,
      current: stageLeads.length,
      hot: c.hot,
      active: c.active,
      idle: c.idle,
      entered: a?.leadsEntered ?? null,
      avgDays: a?.avgDaysInStage ?? null,
      conversion: null,
      drop: null,
    };
  });

  // Конверсия — только по проходным этапам (терминалы — это исходы, не шаги).
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
  if (unassignedLeads.length > 0) {
    const c = counts(unassignedLeads);
    active.push({
      id: "unassigned",
      position: -1,
      displayName: "Входящие",
      kind: "unassigned",
      stageType: "unassigned",
      color: "#64748b",
      leads: unassignedLeads,
      current: unassignedLeads.length,
      hot: c.hot,
      active: c.active,
      idle: c.idle,
      entered: null,
      avgDays: null,
      conversion: null,
      drop: null,
    });
  }
  active.push(...chain);

  const won = leads.filter((lead) =>
    isWonLead(lead, lead.stageDefinitionId ? stageById.get(lead.stageDefinitionId) : null),
  ).length;
  const lost = leads.filter((lead) =>
    isLostLead(lead, lead.stageDefinitionId ? stageById.get(lead.stageDefinitionId) : null),
  ).length;
  const inWork = leads.filter((lead) => !isTerminalLead(lead, stageById)).length;

  return { active, won, lost, inWork };
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
  const [view, setView] = useState<FlowView>("flow");
  const [selectedId, setSelectedId] = useState<FlowStage["id"] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("position");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);

  // Фильтр сужает лиды (счётчики/чипы/дрилл-даун); конверсия/время берутся из аналитики.
  const filteredLeads = useMemo(
    () => leads.filter((lead) => filterLead(lead, filter, stageById)),
    [filter, leads, stageById],
  );

  const funnel = useMemo(
    () => buildFunnel(stages, filteredLeads, analytics),
    [stages, filteredLeads, analytics],
  );
  const active = funnel.active;
  const chain = useMemo(() => active.filter((s) => typeof s.id === "number"), [active]);

  const stageNumber = useMemo(() => {
    const map = new Map<FlowStage["id"], number>();
    chain.forEach((stage, index) => map.set(stage.id, index + 1));
    return map;
  }, [chain]);

  // Узкое место: проходной этап с минимальной конверсией (тай-брейк — медленнее).
  const bottleneck = useMemo(() => {
    const candidates = chain.filter((stage) => stage.conversion != null);
    if (candidates.length === 0) return null;
    return candidates.reduce((worst, stage) => {
      const c = stage.conversion ?? 100;
      const wc = worst.conversion ?? 100;
      if (c < wc) return stage;
      if (c === wc && (stage.avgDays ?? 0) > (worst.avgDays ?? 0)) return stage;
      return worst;
    });
  }, [chain]);

  // Если выбранный этап выпал из текущего фильтра — снимаем выбор.
  useEffect(() => {
    if (selectedId != null && !active.some((stage) => stage.id === selectedId)) {
      setSelectedId(null);
    }
  }, [active, selectedId]);

  const selectedStage = active.find((stage) => stage.id === selectedId) ?? null;

  const firstEntered = chain.find((stage) => stage.entered != null)?.entered;
  const overall =
    firstEntered && firstEntered > 0 ? Math.round((funnel.won / firstEntered) * 100) : null;
  const cycleDays = chain.reduce<number | null>((sum, stage) => {
    if (stage.avgDays == null) return sum;
    return (sum ?? 0) + stage.avgDays;
  }, null);

  const subtitle = [
    `${chain.length} ${chain.length === 1 ? "этап" : "этапов"}`,
    overall != null ? `сквозная конверсия ${overall}%` : null,
    `${funnel.won} выдано`,
    funnel.lost > 0 ? `${funnel.lost} отменено` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  function toggleStage(id: FlowStage["id"]) {
    setSelectedId((prev) => (prev === id ? null : id));
  }

  function focusBottleneck() {
    if (bottleneck) {
      setView("flow");
      setSelectedId(bottleneck.id);
    } else {
      onOpenLeads();
    }
  }

  function setSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  const sortedForTable = useMemo(() => {
    const value = (stage: FlowStage): number => {
      switch (sortKey) {
        case "current":
          return stage.current;
        case "entered":
          return stage.entered ?? -1;
        case "conversion":
          return stage.conversion ?? -1;
        case "avgDays":
          return stage.avgDays ?? -1;
        case "hot":
          return stage.hot;
        case "idle":
          return stage.idle;
        default:
          return stage.position;
      }
    };
    return [...active].sort((a, b) => (value(a) - value(b)) * sortDir);
  }, [active, sortKey, sortDir]);

  return (
    <section className="funnel-flow-shell">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <RouteIcon className="size-4" />
              Воронка обмена
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">{subtitle}</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Объём, конверсия и узкое место. Кликните этап — раскроются его лиды.
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
            <div className="flex rounded-lg border p-0.5">
              <button
                type="button"
                onClick={() => setView("flow")}
                className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  view === "flow"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <RouteIcon className="size-3.5" />
                Поток
              </button>
              <button
                type="button"
                onClick={() => setView("table")}
                className={`flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  view === "table"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <TableIcon className="size-3.5" />
                Таблица
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={onOpenFunnel}>
              Настроить
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FlowMetric
            icon={<UsersRoundIcon className="size-4" />}
            label="В работе"
            value={String(funnel.inWork)}
          />
          <FlowMetric
            icon={<RouteIcon className="size-4" />}
            label="Сквозная конверсия"
            value={overall != null ? `${overall}%` : "—"}
          />
          <FlowMetric
            icon={<Clock3Icon className="size-4" />}
            label="Ср. цикл"
            value={cycleDays != null ? formatDays(cycleDays) : "—"}
          />
          <FlowMetric
            icon={<TrophyIcon className="size-4" />}
            label="Выдано"
            value={String(funnel.won)}
            tone="won"
          />
        </div>

        <div className="funnel-flow-board">
          <div className="funnel-flow-toolbar">
            <div className="funnel-flow-legend">
              <span>
                <i className="funnel-flow-dot is-hot" /> горячие
              </span>
              <span>
                <i className="funnel-flow-dot is-active" /> в работе
              </span>
              <span>
                <i className="funnel-flow-dot is-idle" /> застряли
              </span>
            </div>
            <Badge variant="secondary">
              <GitBranchIcon className="mr-1 size-3" />
              {filteredLeads.length} {pluralLeads(filteredLeads.length)}
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

          {view === "flow" ? (
            <div className="funnel-flow-body">
              {chain.length > 0 && (
                <FunnelRibbon
                  chain={chain}
                  selectedId={selectedId}
                  bottleneckId={bottleneck?.id ?? null}
                  onSelect={toggleStage}
                />
              )}

              <div className="funnel-flow-rail">
                {active.map((stage) => (
                  <StageCard
                    key={stage.id}
                    stage={stage}
                    number={stageNumber.get(stage.id) ?? null}
                    isBottleneck={bottleneck?.id === stage.id}
                    isSelected={selectedId === stage.id}
                    filter={filter}
                    onToggle={() => toggleStage(stage.id)}
                  />
                ))}
                <OutcomeTiles won={funnel.won} lost={funnel.lost} />
              </div>

              {selectedStage && (
                <StageDrawer
                  stage={selectedStage}
                  number={stageNumber.get(selectedStage.id) ?? null}
                  stageById={stageById}
                  onOpenLead={onOpenLead}
                  onClose={() => setSelectedId(null)}
                />
              )}
            </div>
          ) : (
            <FunnelTable
              rows={sortedForTable}
              numbers={stageNumber}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={setSort}
              onPick={(id) => {
                setView("flow");
                setSelectedId(id);
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function FunnelRibbon({
  chain,
  selectedId,
  bottleneckId,
  onSelect,
}: {
  chain: FlowStage[];
  selectedId: FlowStage["id"] | null;
  bottleneckId: FlowStage["id"] | null;
  onSelect: (id: FlowStage["id"]) => void;
}) {
  const W = 720;
  const H = 146;
  const pad = 12;
  const n = chain.length;
  const heights = chain.map((stage) => stage.entered ?? stage.current);
  const maxH = Math.max(1, ...heights);
  const slotW = (W - pad * 2) / n;
  const midY = H / 2 - 8;
  const maxBar = 96;
  const barH = (i: number) => Math.max(10, (heights[i] / maxH) * maxBar);
  const cx = (i: number) => pad + slotW * i + slotW / 2;

  const top = chain.map((_, i) => [cx(i), midY - barH(i) / 2] as const);
  const bot = chain.map((_, i) => [cx(i), midY + barH(i) / 2] as const);

  return (
    <svg
      className="funnel-flow-ribbon"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Воронка по объёму с конверсией между этапами"
    >
      {chain.slice(0, n - 1).map((stage, i) => {
        const points = [top[i], top[i + 1], bot[i + 1], bot[i]].map((p) => p.join(",")).join(" ");
        const isBn = chain[i].id === bottleneckId || chain[i + 1].id === bottleneckId;
        const opacity = 0.4 + 0.5 * (heights[i] / maxH);
        return (
          <polygon
            key={`seg-${stage.id}`}
            className={`funnel-flow-slice ${isBn ? "is-bn" : ""}`}
            points={points}
            style={{ fillOpacity: opacity }}
          />
        );
      })}
      {chain.map((stage, i) => {
        const tone = convTone(stage.conversion);
        const selected = stage.id === selectedId;
        return (
          <g key={`node-${stage.id}`}>
            <circle
              className={`funnel-flow-ribbon-dot ${selected ? "is-selected" : ""}`}
              cx={cx(i)}
              cy={midY}
              r={selected ? 4 : 2.5}
            />
            <text
              className="funnel-flow-ribbon-num"
              x={cx(i)}
              y={midY - barH(i) / 2 - 6}
              textAnchor="middle"
            >
              {stage.current}
            </text>
            {i > 0 && stage.conversion != null && (
              <text
                className={`funnel-flow-ribbon-conv is-${tone}`}
                x={pad + slotW * i}
                y={midY + barH(i) / 2 + 16}
                textAnchor="middle"
              >
                {stage.conversion}%
              </text>
            )}
            <text className="funnel-flow-ribbon-idx" x={cx(i)} y={H - 4} textAnchor="middle">
              {i + 1}
            </text>
            <rect
              className="funnel-flow-ribbon-hit"
              x={pad + slotW * i}
              y={0}
              width={slotW}
              height={H}
              onClick={() => onSelect(stage.id)}
            >
              <title>{stage.displayName}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function HealthBar({ stage }: { stage: FlowStage }) {
  const total = Math.max(1, stage.hot + stage.active + stage.idle);
  const seg = (count: number, tone: string) =>
    count > 0 ? (
      <span
        className={`funnel-flow-health-seg is-${tone}`}
        style={{ width: `${(count / total) * 100}%` }}
      />
    ) : null;
  return (
    <span className="funnel-flow-health">
      {seg(stage.hot, "hot")}
      {seg(stage.active, "active")}
      {seg(stage.idle, "idle")}
    </span>
  );
}

function ConvChip({ conversion }: { conversion: number | null }) {
  if (conversion == null) {
    return <span className="funnel-flow-start">старт</span>;
  }
  const tone = convTone(conversion);
  const Icon =
    conversion >= 75 ? ArrowUpRightIcon : conversion >= 50 ? ArrowRightIcon : ArrowDownRightIcon;
  return (
    <span className={`funnel-flow-conv is-${tone}`}>
      <Icon className="size-3" />
      {conversion}%
    </span>
  );
}

function StageCard({
  stage,
  number,
  isBottleneck,
  isSelected,
  filter,
  onToggle,
}: {
  stage: FlowStage;
  number: number | null;
  isBottleneck: boolean;
  isSelected: boolean;
  filter: FlowFilter;
  onToggle: () => void;
}) {
  const count = filter === "hot" ? stage.hot : filter === "idle" ? stage.idle : stage.current;
  const dimmed = filter !== "all" && count === 0;

  return (
    <button
      type="button"
      className={`funnel-flow-card ${isBottleneck ? "is-bottleneck" : ""} ${
        isSelected ? "is-selected" : ""
      } ${dimmed ? "is-dimmed" : ""}`}
      onClick={onToggle}
    >
      <span className="funnel-flow-card-head">
        <span className="funnel-flow-card-index">
          {number ?? <CircleDotIcon className="size-3" />}
        </span>
        <span className="funnel-flow-card-name">{stage.displayName}</span>
      </span>

      <span className="funnel-flow-card-count">
        {count}
        <ConvChip conversion={stage.conversion} />
      </span>

      <HealthBar stage={stage} />

      <span className="funnel-flow-card-foot">
        <span className="inline-flex items-center gap-1">
          <Clock3Icon className="size-3" />
          {formatDays(stage.avgDays)}
        </span>
        <span className="inline-flex items-center gap-1">
          {isSelected ? (
            <ChevronUpIcon className="size-3" />
          ) : (
            <ChevronDownIcon className="size-3" />
          )}
          {stage.current} лид.
        </span>
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

function StageDrawer({
  stage,
  number,
  stageById,
  onOpenLead,
  onClose,
}: {
  stage: FlowStage;
  number: number | null;
  stageById: Map<number, StageDefinition>;
  onOpenLead: (leadId: number) => void;
  onClose: () => void;
}) {
  const rows = stage.leads.slice(0, 12);
  return (
    <div className="funnel-flow-drawer">
      <div className="funnel-flow-drawer-head">
        <p className="text-sm font-medium">
          {number != null ? `${number}. ` : ""}
          {stage.displayName} · {stage.current} {pluralLeads(stage.current)}
        </p>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>конверсия {stage.conversion != null ? `${stage.conversion}%` : "—"}</span>
          <span>вошло {stage.entered ?? "—"}</span>
          <span>ср. {formatDays(stage.avgDays)}</span>
          <button type="button" className="funnel-flow-drawer-close" onClick={onClose}>
            Свернуть
          </button>
        </div>
      </div>
      {rows.length > 0 ? (
        <div className="funnel-flow-drawer-list">
          {rows.map((lead) => {
            const health = leadHealth(lead, stageById);
            return (
              <button
                key={lead.id}
                type="button"
                className="funnel-flow-lead"
                onClick={() => onOpenLead(lead.id)}
              >
                <span className="funnel-flow-lead-av" style={{ backgroundColor: stage.color }}>
                  {initials(shortName(lead))}
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm">{shortName(lead)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatAge(lead)}
                    {lead.lastMessageText ? ` · ${lead.lastMessageText}` : ""}
                  </span>
                </span>
                <span className={`funnel-flow-lead-dot is-${health}`} />
                <ArrowRightIcon className="size-3.5 text-muted-foreground" />
              </button>
            );
          })}
          {stage.current > rows.length && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              …и ещё {stage.current - rows.length}
            </p>
          )}
        </div>
      ) : (
        <p className="px-2 py-3 text-xs text-muted-foreground">Нет лидов под текущий фильтр.</p>
      )}
    </div>
  );
}

function FunnelTable({
  rows,
  numbers,
  sortKey,
  sortDir,
  onSort,
  onPick,
}: {
  rows: FlowStage[];
  numbers: Map<FlowStage["id"], number>;
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSort: (key: SortKey) => void;
  onPick: (id: FlowStage["id"]) => void;
}) {
  const columns: { key: SortKey; label: string }[] = [
    { key: "position", label: "Этап" },
    { key: "current", label: "Сейчас" },
    { key: "entered", label: "Вошло" },
    { key: "conversion", label: "Конверсия" },
    { key: "avgDays", label: "Ср. время" },
    { key: "hot", label: "Горячие" },
    { key: "idle", label: "Застряли" },
  ];
  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 1 ? " ↑" : " ↓") : "");
  return (
    <div className="funnel-flow-table-wrap">
      <table className="funnel-flow-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} onClick={() => onSort(col.key)}>
                {col.label}
                {arrow(col.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((stage) => {
            const tone = convTone(stage.conversion);
            const num = numbers.get(stage.id);
            return (
              <tr key={stage.id} onClick={() => onPick(stage.id)}>
                <td>
                  <span className="funnel-flow-table-idx">{num ?? "—"}</span>
                  {stage.displayName}
                </td>
                <td className="font-medium tabular-nums">{stage.current}</td>
                <td className="tabular-nums text-muted-foreground">{stage.entered ?? "—"}</td>
                <td>
                  {stage.conversion != null ? (
                    <span className={`funnel-flow-conv is-${tone}`}>{stage.conversion}%</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="tabular-nums text-muted-foreground">{formatDays(stage.avgDays)}</td>
                <td
                  className={`tabular-nums ${stage.hot ? "funnel-flow-num-hot" : "text-muted-foreground"}`}
                >
                  {stage.hot || "—"}
                </td>
                <td
                  className={`tabular-nums ${stage.idle ? "funnel-flow-num-idle" : "text-muted-foreground"}`}
                >
                  {stage.idle || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
  value: string;
  tone?: "won";
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
