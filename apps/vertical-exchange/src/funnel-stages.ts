import type { FunnelStageDef } from "@chatman-media/verticals";

/**
 * FSM воронки обменного пункта. Slugs совпадают с SEED_TEMPLATES["exchange"]
 * в apps/api/src/routes/admin-funnel.ts — это два слоя одной воронки:
 * здесь машина состояний (валидируется conversation-engine'ом), там —
 * DB-определения стадий с полями.
 *
 * Реальный воркфлоу:
 *   exchange_request → quote_calculated →
 *   verification_check → [kyc_collection?] → risk_review → order_created →
 *   requisites_sent → payment_proof_waiting → payment_verified →
 *   payout_or_completion | cancelled.
 *
 * kyc_collection — ОПЦИОНАЛЬНАЯ стадия (верификация по желанию клиента,
 * видео-кружок → оператор). Поэтому из rate_confirmation разрешён переход
 * как в kyc_collection, так и сразу в awaiting_payment.
 *
 * payout_or_completion — выдача: офис, cardless ATM, курьер или перевод на
 * тайский банк. Код/подтверждение приходит от провайдера/оператора — бот его
 * не выдумывает.
 */
export const EXCHANGE_FUNNEL_STAGES: readonly FunnelStageDef[] = [
	{
		slug: "exchange_request",
		kind: "intake",
		displayName: "Параметры обмена",
		next: ["quote_calculated", "cancelled"],
	},
	{
		slug: "quote_calculated",
		kind: "lead",
		displayName: "Курс рассчитан",
		next: ["verification_check", "cancelled"],
	},
	{
		slug: "verification_check",
		kind: "lead",
		displayName: "Проверка верификации",
		next: ["kyc_collection", "risk_review", "cancelled"],
	},
	{
		slug: "kyc_collection",
		kind: "lead",
		displayName: "Сбор документов (KYC)",
		next: ["risk_review", "cancelled"],
	},
	{
		slug: "risk_review",
		kind: "lead",
		displayName: "Проверка риска",
		next: ["order_created", "cancelled"],
	},
	{
		slug: "order_created",
		kind: "lead",
		displayName: "Заявка создана",
		next: ["requisites_sent", "cancelled"],
	},
	{
		slug: "requisites_sent",
		kind: "lead",
		displayName: "Реквизиты отправлены",
		next: ["payment_proof_waiting", "cancelled"],
	},
	{
		slug: "payment_proof_waiting",
		kind: "lead",
		displayName: "Ожидание оплаты",
		next: ["payment_verified", "cancelled"],
	},
	{
		slug: "payment_verified",
		kind: "lead",
		displayName: "Оплата подтверждена",
		next: ["payout_or_completion", "cancelled"],
	},
	{
		slug: "payout_or_completion",
		kind: "terminal",
		displayName: "Выдача / Завершено",
	},
	{ slug: "cancelled", kind: "terminal", displayName: "Отменено" },
];
