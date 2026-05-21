import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * Жизненный цикл лида в UAE-recruitment воронке. Список stage'ов
 * соответствует CHECK constraint leads_state_check в storage-schema —
 * conversation-engine при попытке смены state валидирует переход по
 * этой машине.
 *
 * Историческая справка (sales-guru): stage 'submitted' был расщеплён на
 * visa_form / visa_filing / visa_waiting когда добавили step-by-step
 * визовое интервью. В этом template'е visa_form — единственный stage
 * с активным взаимодействием бот↔кандидат во время визовой анкеты.
 */
export const RECRUITMENT_UAE_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "intake_pending",
    kind: "intake",
    displayName: "Заполнение анкеты",
    next: ["intake_complete", "rejected"],
  },
  {
    slug: "intake_complete",
    kind: "lead",
    displayName: "Анкета собрана",
    next: ["approved", "partner_review", "rejected"],
  },
  {
    slug: "partner_review",
    kind: "lead",
    displayName: "На рассмотрении у партнёра",
    next: ["approved", "rejected"],
  },
  {
    slug: "approved",
    kind: "lead",
    displayName: "Одобрена",
    next: ["docs_pending"],
  },
  {
    slug: "docs_pending",
    kind: "lead",
    displayName: "Сбор документов",
    next: ["docs_complete", "rejected"],
  },
  {
    slug: "docs_complete",
    kind: "lead",
    displayName: "Документы собраны",
    next: ["visa_form"],
  },
  {
    slug: "visa_form",
    kind: "lead",
    displayName: "Заполнение визовой анкеты",
    next: ["visa_filing", "rejected"],
  },
  {
    slug: "visa_filing",
    kind: "lead",
    displayName: "Подача документов на визу",
    next: ["visa_waiting"],
  },
  {
    slug: "visa_waiting",
    kind: "lead",
    displayName: "Ожидание решения по визе",
    next: ["ready_to_work", "rejected"],
  },
  {
    slug: "ready_to_work",
    kind: "lead",
    displayName: "Готова к работе",
    next: ["closed"],
  },
  { slug: "rejected", kind: "terminal", displayName: "Отказ" },
  { slug: "closed", kind: "terminal", displayName: "Завершено" },
];
