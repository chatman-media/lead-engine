import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * FSM воронки обменного пункта. Slugs совпадают с SEED_TEMPLATES["exchange"]
 * в apps/api/src/routes/admin-funnel.ts — это два слоя одной воронки:
 * здесь машина состояний (валидируется conversation-engine'ом), там —
 * DB-определения стадий с полями.
 *
 * quote_request (intake) → rate_confirmation → kyc_collection →
 * awaiting_payment → qr_delivery → completed (won) | cancelled (lost).
 */
export const EXCHANGE_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "quote_request",
    kind: "intake",
    displayName: "Запрос обмена",
    next: ["rate_confirmation", "cancelled"],
  },
  {
    slug: "rate_confirmation",
    kind: "lead",
    displayName: "Подтверждение курса",
    next: ["kyc_collection", "cancelled"],
  },
  {
    slug: "kyc_collection",
    kind: "lead",
    displayName: "KYC / документы",
    next: ["awaiting_payment", "cancelled"],
  },
  {
    slug: "awaiting_payment",
    kind: "lead",
    displayName: "Ожидание оплаты",
    next: ["qr_delivery", "cancelled"],
  },
  {
    slug: "qr_delivery",
    kind: "lead",
    displayName: "Выдача QR",
    next: ["completed", "cancelled"],
  },
  { slug: "completed", kind: "terminal", displayName: "Сделка закрыта" },
  { slug: "cancelled", kind: "terminal", displayName: "Отменено" },
];
