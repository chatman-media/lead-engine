import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * Воронка визового агентства.
 *
 * qualification (intake) → documents_collection → financial_verification →
 * application_submission → processing → visa_issued (won) / rejected (lost)
 *
 * Стадия `appeal` — опциональная ветка при отказе (можно подать апелляцию).
 */
export const VISA_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "qualification",
    kind: "intake",
    displayName: "Квалификация",
    next: ["documents_collection", "rejected"],
  },
  {
    slug: "documents_collection",
    kind: "lead",
    displayName: "Сбор документов",
    next: ["financial_verification", "rejected"],
  },
  {
    slug: "financial_verification",
    kind: "lead",
    displayName: "Финансовая проверка",
    next: ["application_submission", "rejected"],
  },
  {
    slug: "application_submission",
    kind: "lead",
    displayName: "Подача заявки",
    next: ["processing"],
  },
  {
    slug: "processing",
    kind: "lead",
    displayName: "Рассмотрение",
    next: ["visa_issued", "rejected"],
  },
  {
    slug: "visa_issued",
    kind: "terminal",
    displayName: "Виза выдана",
  },
  {
    slug: "rejected",
    kind: "terminal",
    displayName: "Отказ",
  },
];
