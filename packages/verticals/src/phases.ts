// Универсальный «костяк» воронки: макро-фазы поверх конкретных стадий.
//
// 5 вертикалей (exchange / video / recruitment / real_estate / saas) — это одна
// машина из 6 макро-фаз с разным «весом». `kind` уже кодирует 3 якоря
// (capture / won / lost), а ось `phase` уточняет «середину»
// (qualify / offer / clear / fulfill) — и только для active-стадий. Всё, что
// ниже фазы (имена, stageType, поля, переходы, автоматизации), — это
// кастомизация конкретной вертикали.
//
// Этот модуль — единый источник истины семантики фаз. Литералы phase
// продублированы в @chatman-media/storage (schema.ts) для CHECK-констрейнта,
// т.к. storage не зависит от verticals — тот же паттерн, что для STAGE_KINDS.

/** Полный упорядоченный костяк: 3 якоря (capture/won/lost) + 4 «середины». */
export const FUNNEL_PHASES = [
  "capture", // первый контакт, сырой интент (= kind:intake)
  "qualify", // понять нужду + пригодность, оценить сделку
  "offer", // предложить условия (цена/курс/scope) + получить «да»
  "clear", // гейты: KYC/комплаенс, документы, одобрения 3-й стороны (опц.)
  "fulfill", // доставить обещанное + провести деньги (опц.)
  "won", // терминал-успех (= kind:terminal_won)
  "lost", // терминал-отказ (= kind:terminal_lost)
] as const;

export type FunnelPhase = (typeof FUNNEL_PHASES)[number];

/** Фазы, которые реально хранятся в stage_definitions.phase (только active). */
export const ACTIVE_PHASES = ["qualify", "offer", "clear", "fulfill"] as const;
export type ActivePhase = (typeof ACTIVE_PHASES)[number];

/** Обязательные по смыслу фазы «середины» — присутствуют в каждой воронке. */
export const REQUIRED_ACTIVE_PHASES: readonly ActivePhase[] = ["qualify", "offer"];

/** Индекс фазы в костяке — для проверки монотонности по position. */
const _order = {} as Record<FunnelPhase, number>;
for (let i = 0; i < FUNNEL_PHASES.length; i++) _order[FUNNEL_PHASES[i]!] = i;
export const PHASE_ORDER: Readonly<Record<FunnelPhase, number>> =
  Object.freeze(_order);

/** kind → якорная фаза. active якоря не имеет — фаза берётся из колонки phase. */
export const KIND_TO_ANCHOR_PHASE: Readonly<Record<string, FunnelPhase>> =
  Object.freeze({
    intake: "capture",
    terminal_won: "won",
    terminal_lost: "lost",
  });

export function isActivePhase(v: unknown): v is ActivePhase {
  return (
    typeof v === "string" && (ACTIVE_PHASES as readonly string[]).includes(v)
  );
}

/** Минимальная форма стадии, достаточная для классификации по фазе. */
export interface PhaseStageLike {
  kind: string;
  phase?: string | null;
  stageType?: string;
  position?: number;
  slug?: string;
  nextStages?: readonly string[];
}

/**
 * Эффективная фаза стадии: якорь по `kind` (intake / terminal_*), иначе —
 * хранимая `phase`. Для якорных kind колонка phase игнорируется, поэтому
 * kind↔phase не могут противоречить. Возвращает null, если active-стадия не
 * имеет валидной phase (нужен deriveDefaultPhase или backfill).
 */
export function effectivePhase(stage: PhaseStageLike): FunnelPhase | null {
  const anchor = KIND_TO_ANCHOR_PHASE[stage.kind];
  if (anchor) return anchor;
  return isActivePhase(stage.phase) ? stage.phase : null;
}

/**
 * Эвристика-фолбэк: фаза для active-стадии без явного тега — по stageType и
 * фазе предыдущей стадии. Применяется к кастомным / AI-воронкам, где оператор
 * не проставил phase. Сиды вертикалей тегируются явно (точнее эвристики).
 */
