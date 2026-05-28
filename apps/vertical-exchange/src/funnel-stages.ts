import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * FSM воронки обменного пункта. Slugs совпадают с SEED_TEMPLATES["exchange"]
 * в apps/api/src/routes/admin-funnel.ts — это два слоя одной воронки:
 * здесь машина состояний (валидируется conversation-engine'ом), там —
 * DB-определения стадий с полями.
 *
 * Реальный воркфлоу (по образцу ARBI Exchange):
 *   quote_request (intake) → rate_confirmation → [kyc_collection?] →
 *   awaiting_payment → payout → completed (won) | cancelled (lost).
 *
 * kyc_collection — ОПЦИОНАЛЬНАЯ стадия (верификация по желанию клиента,
 * видео-кружок → оператор). Поэтому из rate_confirmation разрешён переход
 * как в kyc_collection, так и сразу в awaiting_payment.
 *
 * payout — выдача: код для получения в офисе (Amount + Code) или cardless
 * код для снятия в банкомате (телефон + код). Код приходит от провайдера/
 * оператора — бот его не выдумывает.
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
    // KYC опционален → разрешаем сразу в awaiting_payment.
    next: ["kyc_collection", "awaiting_payment", "cancelled"],
  },
  {
    slug: "kyc_collection",
    kind: "lead",
    displayName: "Верификация (опц.)",
    next: ["awaiting_payment", "cancelled"],
  },
  {
    slug: "awaiting_payment",
    kind: "lead",
    displayName: "Ожидание оплаты",
    next: ["payout", "cancelled"],
  },
  {
    slug: "payout",
    kind: "lead",
    displayName: "Выдача",
    next: ["completed", "cancelled"],
  },
  { slug: "completed", kind: "terminal", displayName: "Сделка закрыта" },
  { slug: "cancelled", kind: "terminal", displayName: "Отменено" },
];
