import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * FSM воронки консьерж-сервиса. Один общий intake (`request_received`)
 * ветвится по типу запроса (обмен / трансфер / еда / уборка / тур), каждая
 * ветка — короткий воркфлоу qualify → offer → fulfill, все ветки сходятся в
 * общие терминалы (completed / cancelled). Это одна валидная воронка костяка
 * (ровно один intake, монотонные фазы, один won + один lost) — не N воронок.
 *
 * Slugs совпадают с SEED_TEMPLATES["concierge"] в
 * apps/api/src/routes/admin-funnel.ts (два слоя одной воронки: здесь FSM,
 * там DB-определения стадий с полями).
 *
 * Ветку выбирает request_type лида (leads.request_type, migration 0032):
 *   request_received → {exchange|transfer|food|housekeeping|tour}_request →
 *   *_offer → *_fulfill → completed | cancelled.
 */
export const CONCIERGE_FUNNEL_STAGES: readonly FunnelStageDef[] = [
  {
    slug: "request_received",
    kind: "intake",
    displayName: "Запрос принят",
    next: [
      "exchange_request",
      "transfer_request",
      "food_request",
      "housekeeping_request",
      "tour_request",
      "cancelled",
    ],
  },

  // ── Обмен валюты ──
  {
    slug: "exchange_request",
    kind: "lead",
    displayName: "Обмен: детали",
    next: ["exchange_offer", "cancelled"],
  },
  {
    slug: "exchange_offer",
    kind: "lead",
    displayName: "Обмен: котировка",
    next: ["exchange_fulfill", "cancelled"],
  },
  {
    slug: "exchange_fulfill",
    kind: "lead",
    displayName: "Обмен: выдача",
    next: ["completed", "cancelled"],
  },

  // ── Трансфер ──
  {
    slug: "transfer_request",
    kind: "lead",
    displayName: "Трансфер: детали",
    next: ["transfer_offer", "cancelled"],
  },
  {
    slug: "transfer_offer",
    kind: "lead",
    displayName: "Трансфер: предложение",
    next: ["transfer_fulfill", "cancelled"],
  },
  {
    slug: "transfer_fulfill",
    kind: "lead",
    displayName: "Трансфер: подача",
    next: ["completed", "cancelled"],
  },

  // ── Еда ──
  {
    slug: "food_request",
    kind: "lead",
    displayName: "Еда: заказ",
    next: ["food_offer", "cancelled"],
  },
  {
    slug: "food_offer",
    kind: "lead",
    displayName: "Еда: подтверждение",
    next: ["food_fulfill", "cancelled"],
  },
  {
    slug: "food_fulfill",
    kind: "lead",
    displayName: "Еда: доставка",
    next: ["completed", "cancelled"],
  },

  // ── Уборка ──
  {
    slug: "housekeeping_request",
    kind: "lead",
    displayName: "Уборка: детали",
    next: ["housekeeping_offer", "cancelled"],
  },
  {
    slug: "housekeeping_offer",
    kind: "lead",
    displayName: "Уборка: подтверждение",
    next: ["housekeeping_fulfill", "cancelled"],
  },
  {
    slug: "housekeeping_fulfill",
    kind: "lead",
    displayName: "Уборка: выполнение",
    next: ["completed", "cancelled"],
  },

  // ── Экскурсия / тур ──
  {
    slug: "tour_request",
    kind: "lead",
    displayName: "Тур: детали",
    next: ["tour_offer", "cancelled"],
  },
  {
    slug: "tour_offer",
    kind: "lead",
    displayName: "Тур: предложение",
    next: ["tour_fulfill", "cancelled"],
  },
  {
    slug: "tour_fulfill",
    kind: "lead",
    displayName: "Тур: бронь",
    next: ["completed", "cancelled"],
  },

  // ── Общие терминалы ──
  { slug: "completed", kind: "terminal", displayName: "Выполнено" },
  { slug: "cancelled", kind: "terminal", displayName: "Отменено" },
];
