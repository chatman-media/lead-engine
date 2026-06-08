import type { QuestionnaireSchema } from "@chatman-media/verticals";

export const REAL_ESTATE_INTAKE: QuestionnaireSchema = {
	stageSlug: "qualification",
	introMessage:
		"Привет! Чтобы подобрать подходящие варианты, мне нужно несколько минут — " +
		"задам пару вопросов о ваших предпочтениях. Начнём?",
	completionMessage:
		"Отлично, анкета заполнена! Подбираю варианты под ваши параметры и скоро напишу.",
	fields: [
		{
			slug: "property_type",
			question: "Что рассматриваете в первую очередь — квартиру или дом/виллу?",
			kind: "enum",
			required: true,
			options: [
				"Квартира",
				"Дом / вилла",
				"Таунхаус",
				"Студия",
				"Пентхаус",
				"Коммерческая",
				"Оба варианта",
			],
			hint: "Первый квалификационный кубик: квартира или дом/вилла. Можно уточнить таунхаус, студию, пентхаус или коммерцию.",
		},
		{
			slug: "construction_status",
			question: "Нужен готовый объект или рассматриваете стройку / off-plan?",
			kind: "enum",
			required: true,
			options: ["Готовый объект", "В стройке / off-plan", "Оба варианта"],
			hint: "Второй квалификационный кубик: ready vs under construction/off-plan.",
		},
		{
			slug: "residency_goal",
			question: "Цель покупки — для себя, сдачи в аренду/инвестиции или ВНЖ?",
			kind: "enum",
			required: true,
			options: [
				"Для себя",
				"Инвестиция / аренда",
				"Для получения визы резидента",
			],
			hint: "own_use, investment/rental yield, или получение UAE resident visa.",
		},
		{
			slug: "bedrooms",
			question: "Сколько спален нужно?",
			kind: "enum",
			required: false,
			options: ["Студия", "1", "2", "3", "4+"],
			hint: "Количество спален или «студия».",
		},
		{
			slug: "locations",
			question:
				"Какие районы рассматриваете? (Downtown, Marina, Palm, JVC, Business Bay...)",
			kind: "text",
			required: false,
			hint: "Предпочтительные районы Дубая. Может быть несколько.",
		},
		{
			slug: "budget_usd",
			question: "Какой ориентировочный бюджет на покупку? (в USD или AED)",
			kind: "number",
			required: true,
			hint: "Общий бюджет покупателя в USD. Если указан в AED — перевести (1 USD ≈ 3.67 AED).",
		},
		{
			slug: "payment_method",
			question:
				"Как планируете оплачивать — наличными, ипотека или рассрочка от застройщика?",
			kind: "enum",
			required: true,
			options: ["Наличные", "Ипотека", "Рассрочка от застройщика"],
			hint: "Способ оплаты: cash, mortgage или installment plan.",
		},
		{
			slug: "market_type",
			question:
				"Интересует первичная (от застройщика) или вторичная недвижимость (resale)?",
			kind: "enum",
			required: false,
			options: [
				"Первичная (от застройщика)",
				"Вторичная (resale)",
				"Оба варианта",
			],
			hint: "primary — новостройка, secondary — вторичный рынок.",
		},
		{
			slug: "ownership_preference",
			question:
				"Есть предпочтение по форме владения — freehold, leasehold или без разницы?",
			kind: "enum",
			required: false,
			options: ["Freehold", "Leasehold", "Без разницы / нужна консультация"],
			hint: "Предпочтение по форме владения, если клиент уже понимает разницу.",
		},
		{
			slug: "meeting_format",
			question:
				"Вы сейчас на месте и готовы к просмотру или удобнее онлайн-созвон/видеотур?",
			kind: "enum",
			required: false,
			options: [
				"Офлайн просмотр",
				"Онлайн созвон / видеотур",
				"Пока переписка",
			],
			hint: "Разделяет маршрут: офлайн-встреча/показ или онлайн-продажа.",
		},
		{
			slug: "contact_name",
			question: "Как вас зовут?",
			kind: "text",
			required: true,
			hint: "Имя покупателя.",
		},
		{
			slug: "contact_phone",
			question: "Укажите номер телефона для связи.",
			kind: "phone",
			required: true,
			hint: "Телефон для связи с брокером.",
		},
	],
};
