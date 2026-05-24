import type { FunnelStageDef } from "@chatman-media/verticals";

export const VIDEO_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "inquiry",
    kind: "intake",
    displayName: "Первичный запрос",
    next: ["brief_call", "declined"],
  },
  {
    slug: "brief_call",
    kind: "lead",
    displayName: "Бриф / звонок",
    next: ["quote_sent", "declined"],
  },
  {
    slug: "quote_sent",
    kind: "lead",
    displayName: "Смета отправлена",
    next: ["quote_approved", "declined"],
  },
  {
    slug: "quote_approved",
    kind: "lead",
    displayName: "Смета согласована",
    next: ["shoot_scheduled", "declined"],
  },
  {
    slug: "shoot_scheduled",
    kind: "lead",
    displayName: "Съёмка назначена",
    next: ["editing", "declined"],
  },
  {
    slug: "editing",
    kind: "lead",
    displayName: "Монтаж",
    next: ["delivery"],
  },
  {
    slug: "delivery",
    kind: "lead",
    displayName: "Сдача материала",
    next: ["invoiced"],
  },
  { slug: "invoiced", kind: "terminal", displayName: "Счёт выставлен (завершено)" },
  { slug: "declined", kind: "terminal", displayName: "Отказ" },
];