export function deriveDefaultPhase(
  stageType: string | undefined,
  prevPhase: ActivePhase | null,
): ActivePhase {
  const guess = guessPhaseByType(stageType, prevPhase);
  // Воронка движется только вперёд — не позволяем эвристике откатить фазу назад
  // (иначе, напр., document_signature после fulfill дал бы offer и сломал порядок).
  if (prevPhase && PHASE_ORDER[guess] < PHASE_ORDER[prevPhase]) return prevPhase;
  return guess;
}

function guessPhaseByType(
  stageType: string | undefined,
  prevPhase: ActivePhase | null,
): ActivePhase {
  const afterOffer = !!prevPhase && PHASE_ORDER[prevPhase] >= PHASE_ORDER.offer;
  switch (stageType) {
    case "assessment":
      // оценка/квалификация: до оффера — qualify, после — часть допуска
      return afterOffer ? "clear" : "qualify";
    case "rate_confirmation":
    case "document_signature":
      return "offer";
    case "external_approval":
    case "document_upload":
      return "clear";
    case "payment":
      return "fulfill";
    case "waiting":
      return prevPhase && PHASE_ORDER[prevPhase] >= PHASE_ORDER.fulfill
        ? "fulfill"
        : "clear";
    case "interaction":
      // звонок/встреча/просмотр: до оффера — квалификация, после — исполнение
      return afterOffer ? "fulfill" : "qualify";
    case "milestone":
      // контрольная точка двигает воронку вперёд от предыдущей фазы
      if (!prevPhase) return "qualify";
      if (prevPhase === "qualify") return "offer";
      if (prevPhase === "offer") return "fulfill";
      return prevPhase;
    default:
      // form_fill и прочее: первая активная фаза — qualify, иначе держим текущую
      return prevPhase ?? "qualify";
  }
}

export interface BackboneViolations {
  errors: string[];
  warnings: string[];
}

/**
 * Проверяет набор стадий на контракт костяка. `errors` блокируют применение
 * воронки (AI-builder), `warnings` — мягкие подсказки оператору.
 */
export function validateBackbone(
  stages: readonly PhaseStageLike[],
): BackboneViolations {
  const errors: string[] = [];
  const warnings: string[] = [];

  const intakeCount = stages.filter((s) => s.kind === "intake").length;
  const wonCount = stages.filter((s) => s.kind === "terminal_won").length;
  const lostCount = stages.filter((s) => s.kind === "terminal_lost").length;

  if (intakeCount !== 1)
    errors.push(
      `Должна быть ровно одна стадия kind=intake (сейчас ${intakeCount}).`,
    );
  if (wonCount < 1) errors.push("Нужна хотя бы одна стадия kind=terminal_won.");
  if (lostCount < 1)
    errors.push("Нужна хотя бы одна стадия kind=terminal_lost.");

  // Уникальность slug'ов и корректность ссылок nextStages.
  const slugs = new Set<string>();
  for (const s of stages) {
    if (!s.slug) continue;
    if (slugs.has(s.slug)) errors.push(`Дублирующийся slug: ${s.slug}.`);
    slugs.add(s.slug);
  }
  for (const s of stages) {
    for (const n of s.nextStages ?? []) {
      if (!slugs.has(n))
        errors.push(
          `Стадия ${s.slug ?? "?"} ссылается на несуществующий slug в nextStages: ${n}.`,
        );
    }
  }

  // Покрытие фаз: каждая active-стадия должна резолвиться в фазу.
  const present = new Set<FunnelPhase>();
  for (const s of stages) {
    const p = effectivePhase(s);
    if (p) present.add(p);
    else if (s.kind === "active")
      errors.push(
        `Active-стадия ${s.slug ?? "?"} не имеет фазы (phase) и не классифицируется.`,
      );
  }
  for (const req of REQUIRED_ACTIVE_PHASES) {
    if (!present.has(req))
      warnings.push(`Нет ни одной стадии фазы "${req}" — обычно она обязательна.`);
  }

  // Монотонность фаз по position: нельзя clear/fulfill до offer и т.п.
  // (lost-терминал может ответвляться на любой позиции — не учитываем).
  const ordered = stages
    .filter((s) => typeof s.position === "number")
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  let maxSeen = -1;
  for (const s of ordered) {
    const p = effectivePhase(s);
    if (!p || p === "lost") continue;
    const idx = PHASE_ORDER[p];
    if (idx < maxSeen)
      errors.push(
        `Стадия ${s.slug ?? "?"} (фаза ${p}) идёт после более поздней фазы — нарушен порядок костяка.`,
      );
    if (idx > maxSeen) maxSeen = idx;
  }

  return { errors, warnings };
}

