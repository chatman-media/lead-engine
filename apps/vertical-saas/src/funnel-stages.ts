import type { FunnelStageDef } from "@chatman-media/verticals";

export const SAAS_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "discovery",
    kind: "intake",
    displayName: "Первичное знакомство",
    next: ["qualified", "lost"],
  },
  {
    slug: "qualified",
    kind: "lead",
    displayName: "Квалифицирован",
    next: ["demo_scheduled", "lost"],
  },
  {
    slug: "demo_scheduled",
    kind: "lead",
    displayName: "Демо назначено",
    next: ["demo_done", "lost"],
  },
  {
    slug: "demo_done",
    kind: "lead",
    displayName: "Демо проведено",
    next: ["proposal_sent", "lost"],
  },
  {
    slug: "proposal_sent",
    kind: "lead",
    displayName: "Коммерческое предложение отправлено",
    next: ["negotiation", "lost"],
  },
  {
    slug: "negotiation",
    kind: "lead",
    displayName: "Переговоры",
    next: ["signed", "lost"],
  },
  { slug: "signed", kind: "terminal", displayName: "Договор подписан" },
  { slug: "lost", kind: "terminal", displayName: "Не состоялось" },
];
