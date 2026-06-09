export type MarketplaceHandoffMode = "fire_and_forget" | "await_callback";

export interface ProviderMarketplaceProvider {
	key: string;
	category: string;
	name: string;
	description: string;
	coverage: string;
	sla: string;
	pricingMode: string;
	commissionPct: number;
	commissionHint: string;
	requiredFields: string[];
	defaultServiceName: string;
	serviceSlug: string;
	handoffMode: MarketplaceHandoffMode;
}

export const MARKETPLACE_SOURCE = "provider_marketplace";
export const MARKETPLACE_CUSTOM_SOURCE = "provider_marketplace_custom";

export const PROVIDER_MARKETPLACE: ProviderMarketplaceProvider[] = [
	{
		key: "phuket_transfer_network",
		category: "Трансфер",
		name: "Phuket Transfer Network",
		description:
			"Аэропорт, межгород, минивэны, VIP pickup и короткие поездки по острову.",
		coverage: "Phuket, Krabi, Samui",
		sla: "подтверждение до 7 мин",
		pricingMode: "fixed route / custom quote",
		commissionPct: 10,
		commissionHint: "10% с закрытого трансфера",
		requiredFields: ["route", "pickup_time", "passengers", "luggage"],
		defaultServiceName: "Трансфер и водитель",
		serviceSlug: "transfer_provider",
		handoffMode: "await_callback",
	},
	{
		key: "island_cleaning_crew",
		category: "Уборка",
		name: "Island Cleaning Crew",
		description:
			"Checkout cleaning, поддерживающая уборка, laundry и срочный клининг объектов.",
		coverage: "Phuket south / central",
		sla: "бригада до 15 мин",
		pricingMode: "scope-based quote",
		commissionPct: 12,
		commissionHint: "12% с заказа",
		requiredFields: ["address", "scope", "date", "access"],
		defaultServiceName: "Уборка и laundry",
		serviceSlug: "cleaning_provider",
		handoffMode: "await_callback",
	},
	{
		key: "spa_mobile_masters",
		category: "Массаж",
		name: "Spa Mobile Masters",
		description:
			"Выездной массаж в апартаменты: oil, deep tissue, thai, couples booking.",
		coverage: "Phuket west coast",
		sla: "мастер до 10 мин",
		pricingMode: "menu + travel fee",
		commissionPct: 15,
		commissionHint: "15% с записи",
		requiredFields: ["massage_type", "address", "slot", "duration"],
		defaultServiceName: "Массаж с выездом",
		serviceSlug: "massage_provider",
		handoffMode: "await_callback",
	},
	{
		key: "beauty_desk_phuket",
		category: "Салон красоты",
		name: "Beauty Desk Phuket",
		description:
			"Hair, nails, makeup, brows и подбор мастера под слот клиента.",
		coverage: "Patong, Kata, Bang Tao",
		sla: "слот до 12 мин",
		pricingMode: "service menu / specialist quote",
		commissionPct: 14,
		commissionHint: "14% с подтверждённой записи",
		requiredFields: ["service", "preferred_slot", "specialist", "notes"],
		defaultServiceName: "Beauty salon booking",
		serviceSlug: "beauty_provider",
		handoffMode: "await_callback",
	},
	{
		key: "staykey_housing",
		category: "Бронь жилья",
		name: "StayKey Housing Desk",
		description:
			"Виллы, апартаменты и short-term rental подбор с подтверждением условий брони.",
		coverage: "Phuket, Samui, Bangkok",
		sla: "3 варианта до 30 мин",
		pricingMode: "commission on booking",
		commissionPct: 8,
		commissionHint: "8% с бронирования",
		requiredFields: ["dates", "area", "bedrooms", "budget"],
		defaultServiceName: "Бронь жилья",
		serviceSlug: "housing_provider",
		handoffMode: "await_callback",
	},
	{
		key: "rate_desk_exchange",
		category: "Exchange",
		name: "Rate Desk Exchange",
		description:
			"Партнёрский rate desk для обмена, оплаты, реквизитов и крупных заявок.",
		coverage: "THB / USDT / cash desks",
		sla: "курс до 3 мин",
		pricingMode: "spread + fixed fee",
		commissionPct: 6,
		commissionHint: "6% от маржи",
		requiredFields: ["asset", "network", "amount", "payout"],
		defaultServiceName: "Exchange partner desk",
		serviceSlug: "exchange_provider",
		handoffMode: "fire_and_forget",
	},
];

export function findMarketplaceProvider(
	key: string,
): ProviderMarketplaceProvider | undefined {
	return PROVIDER_MARKETPLACE.find((provider) => provider.key === key);
}
