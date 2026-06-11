import { QUOTE_CURRENCY, type QuestionnaireSchema } from "@chatman-media/verticals";

/**
 * Анкета первичного запроса обмена. Каталог/выбор услуги живёт уровнем выше;
 * внутри exchange_v1 клиент уже пришёл за обменом, поэтому сразу собираем
 * параметры сделки.
 */
export const EXCHANGE_INTAKE: QuestionnaireSchema = {
	stageSlug: "exchange_request",
	introMessage: `Здравствуйте! Я менеджер обменного пункта. Подскажите, что меняете, сумму и как хотите получить ${QUOTE_CURRENCY.code}.`,
	completionMessage: "Понял параметры обмена. Сейчас рассчитаю курс и сумму к получению.",
	fields: [
		{
			slug: "asset_from",
			question: "Что отдаёте: USDT, BTC, ETH, RUB или другую валюту?",
			kind: "enum",
			required: true,
			options: ["USDT", "BTC", "ETH", "RUB", "EUR", "USD"],
			hint: "Актив или валюта, которую клиент отдаёт.",
		},
		{
			slug: "network",
			question: "Если это крипта, в какой сети будете отправлять? Для USDT принимаем TRC20.",
			kind: "enum",
			required: false,
			options: ["TRC20", "ERC20", "BEP20"],
			hint: "Сеть нужна для криптовалюты, особенно для USDT.",
		},
		{
			slug: "amount_from",
			question: "Какую сумму хотите обменять?",
			kind: "number",
			required: true,
			hint: "Сумма в активе-источнике, например 335 USDT или 150000 RUB.",
		},
		{
			slug: "payout_method",
			question: `Как хотите получить ${QUOTE_CURRENCY.tabloWord.toLowerCase()}: наличными в офисе, через банкомат или переводом на ${QUOTE_CURRENCY.bankLabel}?`,
			kind: "enum",
			required: false,
			options: ["Офис", "Банкомат", "Банковский перевод", "Курьер"],
			hint: `Предпочтительный способ выдачи ${QUOTE_CURRENCY.code}.`,
		},
	],
};
