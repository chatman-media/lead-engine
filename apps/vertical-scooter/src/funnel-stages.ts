import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * Воронка аренды байков / скутеров.
 *
 * inquiry (intake) → booking_confirmed → payment_pending →
 * active_rental → returned (won) / cancelled (lost)
 *
 * Простая линейная воронка с высоким объёмом и коротким циклом сделки.
 */
export const SCOOTER_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "inquiry",
    kind: "intake",
    displayName: "Запрос аренды",
    next: ["booking_confirmed", "cancelled"],
  },
  {
    slug: "booking_confirmed",
    kind: "lead",
    displayName: "Бронирование подтверждено",
    next: ["payment_pending", "cancelled"],
  },
  {
    slug: "payment_pending",
    kind: "lead",
    displayName: "Ожидание оплаты/депозита",
    next: ["active_rental", "cancelled"],
  },
  {
    slug: "active_rental",
    kind: "lead",
    displayName: "Аренда активна",
    next: ["returned", "cancelled"],
  },
  {
    slug: "returned",
    kind: "terminal",
    displayName: "Байк возвращён",
  },
  {
    slug: "cancelled",
    kind: "terminal",
    displayName: "Отмена",
  },
];
