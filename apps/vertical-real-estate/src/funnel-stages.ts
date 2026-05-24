import type { FunnelStageDef } from "@chatman-media/verticals";

export const REAL_ESTATE_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "qualification",
    kind: "intake",
    displayName: "Квалификация",
    next: ["viewings", "deal_lost"],
  },
  {
    slug: "viewings",
    kind: "lead",
    displayName: "Просмотры",
    next: ["offer_negotiation", "deal_lost"],
  },
  {
    slug: "offer_negotiation",
    kind: "lead",
    displayName: "Оффер и переговоры",
    next: ["mou_signed", "deal_lost"],
  },
  {
    slug: "mou_signed",
    kind: "lead",
    displayName: "MOU подписан (Form F)",
    next: ["noc_application", "mortgage_approval", "dld_transfer"],
  },
  {
    slug: "noc_application",
    kind: "lead",
    displayName: "NOC от застройщика",
    next: ["mortgage_approval", "dld_transfer"],
  },
  {
    slug: "mortgage_approval",
    kind: "lead",
    displayName: "Одобрение ипотеки",
    next: ["dld_transfer"],
  },
  { slug: "dld_transfer", kind: "terminal", displayName: "Сделка закрыта (DLD)" },
  { slug: "deal_lost", kind: "terminal", displayName: "Сделка не состоялась" },
];
