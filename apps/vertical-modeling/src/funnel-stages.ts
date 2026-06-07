import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * Воронка модельного агентства: кандидат → кастинг → оффер → показ/контракт.
 *
 * intake_pending  — сбор анкеты + портфолио (фото/видео)
 * intake_complete — анкета принята, проверяется агентством
 * casting_review  — на рассмотрении у кастинг-директора / партнёра
 * casting_approved— кастинг пройден, ждёт оффера
 * offer_sent      — предложение отправлено (контракт, гонорар, даты)
 * not_suitable    — не подходит (неактивный отказ без объяснений)
 * city            — уточнение города/логистики (промежуточная)
 * contract_signed — контракт подписан, идёт подготовка
 * show_confirmed  — показ/съёмка подтверждены
 * closed          — завершено
 * rejected        — отказ
 */
export const MODELING_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "intake_pending",
    kind: "intake",
    displayName: "Заполнение анкеты",
    next: ["intake_complete", "not_suitable", "rejected"],
  },
  {
    slug: "intake_complete",
    kind: "lead",
    displayName: "Анкета принята",
    next: ["casting_review", "not_suitable", "rejected"],
  },
  {
    slug: "casting_review",
    kind: "lead",
    displayName: "На рассмотрении кастинга",
    next: ["casting_approved", "not_suitable", "city", "rejected"],
  },
  {
    slug: "city",
    kind: "lead",
    displayName: "Уточнение города",
    next: ["casting_approved", "not_suitable", "rejected"],
  },
  {
    slug: "casting_approved",
    kind: "lead",
    displayName: "Кастинг пройден",
    next: ["offer_sent", "rejected"],
  },
  {
    slug: "offer_sent",
    kind: "lead",
    displayName: "Оффер отправлен",
    next: ["contract_signed", "rejected"],
  },
  {
    slug: "contract_signed",
    kind: "lead",
    displayName: "Контракт подписан",
    next: ["show_confirmed"],
  },
  {
    slug: "show_confirmed",
    kind: "lead",
    displayName: "Показ/съёмка подтверждены",
    next: ["closed"],
  },
  { slug: "not_suitable", kind: "terminal", displayName: "Не подходит" },
  { slug: "rejected", kind: "terminal", displayName: "Отказ" },
  { slug: "closed", kind: "terminal", displayName: "Завершено" },
];
