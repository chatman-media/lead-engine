import {
  ArrowRightIcon,
  Building2Icon,
  CircleDotIcon,
  Clock3Icon,
  FlameIcon,
  GitBranchIcon,
  MapIcon,
  RouteIcon,
  TrophyIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";

import type { LeadListItem, StageDefinition } from "@/api/saas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type CityFilter = "all" | "hot" | "idle";

interface PipelineMap3dProps {
  stages: StageDefinition[];
  leads: LeadListItem[];
  onOpenLead: (leadId: number) => void;
  onOpenLeads: () => void;
  onOpenFunnel: () => void;
}

interface CityStage {
  id: number | "unassigned";
  displayName: string;
  kind: StageDefinition["kind"] | "unassigned";
  stageType: StageDefinition["stageType"] | "unassigned";
  color: string;
  fields: StageDefinition["fields"];
  leads: LeadListItem[];
}

interface FlowNode {
  stage: CityStage;
  index: number;
  x: number;
  y: number;
}

const FILTER_LABEL: Record<CityFilter, string> = {
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

function isTerminalStage(stage: CityStage | StageDefinition | null | undefined): boolean {
  return stage?.kind === "terminal_won" || stage?.kind === "terminal_lost";
}

function isWonLead(lead: LeadListItem, stage: CityStage | StageDefinition | null | undefined) {
  return lead.state === "won" || stage?.kind === "terminal_won";
}

function isTerminalLead(
  lead: LeadListItem,
  stageById: Map<number, StageDefinition> | Map<number, CityStage>,
): boolean {
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

function questionForStage(stage: CityStage | null, lead: LeadListItem | null): string {
  if (!stage) return "выбрать этап";
  const missingField = stage.fields.find((field) => field.required);
  if (missingField) return `спросить: ${missingField.displayName}`;
  if (lead?.lastMessageText) return "ответить на последнее сообщение";
  return STAGE_ACTION[stage.stageType] ?? "сделать следующий шаг";
}

function filterLead(
  lead: LeadListItem,
  filter: CityFilter,
  stageById: Map<number, StageDefinition>,
): boolean {
  if (filter === "hot") return isHotLead(lead, stageById);
  if (filter === "idle") return isIdleLead(lead, stageById);
  return true;
}

function buildCityStages(stages: StageDefinition[], leads: LeadListItem[]): CityStage[] {
  const sorted = [...stages].sort((a, b) => a.position - b.position || a.id - b.id);
  const stageIds = new Set(sorted.map((stage) => stage.id));
  const unassignedLeads = leads.filter(
    (lead) => !lead.stageDefinitionId || !stageIds.has(lead.stageDefinitionId),
  );
  const mapped = sorted.map((stage, index) => ({
    id: stage.id,
    displayName: stage.displayName,
    kind: stage.kind,
    stageType: stage.stageType,
    color: usableColor(stage.color, index),
    fields: stage.fields,
    leads: leads.filter((lead) => lead.stageDefinitionId === stage.id),
  }));

  if (unassignedLeads.length > 0 || mapped.length === 0) {
    return [
      {
        id: "unassigned",
        displayName: "Входящие",
        kind: "unassigned",
        stageType: "unassigned",
        color: "#64748b",
        fields: [],
        leads: unassignedLeads,
      },
      ...mapped,
    ];
  }

  return mapped;
}

function createFlowNodes(cityStages: CityStage[]): FlowNode[] {
  const total = cityStages.length;
  const columns = Math.max(1, Math.ceil(total / 2));
  const xStep = columns <= 1 ? 0 : 72 / (columns - 1);
  return cityStages.map((stage, index) => ({
    stage,
    index,
    x: total === 1 ? 50 : index < columns ? 14 + index * xStep : 86 - (index - columns) * xStep,
    y: index < columns ? 28 : 70,
  }));
}

function stageCompletion(stage: CityStage): number {
  const total = stage.leads.reduce((sum, lead) => sum + lead.requiredFieldsTotal, 0);
  if (total <= 0) return stage.leads.length > 0 ? 20 : 0;
  const filled = stage.leads.reduce((sum, lead) => sum + lead.requiredFieldsFilled, 0);
  return Math.round((filled / total) * 100);
}

function stageLoadTone(
  stage: CityStage,
  stageById: Map<number, StageDefinition>,
): "hot" | "idle" | "ok" {
  if (stage.leads.some((lead) => isIdleLead(lead, stageById))) return "idle";
  if (stage.leads.some((lead) => isHotLead(lead, stageById))) return "hot";
  return "ok";
}

function stageStyle(stage: CityStage): CSSProperties {
  return { "--flow-color": stage.color } as CSSProperties;
}

function flowPoint(node: FlowNode): { x: number; y: number } {
  return { x: node.x * 10, y: 34 + node.y * 2.6 };
}

function flowPath(nodes: FlowNode[]): string {
  if (nodes.length === 0) return "";
  const first = flowPoint(nodes[0]);
  const parts = [`M ${first.x} ${first.y}`];
  for (let index = 1; index < nodes.length; index += 1) {
    const prev = flowPoint(nodes[index - 1]);
    const next = flowPoint(nodes[index]);
    const mid = (prev.x + next.x) / 2;
    parts.push(`C ${mid} ${prev.y}, ${mid} ${next.y}, ${next.x} ${next.y}`);
  }
  return parts.join(" ");
}

export function PipelineMap3d({
  stages,
  leads,
  onOpenLead,
  onOpenLeads,
  onOpenFunnel,
}: PipelineMap3dProps) {
  const [filter, setFilter] = useState<CityFilter>("all");
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);

  const stageById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);

  const filteredLeads = useMemo(
    () => leads.filter((lead) => filterLead(lead, filter, stageById)),
    [filter, leads, stageById],
  );

  const cityStages = useMemo(() => buildCityStages(stages, filteredLeads), [filteredLeads, stages]);
  const flowNodes = useMemo(() => createFlowNodes(cityStages), [cityStages]);

  const cityStageById = useMemo(() => {
    const map = new Map<number, CityStage>();
    for (const stage of cityStages) {
      if (typeof stage.id === "number") map.set(stage.id, stage);
    }
    return map;
  }, [cityStages]);

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
    (selectedLead?.stageDefinitionId ? cityStageById.get(selectedLead.stageDefinitionId) : null) ??
    cityStages.find((stage) => stage.id === "unassigned") ??
    cityStages[0] ??
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

  const visibleLeadRows = filteredLeads.slice(0, 8);

  return (
    <section className="lead-city-shell">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <MapIcon className="size-4" />
              Карта пути лида
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">Lead Flow Board</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Схема этапов, нагрузки и следующего действия по каждому лиду.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border p-0.5">
              {(Object.keys(FILTER_LABEL) as CityFilter[]).map((value) => (
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
          <CityMetric
            icon={<UsersRoundIcon className="size-4" />}
            label="Лидов в схеме"
            value={metrics.total}
          />
          <CityMetric
            icon={<FlameIcon className="size-4" />}
            label="Горячих"
            value={metrics.hot}
            tone="hot"
          />
          <CityMetric
            icon={<Clock3Icon className="size-4" />}
            label="Застряли"
            value={metrics.idle}
            tone="idle"
          />
          <CityMetric
            icon={<TrophyIcon className="size-4" />}
            label="Дошли до финиша"
            value={metrics.won}
          />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
          <div className="lead-city-board">
            <div className="lead-flow-toolbar">
              <div>
                <p className="text-sm font-semibold">Pipeline topology</p>
                <p className="text-xs text-muted-foreground">
                  {cityStages.length} этапов · {filteredLeads.length} лидов в текущем фильтре
                </p>
              </div>
              <Badge variant="secondary">
                <GitBranchIcon className="mr-1 size-3" />
                Live
              </Badge>
            </div>

            <div className="lead-flow-viewport">
              <div className="lead-flow-plane">
                <FlowRail nodes={flowNodes} />
                {flowNodes.map((node) => (
                  <StageNode
                    key={node.stage.id}
                    node={node}
                    stageById={stageById}
                    selectedStageId={selectedStage?.id ?? null}
                    selectedLeadId={selectedLeadId}
                    onSelectStage={(stage) => setSelectedLeadId(stage.leads[0]?.id ?? null)}
                    onSelectLead={setSelectedLeadId}
                  />
                ))}
              </div>
            </div>
          </div>

          <aside className="lead-city-panel">
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

                <div className="lead-city-action">
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
                    ? cityStageById.get(lead.stageDefinitionId)
                    : null;
                  const leadColor = stage?.color ?? "#64748b";
                  return (
                    <button
                      key={lead.id}
                      type="button"
                      className={`lead-city-row ${lead.id === selectedLeadId ? "is-selected" : ""}`}
                      onClick={() => setSelectedLeadId(lead.id)}
                    >
                      <span className="lead-city-row-avatar" style={{ backgroundColor: leadColor }}>
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

function FlowRail({ nodes }: { nodes: FlowNode[] }) {
  const path = flowPath(nodes);
  return (
    <svg className="lead-flow-rail" viewBox="0 0 1000 320" aria-hidden="true">
      <defs>
        <linearGradient id="lead-flow-gradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.5" />
          <stop offset="50%" stopColor="#a78bfa" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.48" />
        </linearGradient>
      </defs>
      <path className="lead-flow-rail-shadow" d={path} />
      <path className="lead-flow-rail-line" d={path} />
      {nodes.map((node) => {
        const point = flowPoint(node);
        return (
          <g key={node.stage.id}>
            <circle className="lead-flow-rail-dot-glow" cx={point.x} cy={point.y} r="22" />
            <circle className="lead-flow-rail-dot" cx={point.x} cy={point.y} r="6" />
          </g>
        );
      })}
    </svg>
  );
}

function StageNode({
  node,
  stageById,
  selectedStageId,
  selectedLeadId,
  onSelectStage,
  onSelectLead,
}: {
  node: FlowNode;
  stageById: Map<number, StageDefinition>;
  selectedStageId: CityStage["id"] | null;
  selectedLeadId: number | null;
  onSelectStage: (stage: CityStage) => void;
  onSelectLead: (leadId: number) => void;
}) {
  const { stage } = node;
  const hotCount = stage.leads.filter((lead) => isHotLead(lead, stageById)).length;
  const idleCount = stage.leads.filter((lead) => isIdleLead(lead, stageById)).length;
  const completion = stageCompletion(stage);
  const tone = stageLoadTone(stage, stageById);
  const requiredFields = stage.fields.filter((field) => field.required).length;

  return (
    <button
      type="button"
      className={`lead-flow-node is-${tone} ${stage.id === selectedStageId ? "is-selected" : ""}`}
      style={{
        ...stageStyle(stage),
        left: `${node.x}%`,
        top: `${node.y}%`,
      }}
      onClick={() => onSelectStage(stage)}
    >
      <span className="lead-flow-node-head">
        <span className="lead-flow-node-index">{node.index + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{stage.displayName}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {stage.leads.length} лидов · {requiredFields} полей
          </span>
        </span>
      </span>

      <span className="lead-flow-progress">
        <span style={{ width: `${completion}%` }} />
      </span>

      <span className="lead-flow-node-meta">
        <span>{completion}%</span>
        {hotCount > 0 && <span className="lead-flow-hot">{hotCount} hot</span>}
        {idleCount > 0 && <span className="lead-flow-idle">{idleCount} idle</span>}
      </span>

      <span className="lead-flow-chip-row">
        {stage.leads.slice(0, 3).map((lead) => (
          <span
            key={lead.id}
            className={`lead-flow-chip ${lead.id === selectedLeadId ? "is-selected" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelectLead(lead.id);
            }}
          >
            <span className="lead-flow-chip-dot" />
            <span className="truncate">{shortName(lead)}</span>
          </span>
        ))}
        {stage.leads.length > 3 && (
          <span className="lead-flow-chip-more">+{stage.leads.length - 3}</span>
        )}
        {stage.leads.length === 0 && <span className="lead-flow-empty">пусто</span>}
      </span>
    </button>
  );
}

function CityMetric({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: "hot" | "idle";
}) {
  return (
    <div className={`lead-city-metric ${tone ? `is-${tone}` : ""}`}>
      <span className="lead-city-metric-icon">{icon}</span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold tabular-nums">{value}</span>
        <span className="block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}
