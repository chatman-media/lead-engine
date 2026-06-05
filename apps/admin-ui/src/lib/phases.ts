// Универсальный костяк воронки для UI — зеркало packages/verticals/src/phases.ts.
// Якоря (capture/won/lost) выводятся из kind; «середина» (qualify/offer/clear/
// fulfill) хранится в stage.phase. Всё ниже фазы — кастомизация вертикали.

import type { StageDefinition, StagePhase } from "@/api/saas";

export type FunnelPhase = "capture" | "qualify" | "offer" | "clear" | "fulfill" | "won" | "lost";

export const FUNNEL_PHASES: FunnelPhase[] = [
  "capture",
  "qualify",
  "offer",
  "clear",
  "fulfill",
  "won",
  "lost",
];

export const PHASE_LABEL: Record<FunnelPhase, string> = {
  capture: "Захват",
  qualify: "Квалификация",
  offer: "Оффер",
  clear: "Допуск",
  fulfill: "Исполнение",
  won: "Успех",
  lost: "Отказ",
};

/** Акцентный цвет фазы (bg-класс) для полос/бэйджей. */
export const PHASE_ACCENT: Record<FunnelPhase, string> = {
  capture: "bg-blue-500",
  qualify: "bg-indigo-500",
  offer: "bg-amber-500",
  clear: "bg-violet-500",
  fulfill: "bg-cyan-500",
  won: "bg-emerald-500",
  lost: "bg-red-500",
};

const KIND_TO_ANCHOR: Record<string, FunnelPhase> = {
  intake: "capture",
  terminal_won: "won",
  terminal_lost: "lost",
};

const ACTIVE_PHASES = new Set<string>(["qualify", "offer", "clear", "fulfill"]);

/** Эффективная фаза: якорь по kind, иначе хранимая phase (для active). */
export function effectivePhase(stage: {
  kind: string;
  phase?: StagePhase | null;
}): FunnelPhase | null {
  const anchor = KIND_TO_ANCHOR[stage.kind];
  if (anchor) return anchor;
  return stage.phase && ACTIVE_PHASES.has(stage.phase) ? (stage.phase as FunnelPhase) : null;
}

export interface PhaseGroup {
  key: string; // FunnelPhase | "other"
  label: string;
  accent: string;
  stages: StageDefinition[];
}

/**
 * Группирует упорядоченные по position стадии в последовательные фаза-группы.
 * Стадии без фазы (active без phase) попадают в группу "Прочее".
 */
export function groupStagesByPhase(stages: StageDefinition[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  for (const stage of stages) {
    const phase = effectivePhase(stage);
    const key = phase ?? "other";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.stages.push(stage);
    } else {
      groups.push({
        key,
        label: phase ? PHASE_LABEL[phase] : "Прочее",
        accent: phase ? PHASE_ACCENT[phase] : "bg-gray-400",
        stages: [stage],
      });
    }
  }
  return groups;
}