/** Минимальная стадия скелета — совместима по структуре с SeedStage (без fields). */
export interface SkeletonStage {
  slug: string;
  displayName: string;
  kind: "intake" | "active" | "terminal_won" | "terminal_lost";
  stageType: string;
  phase?: ActivePhase;
  position: number;
  color?: string;
  nextStages: string[];
}

export interface SkeletonOptions {
  /** Включить фазу допуска (гейты: KYC/документы/одобрения третьих сторон). */
  includeClear?: boolean;
  /** Включить фазу исполнения (доставка + расчёт). По умолчанию да. */
  includeFulfill?: boolean;
}

// Дефолтный stageType + цвет на каждую фазу костяка.
const SKELETON_DEFAULTS: Record<
  ActivePhase | "capture" | "won" | "lost",
  { stageType: string; color: string; displayName: string }
> = {
  capture: { stageType: "form_fill", color: "#3b82f6", displayName: "Новый лид" },
  qualify: { stageType: "assessment", color: "#6366f1", displayName: "Квалификация" },
  offer: { stageType: "interaction", color: "#f59e0b", displayName: "Оффер" },
  clear: { stageType: "external_approval", color: "#8b5cf6", displayName: "Допуск" },
  fulfill: { stageType: "milestone", color: "#06b6d4", displayName: "Исполнение" },
  won: { stageType: "milestone", color: "#10b981", displayName: "Успех" },
  lost: { stageType: "milestone", color: "#ef4444", displayName: "Отказ" },
};

/**
 * Генерирует минимальный валидный «скелет» воронки по костяку:
 * capture(intake) → qualify → offer → [clear] → [fulfill] → won / lost.
 * Новая вертикаль начинает отсюда и кастомизирует поля/типы/имена поверх.
 * Результат гарантированно проходит validateBackbone.
 */
export function buildSkeletonFunnel(opts: SkeletonOptions = {}): SkeletonStage[] {
  const { includeClear = false, includeFulfill = true } = opts;

  const flowPhases: Array<ActivePhase> = ["qualify", "offer"];
  if (includeClear) flowPhases.push("clear");
  if (includeFulfill) flowPhases.push("fulfill");

  const stages: SkeletonStage[] = [];
  let position = 0;

  const cap = SKELETON_DEFAULTS.capture;
  stages.push({
    slug: "new",
    displayName: cap.displayName,
    kind: "intake",
    stageType: cap.stageType,
    color: cap.color,
    position: position++,
    nextStages: [],
  });
  for (const phase of flowPhases) {
    const d = SKELETON_DEFAULTS[phase];
    stages.push({
      slug: phase,
      displayName: d.displayName,
      kind: "active",
      stageType: d.stageType,
      phase,
      color: d.color,
      position: position++,
      nextStages: [],
    });
  }
  stages.push({
    slug: "won",
    displayName: SKELETON_DEFAULTS.won.displayName,
    kind: "terminal_won",
    stageType: SKELETON_DEFAULTS.won.stageType,
    color: SKELETON_DEFAULTS.won.color,
    position: position++,
    nextStages: [],
  });
  stages.push({
    slug: "lost",
    displayName: SKELETON_DEFAULTS.lost.displayName,
    kind: "terminal_lost",
    stageType: SKELETON_DEFAULTS.lost.stageType,
    color: SKELETON_DEFAULTS.lost.color,
    position: position++,
    nextStages: [],
  });

  // Связываем переходы: каждый рабочий этап → следующий по потоку + lost;
  // последний рабочий → won + lost. Терминалы — пустой nextStages.
  const flow = stages
    .filter((s) => s.kind === "intake" || s.kind === "active")
    .map((s) => s.slug);
  for (const s of stages) {
    if (s.kind === "terminal_won" || s.kind === "terminal_lost") continue;
    const i = flow.indexOf(s.slug);
    const forward = i < flow.length - 1 ? flow[i + 1]! : "won";
    s.nextStages = [forward, "lost"];
  }

  return stages;
}
