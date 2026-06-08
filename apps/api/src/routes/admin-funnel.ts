import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
	experiments,
	funnels,
	leadEvents,
	leads,
	skills,
	stageDefinitions,
	stageFields,
	styles,
} from "@chatman-media/storage";
import {
	type ActivePhase,
	buildSkeletonFunnel,
	deriveDefaultPhase,
	effectivePhase,
	FUNNEL_PHASES,
	type FunnelPhase,
} from "@chatman-media/verticals";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { SKILLS_CATALOGUE } from "../lib/skills-catalogue.ts";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

// ── Seed templates ──────────────────────────────────────────────────────────

type SeedStage = {
	slug: string;
	displayName: string;
	kind: "intake" | "active" | "terminal_won" | "terminal_lost";
	stageType: string;
	/** Макро-фаза костяка — только для active; intake/terminal не задаются. */
	phase?: ActivePhase;
	position: number;
	color?: string;
	staleTimeoutDays?: number;
	checkinIntervalDays?: number;
	supportMode?: boolean;
	nextStages: string[];
	autoAdvanceCondition?: string;
	goal?: string;
	guidance?: string;
	fields: Array<{
		slug: string;
		displayName: string;
		fieldType: string;
		required: boolean;
		aiExtractable: boolean;
		hint?: string;
		optionsJson?: string;
		position: number;
	}>;
};

// Цели/инструкции для стадий универсального скелета (бот читает их пер-стадийно).
const SKELETON_GG: Record<string, { goal: string; guidance: string }> = {
	new: {
		goal: "Поприветствовать клиента и понять суть его запроса.",
		guidance:
			"Тепло начните диалог, выясните, что нужно клиенту, и зафиксируйте контакт. Задавайте по одному вопросу, не перегружайте.",
	},
	qualify: {
		goal: "Понять потребность, бюджет и готовность клиента двигаться дальше.",
		guidance:
			"Уточните детали запроса и ключевые ограничения (бюджет, сроки), задавая вопросы по одному. Слушайте и не предлагайте решение раньше времени.",
	},
	offer: {
		goal: "Сделать релевантное предложение и получить реакцию клиента.",
		guidance:
			"Сформулируйте предложение под выявленную потребность, объясните ценность, а не только цену. Дождитесь обратной связи и будьте готовы ответить на вопросы.",
	},
	clear: {
		goal: "Снять возражения и согласовать условия перед выполнением.",
		guidance:
			"Выслушайте сомнения, ответьте по существу и зафиксируйте договорённости. Держите конструктивный тон, ведите к чёткому решению.",
	},
	fulfill: {
		goal: "Довести договорённость до выполнения и подтвердить результат клиенту.",
		guidance:
			"Сопроводите клиента на этапе выполнения, держите в курсе статуса и подтвердите, что всё сделано. Будьте на связи на случай вопросов.",
	},
};

export const SEED_TEMPLATES: Record<string, SeedStage[]> = {
	// Универсальный скелет костяка — стартовая воронка для новой вертикали.
	// 6 фаз (capture→qualify→offer→clear→fulfill→won/lost), поверх — кастомизация.
	skeleton: buildSkeletonFunnel({
		includeClear: true,
		includeFulfill: true,
	}).map((s) => ({ ...s, fields: [], ...(SKELETON_GG[s.slug] ?? {}) })),
	// Консьерж-сервис (вилла): один общий intake ветвится по типу запроса
	// (обмен / трансфер / еда / уборка / тур), каждая ветка — короткий qualify → offer → fulfill,
	// все сходятся в общие completed / cancelled. Одна валидная воронка костяка
	// (1 intake, монотонные фазы, 1 won + 1 lost). Slugs совпадают с
	// CONCIERGE_FUNNEL_STAGES в @chatman-media/vertical-concierge. Ветку лида
	// помечает leads.request_type (migration 0032).
	concierge: [
		{
			slug: "request_received",
			displayName: "Запрос принят",
			goal: "Понять, какая услуга нужна гостю, и определить ветку запроса.",
			guidance:
				"Тепло поприветствуйте гостя, уточните тип запроса (обмен, трансфер, еда, уборка, экскурсия) и коротко зафиксируйте суть просьбы. Не углубляйтесь в детали — сначала определите категорию.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: [
				"exchange_request",
				"transfer_request",
				"food_request",
				"housekeeping_request",
				"tour_request",
				"cancelled",
			],
			// Авто-advance по заполнению request_type; branch-aware выбор ветки —
			// в field-extractor.selectNextStage (а не nextStages[0]).
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "request_type",
					displayName: "Тип запроса",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					hint: "Обмен / Трансфер / Еда / Уборка / Экскурсия / Другое — выбирает ветку воронки",
					position: 0,
					optionsJson:
						'[{"value":"exchange","label":"Обмен"},{"value":"transfer","label":"Трансфер"},{"value":"food","label":"Еда"},{"value":"housekeeping","label":"Уборка"},{"value":"tour","label":"Экскурсия"},{"value":"other","label":"Другое"}]',
				},
				{
					slug: "summary",
					displayName: "Описание",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},

		// ── qualify: детали запроса по типу ──
		{
			slug: "exchange_request",
			phase: "qualify",
			displayName: "Обмен: детали",
			kind: "active",
			goal: "Собрать валюту и сумму, которую гость хочет обменять.",
			guidance:
				"Спокойно уточните, что и в каком объёме меняем (например, USDT или RUB и сумму). Не называйте курс и не обещайте условия — это определит оператор на следующем шаге.",
			stageType: "form_fill",
			position: 1,
			color: "#6366f1",
			nextStages: ["exchange_offer", "cancelled"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "asset_from",
					displayName: "Что меняем",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "Напр. USDT, RUB",
					position: 0,
				},
				{
					slug: "amount_from",
					displayName: "Сумма",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "transfer_request",
			phase: "qualify",
			displayName: "Трансфер: детали",
			kind: "active",
			goal: "Собрать маршрут трансфера: откуда, куда и при необходимости время и число пассажиров.",
			guidance:
				"Уточните точки подачи и назначения, по возможности время и количество пассажиров. Задавайте вопросы по одному, не перегружая гостя; цену пока не озвучивайте.",
			stageType: "form_fill",
			position: 2,
			color: "#6366f1",
			nextStages: ["transfer_offer", "cancelled"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "pickup",
					displayName: "Откуда",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "dropoff",
					displayName: "Куда",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "when",
					displayName: "Когда",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 2,
				},
				{
					slug: "pax",
					displayName: "Пассажиров",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 3,
				},
			],
		},
		{
			slug: "food_request",
			phase: "qualify",
			displayName: "Еда: заказ",
			kind: "active",
			goal: "Зафиксировать состав заказа еды и адрес доставки.",
			guidance:
				"Уточните, что именно заказать и куда доставить. Переспросите детали блюд, если формулировка нечёткая; сумму и время назовёте после подтверждения оператором.",
			stageType: "form_fill",
			position: 3,
			color: "#6366f1",
			nextStages: ["food_offer", "cancelled"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "items",
					displayName: "Что заказать",
					fieldType: "textarea",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "deliver_to",
					displayName: "Куда доставить",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},

		{
			slug: "housekeeping_request",
			phase: "qualify",
			displayName: "Уборка: детали",
			kind: "active",
			goal: "Понять, какая услуга по уборке нужна и когда.",
			guidance:
				"Уточните тип услуги (уборка, смена белья и т.п.) и удобное время. Будьте кратки и вежливы, не навязывайте дополнительные услуги.",
			stageType: "form_fill",
			position: 4,
			color: "#6366f1",
			nextStages: ["housekeeping_offer", "cancelled"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "service",
					displayName: "Что нужно",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "Уборка / смена белья / др.",
					position: 0,
				},
				{
					slug: "when",
					displayName: "Когда",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "tour_request",
			phase: "qualify",
			displayName: "Тур: детали",
			kind: "active",
			goal: "Собрать пожелания по экскурсии: направление, дату и число участников.",
			guidance:
				"Уточните, куда хочет поехать гость, желаемую дату и количество человек. Проявите интерес к пожеланиям, но цену и программу не выдумывайте — они придут от оператора.",
			stageType: "form_fill",
			position: 5,
			color: "#6366f1",
			nextStages: ["tour_offer", "cancelled"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "destination",
					displayName: "Куда / что",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "date",
					displayName: "Дата",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "pax",
					displayName: "Человек",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 2,
				},
			],
		},

		// ── offer: условия (цена/курс) — НЕ выдумываются, приходят от tools/оператора ──
		{
			slug: "exchange_offer",
			phase: "offer",
			displayName: "Обмен: котировка",
			kind: "active",
			goal: "Передать гостю курс от оператора и получить подтверждение обмена.",
			guidance:
				"Озвучьте курс и сумму к выдаче ровно так, как их дал оператор, ничего не меняя. Дождитесь явного согласия гостя и не торгуйтесь по курсу.",
			stageType: "awaiting_operator",
			position: 6,
			color: "#f59e0b",
			nextStages: ["exchange_fulfill", "cancelled"],
			fields: [
				{
					slug: "quote",
					displayName: "Курс / сумма к выдаче",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "confirmed",
					displayName: "Гость подтвердил",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "transfer_offer",
			phase: "offer",
			displayName: "Трансфер: предложение",
			kind: "active",
			goal: "Сообщить цену и класс авто и получить подтверждение брони трансфера.",
			guidance:
				"Передайте цену и класс автомобиля от оператора, ответьте на вопросы по поездке. Дождитесь чёткого «да» от гостя перед бронированием; цену не придумывайте.",
			stageType: "awaiting_operator",
			position: 7,
			color: "#f59e0b",
			nextStages: ["transfer_fulfill", "cancelled"],
			fields: [
				{
					slug: "price",
					displayName: "Цена",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "vehicle",
					displayName: "Класс авто",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "confirmed",
					displayName: "Гость подтвердил",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 2,
				},
			],
		},
		{
			slug: "food_offer",
			phase: "offer",
			displayName: "Еда: подтверждение",
			kind: "active",
			goal: "Подтвердить сумму и время доставки заказа и получить согласие гостя.",
			guidance:
				"Озвучьте итоговую сумму и время доставки, как их указал оператор. Дождитесь подтверждения заказа; не обещайте сроки, которых нет в данных.",
			stageType: "awaiting_operator",
			position: 8,
			color: "#f59e0b",
			nextStages: ["food_fulfill", "cancelled"],
			fields: [
				{
					slug: "total",
					displayName: "Сумма",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "eta",
					displayName: "Время доставки",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "confirmed",
					displayName: "Гость подтвердил",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 2,
				},
			],
		},
		{
			slug: "housekeeping_offer",
			phase: "offer",
			displayName: "Уборка: подтверждение",
			kind: "active",
			goal: "Согласовать условия уборки и получить подтверждение гостя.",
			guidance:
				"Подтвердите услугу и, если есть, цену от оператора. Уточните удобное время и дождитесь согласия; будьте ненавязчивы.",
			stageType: "awaiting_operator",
			position: 9,
			color: "#f59e0b",
			nextStages: ["housekeeping_fulfill", "cancelled"],
			fields: [
				{
					slug: "price",
					displayName: "Цена",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "confirmed",
					displayName: "Гость подтвердил",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "tour_offer",
			phase: "offer",
			displayName: "Тур: предложение",
			kind: "active",
			goal: "Сообщить цену экскурсии и получить подтверждение брони.",
			guidance:
				"Передайте цену и условия тура от оператора, ответьте на вопросы о программе. Дождитесь явного согласия гостя; стоимость не выдумывайте.",
			stageType: "awaiting_operator",
			position: 10,
			color: "#f59e0b",
			nextStages: ["tour_fulfill", "cancelled"],
			fields: [
				{
					slug: "price",
					displayName: "Цена",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "confirmed",
					displayName: "Гость подтвердил",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 1,
				},
			],
		},

		// ── fulfill: исполнение ──
		{
			slug: "exchange_fulfill",
			phase: "fulfill",
			displayName: "Обмен: выдача",
			kind: "active",
			goal: "Согласовать способ выдачи и довести обмен до завершения.",
			guidance:
				"Уточните удобный способ получения средств (офис, банкомат или доставка) и сопроводите гостя до завершения сделки. Чётко проговорите следующий шаг.",
			stageType: "milestone",
			position: 11,
			color: "#06b6d4",
			nextStages: ["completed", "cancelled"],
			fields: [
				{
					slug: "handover_method",
					displayName: "Способ выдачи",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 0,
					optionsJson:
						'[{"value":"office","label":"Офис"},{"value":"atm","label":"Банкомат"},{"value":"delivery","label":"Доставка"}]',
				},
			],
		},
		{
			slug: "transfer_fulfill",
			phase: "fulfill",
			displayName: "Трансфер: подача",
			kind: "active",
			goal: "Подтвердить назначение водителя и подачу авто к месту.",
			guidance:
				"Сообщите гостю, что водитель назначен, и держите его в курсе подачи машины. Отвечайте оперативно, если гость уточняет статус.",
			stageType: "milestone",
			position: 12,
			color: "#06b6d4",
			nextStages: ["completed", "cancelled"],
			fields: [
				{
					slug: "driver_assigned",
					displayName: "Водитель назначен",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
		{
			slug: "food_fulfill",
			phase: "fulfill",
			displayName: "Еда: доставка",
			kind: "active",
			goal: "Довести доставку заказа до гостя и подтвердить получение.",
			guidance:
				"Сопроводите гостя до момента доставки и убедитесь, что заказ получен. Будьте на связи на случай вопросов по доставке.",
			stageType: "milestone",
			position: 13,
			color: "#06b6d4",
			nextStages: ["completed", "cancelled"],
			fields: [
				{
					slug: "delivered",
					displayName: "Доставлено",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
		{
			slug: "housekeeping_fulfill",
			phase: "fulfill",
			displayName: "Уборка: выполнение",
			kind: "active",
			goal: "Проследить выполнение уборки и подтвердить завершение услуги.",
			guidance:
				"Подтвердите, что услуга выполнена, и уточните, всё ли устроило гостя. Реагируйте вежливо, если потребуются доработки.",
			stageType: "milestone",
			position: 14,
			color: "#06b6d4",
			nextStages: ["completed", "cancelled"],
			fields: [
				{
					slug: "done",
					displayName: "Выполнено",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
		{
			slug: "tour_fulfill",
			phase: "fulfill",
			displayName: "Тур: бронь",
			kind: "active",
			goal: "Завершить бронирование экскурсии и подтвердить детали гостю.",
			guidance:
				"Подтвердите, что экскурсия забронирована, и проговорите ключевые детали (дата, место сбора). Пожелайте приятной поездки и оставайтесь на связи.",
			stageType: "milestone",
			position: 15,
			color: "#06b6d4",
			nextStages: ["completed", "cancelled"],
			fields: [
				{
					slug: "booked",
					displayName: "Забронировано",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},

		// ── Общие терминалы ──
		{
			slug: "completed",
			displayName: "Выполнено",
			kind: "terminal_won",
			stageType: "milestone",
			position: 16,
			color: "#10b981",
			nextStages: [],
			fields: [],
		},
		{
			slug: "cancelled",
			displayName: "Отменено",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 17,
			color: "#ef4444",
			nextStages: [],
			fields: [],
		},
	],
	// Обменный пункт (Пхукет): крипта / RUB-перевод / наличные → THB.
	// Slugs совпадают с EXCHANGE_FUNNEL_STAGES в @chatman-media/vertical-exchange.
	exchange: [
		{
			slug: "exchange_request",
			displayName: "Параметры обмена",
			goal: "Собрать параметры обмена: что отдаёт клиент, сумму, сеть для крипты и способ получения THB.",
			guidance:
				"Спокойно уточни актив-источник и сумму. Для USDT обязательно спроси сеть (принимаем TRC20). Узнай, как клиент хочет получить баты — наличными в офисе по коду или через банкомат без карты. Курс пока не называй.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["quote_calculated", "cancelled"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "asset_from",
					displayName: "Что отдаёт клиент",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					hint: "Актив-источник: крипта или рубли",
					position: 0,
					optionsJson:
						'[{"value":"usdt","label":"USDT"},{"value":"btc","label":"BTC"},{"value":"eth","label":"ETH"},{"value":"rub","label":"Рубли (RUB)"},{"value":"eur","label":"EUR"},{"value":"usd","label":"USD"}]',
				},
				{
					slug: "network",
					displayName: "Сеть (для крипты)",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					hint: "Обязательно для USDT, принимаем TRC20",
					position: 1,
					optionsJson:
						'[{"value":"trc20","label":"TRC20"},{"value":"erc20","label":"ERC20"},{"value":"bep20","label":"BEP20"}]',
				},
				{
					slug: "amount_from",
					displayName: "Сумма (в источнике)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					hint: "Например 335 для 335 USDT",
					position: 2,
				},
				{
					slug: "payout_method",
					displayName: "Способ получения THB",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					hint: "Офис (код) или банкомат (cardless)",
					position: 3,
					optionsJson:
						'[{"value":"office","label":"Офис (код)"},{"value":"atm","label":"Банкомат (cardless)"}]',
				},
			],
		},
		{
			slug: "quote_calculated",
			phase: "offer",
			displayName: "Курс рассчитан",
			goal: "Озвучить рассчитанный курс и итоговую сумму THB и получить явное подтверждение клиента.",
			guidance:
				"Назови ТОЛЬКО тот курс и сумму, которые вернул расчёт — никогда не придумывай и не округляй курс сам и не торгуйся. Чётко проговори, сколько клиент отдаёт и сколько получит на руки, и дождись согласия продолжить.",
			kind: "active",
			stageType: "rate_confirmation",
			position: 1,
			color: "#f59e0b",
			nextStages: ["verification_check", "cancelled"],
			fields: [
				{
					slug: "exchange_rate",
					displayName: "Актуальный курс",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "thb_amount",
					displayName: "Итоговая сумма THB",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "rate_confirmed",
					displayName: "Клиент подтвердил",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 2,
				},
			],
		},
		{
			slug: "verification_check",
			phase: "clear",
			displayName: "Проверка верификации",
			goal: "Определить, есть ли клиент в базе верифицированных, чтобы выбрать путь — сразу к риск-проверке или через KYC.",
			guidance:
				"Уточни, обменивался ли клиент у нас раньше, без давления и лишних подробностей о внутренней проверке. Если верификация не найдена — мягко объясни, что потребуется быстрый шаг с подтверждением личности.",
			kind: "active",
			stageType: "assessment",
			position: 2,
			color: "#8b5cf6",
			nextStages: ["kyc_collection", "risk_review", "cancelled"],
			fields: [
				{
					slug: "is_verified",
					displayName: "Верифицирован в базе",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "verification_crm_id",
					displayName: "ID в CRM верификации",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "kyc_collection",
			phase: "clear",
			displayName: "Сбор документов (KYC)",
			goal: "Получить от клиента видео-кружок для подтверждения личности и при необходимости имя по документам.",
			guidance:
				"Вежливо объясни, что для безопасности сделки нужен короткий видео-кружок, и подскажи, как его записать. Заверь, что это разовая процедура; не запрашивай лишних документов сверх необходимого.",
			kind: "active",
			stageType: "document_upload",
			position: 3,
			color: "#a855f7",
			nextStages: ["risk_review", "cancelled"],
			fields: [
				{
					slug: "verification_video",
					displayName: "Видео-кружок",
					fieldType: "video",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "customer_name_kyc",
					displayName: "Имя (по документам)",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "risk_review",
			phase: "clear",
			displayName: "Проверка риска",
			goal: "Дождаться решения по риск-проверке и провести клиента дальше к созданию заявки либо к оператору.",
			guidance:
				"Эта оценка внутренняя — не раскрывай клиенту скоринг и критерии. Если решение «нужен оператор», спокойно сообщи, что заявку досмотрит специалист; при отказе вежливо заверши без объяснения причин.",
			kind: "active",
			stageType: "assessment",
			position: 4,
			color: "#ef4444",
			nextStages: ["order_created", "cancelled"],
			fields: [
				{
					slug: "risk_score",
					displayName: "Risk Score",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "risk_decision",
					displayName: "Решение по риску",
					fieldType: "select",
					required: true,
					aiExtractable: false,
					position: 1,
					optionsJson:
						'[{"value":"pass","label":"Пропустить"},{"value":"manual","label":"Нужен оператор"},{"value":"reject","label":"Отказ"}]',
				},
			],
		},
		{
			slug: "order_created",
			phase: "fulfill",
			displayName: "Заявка создана",
			goal: "Подтвердить клиенту, что заявка зафиксирована, и подготовить его к получению реквизитов на оплату.",
			guidance:
				"Коротко сообщи, что заявка создана и сейчас придут реквизиты для перевода. Поддерживай уверенный тон; номер заявки формирует система — не выдумывай его.",
			kind: "active",
			stageType: "milestone",
			position: 5,
			color: "#0ea5e9",
			nextStages: ["requisites_sent", "cancelled"],
			fields: [
				{
					slug: "order_id_ref",
					displayName: "ID заявки в системе",
					fieldType: "text",
					required: true,
					aiExtractable: false,
					position: 0,
				},
			],
		},
		{
			slug: "requisites_sent",
			phase: "fulfill",
			displayName: "Реквизиты отправлены",
			goal: "Передать клиенту выданные системой реквизиты для оплаты и указать срок их действия.",
			guidance:
				"Отправь реквизиты ровно в том виде, как их выдал инструмент, — не меняй и не сочиняй адреса, карты или кошельки. Предупреди о сроке действия и попроси оплатить в его пределах одним платежом на точную сумму.",
			kind: "active",
			stageType: "external_approval",
			position: 6,
			color: "#06b6d4",
			nextStages: ["payment_proof_waiting", "cancelled"],
			fields: [
				{
					slug: "requisites_text",
					displayName: "Выданные реквизиты",
					fieldType: "textarea",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "requisites_ttl",
					displayName: "Срок действия (мин)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "payment_proof_waiting",
			phase: "fulfill",
			displayName: "Ожидание оплаты",
			goal: "Дождаться оплаты и получить от клиента пруф — хэш транзакции, ссылку или фото чека.",
			guidance:
				"Терпеливо дождись подтверждения оплаты и попроси приложить tx-хэш или чек. Не подтверждай зачисление на словах; при фиатном переводе или заминках предупреди, что зачисление может проверять оператор.",
			kind: "active",
			stageType: "payment",
			position: 7,
			color: "#34d399",
			staleTimeoutDays: 1,
			supportMode: true,
			nextStages: ["payment_verified", "cancelled"],
			fields: [
				{
					slug: "payment_proof_text",
					displayName: "Пруф (tx hash / ссылка)",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "payment_proof_image",
					displayName: "Чек (фото)",
					fieldType: "photo",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "payment_verified",
			phase: "fulfill",
			displayName: "Оплата подтверждена",
			goal: "Зафиксировать факт поступления оплаты и фактическую сумму перед выдачей THB.",
			guidance:
				"Сообщи клиенту, что оплата получена, и уточни банк-отправитель, если он не определился. Опирайся на фактически зачисленную сумму из проверки, а не на ожидаемую; не обещай выдачу до полного подтверждения.",
			kind: "active",
			stageType: "assessment",
			position: 8,
			color: "#10b981",
			nextStages: ["payout_or_completion", "cancelled"],
			fields: [
				{
					slug: "source_bank",
					displayName: "Банк-отправитель",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "matched_amount",
					displayName: "Сумма (факт)",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "payout_or_completion",
			displayName: "Выдача / Завершено",
			kind: "terminal_won",
			stageType: "milestone",
			position: 9,
			color: "#059669",
			nextStages: [],
			fields: [
				{
					slug: "final_thb_paid",
					displayName: "Выдано THB",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "payout_code_final",
					displayName: "Код выдачи",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "cancelled",
			displayName: "Отменено",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 10,
			color: "#6b7280",
			nextStages: [],
			fields: [
				{
					slug: "cancel_reason",
					displayName: "Причина",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 0,
					optionsJson:
						'[{"value":"rate","label":"Курс"},{"value":"no_payment","label":"Нет оплаты"},{"value":"kyc_fail","label":"Верификация"},{"value":"risk_reject","label":"Риск"},{"value":"other","label":"Другое"}]',
				},
			],
		},
	],
	visa: [
		{
			slug: "qualification",
			displayName: "Квалификация",
			goal: "Определить гражданство, тип визы и уровень английского, чтобы оценить применимый маршрут оформления.",
			guidance:
				"Спрашивайте по одному параметру: гражданство, тип визы (рабочая/туристическая/студенческая/воссоединение), опыт работы и уровень английского. Тон деловой и доброжелательный; объясняйте, зачем нужны данные, и не давайте обещаний о шансах одобрения.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["documents_collection"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "citizenship",
					displayName: "Гражданство",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "Страна гражданства",
					position: 0,
				},
				{
					slug: "visa_type",
					displayName: "Тип визы",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					hint: "Рабочая, туристическая, студенческая...",
					position: 1,
					optionsJson:
						'[{"value":"work","label":"Рабочая"},{"value":"tourist","label":"Туристическая"},{"value":"student","label":"Студенческая"},{"value":"family","label":"По воссоединению семьи"}]',
				},
				{
					slug: "experience_years",
					displayName: "Опыт работы (лет)",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 2,
				},
				{
					slug: "english_level",
					displayName: "Уровень английского",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 3,
					optionsJson:
						'[{"value":"a1","label":"A1 — Начальный"},{"value":"a2","label":"A2"},{"value":"b1","label":"B1 — Средний"},{"value":"b2","label":"B2"},{"value":"c1","label":"C1 — Продвинутый"},{"value":"c2","label":"C2"}]',
				},
			],
		},
		{
			slug: "documents_collection",
			displayName: "Сбор документов",
			goal: "Собрать корректный комплект документов: разворот паспорта, при наличии — диплом и историю трудоустройства.",
			guidance:
				"Дайте чёткий чек-лист и просите загрузить фото первого разворота паспорта читаемым, без бликов и обрезанных полей. Проверяйте полноту, мягко напоминайте о недостающем; не запрашивайте лишних данных и не комментируйте юридическую силу документов.",
			kind: "active",
			stageType: "document_upload",
			position: 1,
			color: "#f59e0b",
			nextStages: ["financial_verification"],
			fields: [
				{
					slug: "passport_photo",
					displayName: "Фото паспорта",
					fieldType: "photo",
					required: true,
					aiExtractable: true,
					hint: "Первый разворот паспорта",
					position: 0,
				},
				{
					slug: "diploma_uploaded",
					displayName: "Диплом загружен",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "employment_history",
					displayName: "История трудоустройства",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 2,
				},
			],
		},
		{
			slug: "financial_verification",
			displayName: "Финансовая проверка",
			goal: "Подтвердить финансовую состоятельность: получить выписку из банка и сумму доступных средств.",
			guidance:
				"Попросите загрузить актуальную банковскую выписку и указать сумму средств в USD, объяснив, что это требование для подтверждения платёжеспособности. Будьте тактичны в денежных вопросах; не называйте «достаточный» порог и не гарантируйте одобрение по финансам.",
			kind: "active",
			stageType: "external_approval",
			position: 2,
			color: "#8b5cf6",
			nextStages: ["application_submission"],
			fields: [
				{
					slug: "bank_statement_uploaded",
					displayName: "Выписка из банка загружена",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "funds_amount_usd",
					displayName: "Сумма средств (USD)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "application_submission",
			displayName: "Подача заявки",
			goal: "Зафиксировать факт подачи: дату, номер заявки и подтверждение оплаты консульского сбора.",
			guidance:
				"Уточните дату подачи и номер заявки, подтвердите оплату консульского сбора. Подчёркивайте важность точности реквизитов и сохранения квитанции; напоминайте о сроках, но не обещайте конкретный исход.",
			kind: "active",
			stageType: "form_fill",
			position: 3,
			color: "#ec4899",
			nextStages: ["processing"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "application_date",
					displayName: "Дата подачи",
					fieldType: "date",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "application_number",
					displayName: "Номер заявки",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "payment_confirmed",
					displayName: "Оплата консульского сбора подтверждена",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 2,
				},
			],
		},
		{
			slug: "processing",
			displayName: "Рассмотрение",
			goal: "Сопровождать ожидание решения и держать заявителя в курсе ожидаемых сроков.",
			guidance:
				"Сообщите ориентировочную дату решения и спокойно поясните, что рассмотрение может занять время. Поддерживайте и снижайте тревожность, фиксируйте новые сведения в заметках; не давите на консульство и не гарантируйте положительный результат.",
			kind: "active",
			stageType: "waiting",
			position: 4,
			color: "#6b7280",
			staleTimeoutDays: 90,
			nextStages: ["visa_issued", "rejected"],
			fields: [
				{
					slug: "expected_decision_date",
					displayName: "Ожидаемая дата решения",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "processing_notes",
					displayName: "Заметки по рассмотрению",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "visa_issued",
			displayName: "Виза выдана",
			kind: "terminal_won",
			stageType: "milestone",
			position: 5,
			color: "#10b981",
			nextStages: [],
			fields: [
				{
					slug: "visa_number",
					displayName: "Номер визы",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "visa_expiry",
					displayName: "Срок действия визы",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "rejected",
			displayName: "Отказ",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 6,
			color: "#ef4444",
			nextStages: [],
			fields: [
				{
					slug: "rejection_reason",
					displayName: "Причина отказа",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
	],

	real_estate: [
		{
			slug: "qualification",
			displayName: "Квалификация",
			goal: "Быстро установить контакт, назначить созвон/встречу и расклассифицировать клиента по типу объекта, готовности, цели, параметрам, срокам и бюджету.",
			guidance:
				"Ответьте на заявку в течение минуты; если клиент прочитал и не ответил — звоните через 5 минут. Каждое сообщение заканчивайте вопросом. Начинайте с простых развилок: квартира или дом/вилла, готовый объект или стройка/off-plan, для себя или под аренду/инвестицию. Затем уточните район, спальни, формат показа (офлайн/онлайн), сроки, бюджет и способ оплаты. Если клиент на месте, ведите к встрече альтернативным вопросом: первая половина дня или вторая. Не оценивайте клиента по внешнему виду, не давите и не обещайте условия без подтверждения.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["viewings"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "property_type",
					displayName: "Тип недвижимости",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 0,
					optionsJson:
						'[{"value":"apartment","label":"Квартира"},{"value":"house_villa","label":"Дом / вилла"},{"value":"townhouse","label":"Таунхаус"},{"value":"studio","label":"Студия"},{"value":"penthouse","label":"Пентхаус"},{"value":"commercial","label":"Коммерческая"},{"value":"both","label":"Оба варианта"}]',
				},
				{
					slug: "construction_status",
					displayName: "Готовность объекта",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 1,
					optionsJson:
						'[{"value":"ready","label":"Готовый объект"},{"value":"off_plan","label":"В стройке / off-plan"},{"value":"both","label":"Оба варианта"}]',
				},
				{
					slug: "residency_goal",
					displayName: "Цель покупки",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 2,
					optionsJson:
						'[{"value":"own_use","label":"Для себя"},{"value":"investment","label":"Инвестиция/аренда"},{"value":"visa","label":"Для получения визы резидента"}]',
				},
				{
					slug: "bedrooms",
					displayName: "Количество спален",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 3,
					optionsJson:
						'[{"value":"studio","label":"Студия"},{"value":"1","label":"1"},{"value":"2","label":"2"},{"value":"3","label":"3"},{"value":"4+","label":"4+"}]',
				},
				{
					slug: "locations",
					displayName: "Районы",
					fieldType: "multiselect",
					required: false,
					aiExtractable: true,
					position: 4,
					optionsJson:
						'[{"value":"downtown","label":"Downtown"},{"value":"marina","label":"Marina"},{"value":"jvc","label":"JVC"},{"value":"business_bay","label":"Business Bay"},{"value":"palm","label":"Palm"},{"value":"creek","label":"Creek"},{"value":"other","label":"Другой"}]',
				},
				{
					slug: "budget_usd",
					displayName: "Бюджет (USD)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					hint: "Общий бюджет на покупку",
					position: 5,
				},
				{
					slug: "payment_method",
					displayName: "Способ оплаты",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 6,
					optionsJson:
						'[{"value":"cash","label":"Наличные"},{"value":"mortgage","label":"Ипотека"},{"value":"installment","label":"Рассрочка от застройщика"}]',
				},
				{
					slug: "market_type",
					displayName: "Первичка или вторичка",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 7,
					optionsJson:
						'[{"value":"primary","label":"Первичная (от застройщика)"},{"value":"secondary","label":"Вторичная (resale)"},{"value":"both","label":"Оба варианта"}]',
				},
				{
					slug: "ownership_preference",
					displayName: "Форма владения",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 8,
					optionsJson:
						'[{"value":"freehold","label":"Freehold"},{"value":"leasehold","label":"Leasehold"},{"value":"unknown","label":"Нужна консультация"}]',
				},
				{
					slug: "meeting_format",
					displayName: "Формат показа",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 9,
					optionsJson:
						'[{"value":"offline","label":"Офлайн просмотр"},{"value":"online","label":"Онлайн созвон / видеотур"},{"value":"chat","label":"Пока переписка"}]',
				},
				{
					slug: "timeline_months",
					displayName: "Срок сделки (месяцев)",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 10,
				},
			],
		},
		{
			slug: "viewings",
			phase: "qualify",
			displayName: "Просмотры",
			goal: "Отправить релевантную подборку объектов, организовать просмотры и довести клиента до выбора конкретного объекта.",
			guidance:
				"Предлагайте маршрут из 2-3 объектов под квалификацию: тип объекта, готовность/стройка, цель, бюджет и локация. Для офлайн-клиента назначайте встречу выбором без выбора (первая/вторая половина дня), для онлайн-клиента ведите в Zoom/видеотур. После каждого объекта собирайте обратную связь и сужайте короткий список. Не придумывайте характеристики и цены вне KB.",
			kind: "active",
			stageType: "interaction",
			position: 1,
			color: "#8b5cf6",
			staleTimeoutDays: 21,
			checkinIntervalDays: 7,
			nextStages: ["offer_negotiation", "deal_lost"],
			fields: [
				{
					slug: "properties_sent",
					displayName: "Подборок отправлено",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "viewings_count",
					displayName: "Просмотров проведено",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "shortlisted_ref",
					displayName: "Выбранный объект (ссылка/референс)",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "shortlisted_price_usd",
					displayName: "Цена выбранного объекта (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 3,
				},
				{
					slug: "viewing_notes",
					displayName: "Заметки по просмотрам",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 4,
				},
			],
		},
		{
			slug: "offer_negotiation",
			phase: "offer",
			displayName: "Оффер и переговоры",
			goal: "Согласовать цену между покупателем и продавцом и зафиксировать договорённость для подписания MOU.",
			guidance:
				"Помогите клиенту сформировать обоснованное предложение, опираясь на рыночные цены и состояние объекта, и аккуратно ведите торг с продавцом. Если объект нравится, предлагайте следующий шаг: бронь/booking fee, просмотр с застройщиком или подготовка договора. Если клиент не готов к брони — выясните конкретную причину: цена, сроки, ликвидность, платежный график или доверие. Не обещайте того, что не подтверждено продавцом/застройщиком.",
			kind: "active",
			stageType: "form_fill",
			position: 2,
			color: "#f59e0b",
			staleTimeoutDays: 14,
			nextStages: ["mou_signed", "deal_lost"],
			fields: [
				{
					slug: "asking_price_usd",
					displayName: "Цена продавца (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "offer_price_usd",
					displayName: "Предложение покупателя (USD)",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "agreed_price_usd",
					displayName: "Согласованная цена (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "reservation_amount_usd",
					displayName: "Бронь / booking fee (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 3,
				},
				{
					slug: "reservation_paid",
					displayName: "Бронь внесена",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 4,
				},
				{
					slug: "negotiation_notes",
					displayName: "Ход переговоров",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 5,
				},
			],
		},
		{
			slug: "mou_signed",
			phase: "offer",
			displayName: "MOU подписан (Form F)",
			goal: "Обеспечить подписание MOU (Form F) и оплату депозита (обычно 10%) с фиксацией даты завершения сделки.",
			guidance:
				"Разъясните условия Form F/MOU для resale или booking/SPA для primary/off-plan, размер и порядок оплаты депозита через защищённый счёт, согласуйте дату завершения сделки. Действуйте чётко и юридически корректно, напоминайте о сроках и просите загрузить подписанный документ; не давайте юридических гарантий вне своей компетенции.",
			kind: "active",
			stageType: "document_signature",
			position: 3,
			color: "#ec4899",
			staleTimeoutDays: 30,
			// NOC нужен для вторички; ипотека — для mortgage-покупателей; cash-покупатели могут идти сразу на transfer
			nextStages: [
				"noc_application",
				"mortgage_approval",
				"handover_support",
				"dld_transfer",
			],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "mou_date",
					displayName: "Дата подписания MOU",
					fieldType: "date",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "deposit_amount_usd",
					displayName: "Депозит (USD, обычно 10%)",
					fieldType: "number",
					required: true,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "deposit_paid",
					displayName: "Депозит оплачен",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "completion_deadline",
					displayName: "Дата завершения сделки",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 3,
				},
				{
					slug: "mou_document",
					displayName: "MOU / Form F (файл)",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					position: 4,
				},
			],
		},
		{
			slug: "noc_application",
			phase: "clear",
			displayName: "NOC от застройщика",
			goal: "Подать заявку и получить NOC (No Objection Certificate) от застройщика для вторичной сделки.",
			guidance:
				"Объясните клиенту назначение NOC и порядок его получения у застройщика, согласуйте подачу заявки и держите его в курсе статуса. Проактивно сопровождайте процесс, предупреждайте о возможных сроках и комиссиях застройщика, добивайтесь загрузки полученного сертификата.",
			kind: "active",
			stageType: "external_approval",
			position: 4,
			color: "#6366f1",
			staleTimeoutDays: 21,
			// Только для вторички; после получения NOC — к трансферу (или сначала ипотека)
			nextStages: ["mortgage_approval", "handover_support", "dld_transfer"],
			fields: [
				{
					slug: "developer_name",
					displayName: "Застройщик",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "noc_applied_date",
					displayName: "Дата подачи заявки на NOC",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "noc_received",
					displayName: "NOC получен",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "noc_document",
					displayName: "NOC (файл)",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					position: 3,
				},
			],
		},
		{
			slug: "mortgage_approval",
			phase: "clear",
			displayName: "Одобрение ипотеки",
			goal: "Довести ипотечного клиента до финального одобрения банком с подтверждённой суммой и условиями.",
			guidance:
				"Сопровождайте сбор документов для банка, уточняйте одобренную сумму, ставку и срок ипотеки, помогайте сравнить предложения банков. Будьте терпеливы и внимательны к финансовым деталям, напоминайте о дедлайнах одобрения и просите письмо об одобрении; не давайте финансовых советов вне компетенции.",
			kind: "active",
			stageType: "external_approval",
			position: 5,
			color: "#0ea5e9",
			staleTimeoutDays: 30,
			nextStages: ["handover_support", "dld_transfer"],
			fields: [
				{
					slug: "bank_name",
					displayName: "Банк",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "approved_amount_usd",
					displayName: "Одобренная сумма (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "interest_rate_pct",
					displayName: "Процентная ставка (%)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "mortgage_term_years",
					displayName: "Срок ипотеки (лет)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 3,
				},
				{
					slug: "approval_letter",
					displayName: "Письмо об одобрении (файл)",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					position: 4,
				},
			],
		},
		{
			slug: "handover_support",
			phase: "fulfill",
			displayName: "Платежи и приемка",
			goal: "Сопроводить клиента после брони/договора: платежи, отчёты по стройке, вопросы к застройщику и приемка объекта.",
			guidance:
				"После брони не оставляйте клиента одного. Объясните платежный график, создайте рабочий чат/канал по сделке, отвечайте на вопросы вместе с застройщиком/юристами, отправляйте подтверждённые отчёты по стройке и помогите принять объект. Цель этапа — удержать доверие, довести выплаты/приемку до результата и подготовить клиента к регистрации.",
			kind: "active",
			stageType: "milestone",
			position: 6,
			color: "#06b6d4",
			staleTimeoutDays: 60,
			checkinIntervalDays: 14,
			nextStages: ["dld_transfer", "deal_lost"],
			fields: [
				{
					slug: "payment_plan_status",
					displayName: "Статус платежного графика",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 0,
					optionsJson:
						'[{"value":"on_track","label":"По графику"},{"value":"at_risk","label":"Есть риск просрочки"},{"value":"completed","label":"Платежи завершены"}]',
				},
				{
					slug: "construction_updates_sent",
					displayName: "Отчеты по стройке отправлены",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "handover_completed",
					displayName: "Приемка завершена",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "handover_notes",
					displayName: "Заметки по сопровождению",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 3,
				},
			],
		},
		{
			slug: "dld_transfer",
			displayName: "Регистрация в DLD",
			kind: "terminal_won",
			stageType: "milestone",
			position: 7,
			color: "#10b981",
			nextStages: [],
			fields: [
				{
					slug: "transfer_date",
					displayName: "Дата трансфера",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "final_price_usd",
					displayName: "Итоговая цена (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "title_deed_number",
					displayName: "Номер Title Deed",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "dld_registration_number",
					displayName: "Регистрационный номер DLD",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 3,
				},
				{
					slug: "dld_fee_usd",
					displayName: "Комиссия DLD (USD, обычно 4%)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 4,
				},
			],
		},
		{
			slug: "deal_lost",
			displayName: "Сделка не состоялась",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 8,
			color: "#ef4444",
			nextStages: [],
			fields: [
				{
					slug: "loss_reason",
					displayName: "Причина",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 0,
					optionsJson:
						'[{"value":"budget","label":"Бюджет не сошёлся"},{"value":"competitor","label":"Выбрал другого агента"},{"value":"financing_failed","label":"Ипотека не одобрена"},{"value":"noc_rejected","label":"NOC отклонён"},{"value":"not_ready","label":"Не готов покупать"},{"value":"found_himself","label":"Нашёл сам"},{"value":"other","label":"Другое"}]',
				},
				{
					slug: "loss_notes",
					displayName: "Детали",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
	],

	modeling: [
		{
			slug: "intake",
			displayName: "Первичный контакт",
			goal: "Собрать базовую анкету модели: имя, возраст, рост, параметры и опыт.",
			guidance:
				"Общайтесь профессионально и дружелюбно, задавайте вопросы по одному и поясняйте, зачем нужны параметры. Если модели меньше 18 лет — обязательно уточните контакт родителя/законного представителя и не запрашивайте откровенных фото; не давайте обещаний о работе и не оценивайте внешность личными комментариями.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["portfolio_review"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "full_name",
					displayName: "Полное имя",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "age",
					displayName: "Возраст",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "height_cm",
					displayName: "Рост (см)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 2,
				},
				{
					slug: "bust_waist_hips",
					displayName: "Параметры (ОГ/ОТ/ОБ)",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					hint: "например: 88/60/90",
					position: 3,
				},
				{
					slug: "experience",
					displayName: "Опыт в модельной сфере",
					fieldType: "multiselect",
					required: false,
					aiExtractable: true,
					position: 4,
					optionsJson:
						'[{"value":"runway","label":"Подиум"},{"value":"commercial","label":"Коммерческая съёмка"},{"value":"editorial","label":"Editorial"},{"value":"acting","label":"Актёрское мастерство"},{"value":"none","label":"Нет опыта"}]',
				},
				{
					slug: "instagram_url",
					displayName: "Instagram / соцсети",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 5,
				},
			],
		},
		{
			slug: "portfolio_review",
			displayName: "Ревью портфолио",
			goal: "Получить качественное портфолио: 6–10 фото (headshot и в полный рост), при наличии комп-карту и видео-рилл.",
			guidance:
				"Понятно объясните, какие материалы и в каком формате прислать, и предложите помощь, если их пока нет. Просите только профессионально уместные снимки, никаких откровенных или приватных фото; для несовершеннолетних — съёмка только с согласия и в присутствии родителя.",
			kind: "active",
			stageType: "document_upload",
			position: 1,
			color: "#f59e0b",
			staleTimeoutDays: 14,
			nextStages: ["go_see"],
			fields: [
				{
					slug: "portfolio_photos",
					displayName: "Фото портфолио",
					fieldType: "file",
					required: true,
					aiExtractable: false,
					hint: "6–10 фото (headshot + full-length)",
					position: 0,
				},
				{
					slug: "comp_card",
					displayName: "Комп-карта",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "video_reel",
					displayName: "Видео-рилл",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					hint: "30–90 сек, свободное движение или подиум",
					position: 2,
				},
				{
					slug: "portfolio_notes",
					displayName: "Заметки по портфолио",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 3,
				},
			],
		},
		{
			slug: "go_see",
			displayName: "Go-See / Кастинг",
			goal: "Согласовать дату, локацию и детали go-see/кастинга и зафиксировать его результат.",
			guidance:
				"Чётко сообщите дату, адрес и что взять с собой, отвечайте на вопросы о клиенте и площадке. Сохраняйте профессиональный тон, не гарантируйте одобрение заранее; для несовершеннолетних — напомните о сопровождении взрослого.",
			kind: "active",
			stageType: "interaction",
			position: 2,
			color: "#8b5cf6",
			nextStages: ["contract", "not_suitable"],
			fields: [
				{
					slug: "go_see_date",
					displayName: "Дата кастинга",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "client_name",
					displayName: "Клиент / площадка",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "location",
					displayName: "Локация",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "casting_result",
					displayName: "Результат кастинга",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 3,
					optionsJson:
						'[{"value":"approved","label":"Одобрен"},{"value":"pending","label":"На рассмотрении"},{"value":"rejected","label":"Не подошёл"}]',
				},
				{
					slug: "casting_notes",
					displayName: "Заметки кастинг-директора",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 4,
				},
			],
		},
		{
			slug: "contract",
			displayName: "Заключение контракта",
			goal: "Довести модель до подписания контракта и зафиксировать дату и условия комиссии.",
			guidance:
				"Прозрачно объясните ключевые условия и размер комиссии агентства, ответьте на вопросы спокойно и без давления. Не торопите с подписанием, рекомендуйте внимательно прочитать документ; для несовершеннолетних договор оформляется через родителя/опекуна.",
			kind: "active",
			stageType: "document_signature",
			position: 3,
			color: "#ec4899",
			nextStages: ["active_representation"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "contract_signed",
					displayName: "Контракт подписан",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "contract_date",
					displayName: "Дата подписания",
					fieldType: "date",
					required: true,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "commission_pct",
					displayName: "Комиссия агентства (%)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 2,
				},
			],
		},
		{
			slug: "active_representation",
			displayName: "Активное представление",
			kind: "terminal_won",
			stageType: "milestone",
			position: 4,
			color: "#10b981",
			nextStages: [],
			fields: [
				{
					slug: "agency_profile_url",
					displayName: "Профиль на сайте агентства",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "contract_start_date",
					displayName: "Начало контракта",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "contract_end_date",
					displayName: "Конец контракта",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "day_rate_usd",
					displayName: "Дневная ставка (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 3,
				},
				{
					slug: "exclusive",
					displayName: "Эксклюзивный контракт",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 4,
				},
			],
		},
		{
			slug: "not_suitable",
			displayName: "Не подошёл",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 5,
			color: "#ef4444",
			nextStages: [],
			fields: [
				{
					slug: "rejection_notes",
					displayName: "Причина отказа",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
	],

	scooter: [
		{
			slug: "inquiry",
			displayName: "Запрос аренды",
			goal: "Выяснить тип байка, даты аренды, наличие прав и необходимость доставки.",
			guidance:
				"Задавайте вопросы по одному в дружелюбном тоне. ОБЯЗАТЕЛЬНО уточните наличие водительских прав — аренда без прав невозможна. Не давайте обещаний о наличии конкретного байка без проверки.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["booking_confirmed"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "bike_type",
					displayName: "Тип байка",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 0,
					optionsJson:
						'[{"value":"scooter_auto","label":"Скутер-автомат"},{"value":"scooter_manual","label":"Скутер-механика"},{"value":"motorbike_125","label":"Мотоцикл 125cc"},{"value":"motorbike_400","label":"Мотоцикл 400cc+"},{"value":"any","label":"Любой"}]',
				},
				{
					slug: "date_from",
					displayName: "Дата начала",
					fieldType: "date",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "date_to",
					displayName: "Дата окончания",
					fieldType: "date",
					required: true,
					aiExtractable: true,
					position: 2,
				},
				{
					slug: "has_license",
					displayName: "Водительские права",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					hint: "категория A или A1",
					position: 3,
				},
				{
					slug: "delivery_needed",
					displayName: "Нужна доставка",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					position: 4,
				},
				{
					slug: "delivery_address",
					displayName: "Адрес доставки",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 5,
				},
			],
		},
		{
			slug: "booking_confirmed",
			displayName: "Бронирование подтверждено",
			goal: "Подтвердить наличие байка и озвучить условия оплаты депозита.",
			guidance:
				"Сообщите стоимость аренды, размер депозита и способы оплаты. Напомните взять с собой паспорт и права при получении.",
			kind: "active",
			stageType: "interaction",
			position: 1,
			color: "#f59e0b",
			nextStages: ["payment_pending", "cancelled"],
			fields: [
				{
					slug: "daily_rate_thb",
					displayName: "Ставка в день (THB)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "deposit_thb",
					displayName: "Депозит (THB)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "bike_model",
					displayName: "Модель байка",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 2,
				},
			],
		},
		{
			slug: "payment_pending",
			displayName: "Ожидание оплаты",
			goal: "Получить депозит и подтвердить оплату.",
			guidance:
				"Предоставьте реквизиты для оплаты. При получении подтверждения — отправьте инструкции по получению байка.",
			kind: "active",
			stageType: "external_approval",
			position: 2,
			color: "#8b5cf6",
			nextStages: ["active_rental", "cancelled"],
			fields: [
				{
					slug: "deposit_paid",
					displayName: "Депозит оплачен",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "payment_method",
					displayName: "Способ оплаты",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 1,
					optionsJson:
						'[{"value":"cash","label":"Наличные"},{"value":"qr","label":"QR-код"},{"value":"transfer","label":"Перевод"}]',
				},
			],
		},
		{
			slug: "active_rental",
			displayName: "Аренда активна",
			goal: "Отслеживать активную аренду и быть на связи при вопросах.",
			guidance:
				"Напомните о правилах эксплуатации и процедуре при аварии. Оставайтесь на связи. При просрочке возврата — уведомьте.",
			kind: "active",
			stageType: "waiting",
			position: 3,
			color: "#10b981",
			staleTimeoutDays: 30,
			nextStages: ["returned", "cancelled"],
			fields: [
				{
					slug: "pickup_date",
					displayName: "Дата выдачи",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "return_date_confirmed",
					displayName: "Подтверждённая дата возврата",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "mileage_start",
					displayName: "Пробег при выдаче (км)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 2,
				},
			],
		},
		{
			slug: "returned",
			displayName: "Байк возвращён",
			kind: "terminal_won",
			stageType: "milestone",
			position: 4,
			color: "#10b981",
			nextStages: [],
			fields: [
				{
					slug: "return_condition",
					displayName: "Состояние при возврате",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 0,
					optionsJson:
						'[{"value":"good","label":"Без повреждений"},{"value":"minor","label":"Мелкие царапины"},{"value":"damaged","label":"Повреждения"}]',
				},
				{
					slug: "deposit_returned",
					displayName: "Депозит возвращён",
					fieldType: "boolean",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "cancelled",
			displayName: "Отмена",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 5,
			color: "#ef4444",
			nextStages: [],
			fields: [
				{
					slug: "cancellation_reason",
					displayName: "Причина отмены",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
	],

	recruitment: [
		{
			slug: "intake_pending",
			displayName: "Заполнение анкеты",
			goal: "Собрать полную анкету кандидатки со всеми обязательными параметрами для оценки.",
			guidance:
				"Дружелюбно и по порядку запрашивайте недостающие поля: данные паспорта, возраст, рост/вес, гражданство, языки и уровень, стили танца, срок загранпаспорта, город и готовность к выезду. Не торопите, поясняйте формат ответов (например параметры ОГ/ОТ/ОБ), не оценивайте внешность и не давайте обещаний по работе.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["intake_complete", "rejected"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "full_name",
					displayName: "Имя и фамилия (как в паспорте)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "age",
					displayName: "Возраст",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "height_cm",
					displayName: "Рост (см)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 2,
				},
				{
					slug: "weight_kg",
					displayName: "Вес (кг)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 3,
				},
				{
					slug: "nationality",
					displayName: "Гражданство",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 4,
				},
				{
					slug: "marital_status",
					displayName: "Семейное положение",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 5,
					optionsJson:
						'[{"value":"single","label":"Не замужем"},{"value":"married","label":"Замужем"},{"value":"divorced","label":"Разведена"},{"value":"widowed","label":"Вдова"}]',
				},
				{
					slug: "children",
					displayName: "Дети",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "нет / есть — укажите сколько",
					position: 6,
				},
				{
					slug: "languages",
					displayName: "Языки и уровень",
					fieldType: "textarea",
					required: true,
					aiExtractable: true,
					hint: "например: английский B2, базовый китайский",
					position: 7,
				},
				{
					slug: "work_experience",
					displayName: "Опыт работы (2 года)",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 8,
				},
				{
					slug: "passport_expiry",
					displayName: "Срок действия загранпаспорта",
					fieldType: "date",
					required: true,
					aiExtractable: true,
					position: 9,
				},
				{
					slug: "city_and_readiness",
					displayName: "Город и готовность к выезду",
					fieldType: "textarea",
					required: true,
					aiExtractable: true,
					position: 10,
				},
				{
					slug: "dance_styles",
					displayName: "Стили танца",
					fieldType: "multiselect",
					required: true,
					aiExtractable: true,
					position: 11,
					optionsJson:
						'[{"value":"show_ballet","label":"Шоу-балет"},{"value":"strip_plastic","label":"Стрип-пластика"},{"value":"pole","label":"Pole dance"},{"value":"latin","label":"Латина"},{"value":"contemporary","label":"Контемп"},{"value":"go_go","label":"Go-go"},{"value":"fire_show","label":"Fire show"},{"value":"acrobatics","label":"Акробатика"},{"value":"other","label":"Другое"}]',
				},
				{
					slug: "bust_waist_hips",
					displayName: "Параметры (ОГ/ОТ/ОБ)",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					hint: "например: 88/60/90",
					position: 12,
				},
				{
					slug: "shoe_size",
					displayName: "Размер обуви (EU)",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 13,
				},
				{
					slug: "hair_color",
					displayName: "Цвет волос",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 14,
					optionsJson:
						'[{"value":"blonde","label":"Блондинка"},{"value":"brunette","label":"Брюнетка"},{"value":"red","label":"Рыжая"},{"value":"dark_blonde","label":"Тёмно-русая"},{"value":"other","label":"Другой"}]',
				},
				{
					slug: "eye_color",
					displayName: "Цвет глаз",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 15,
					optionsJson:
						'[{"value":"blue","label":"Голубые"},{"value":"green","label":"Зелёные"},{"value":"brown","label":"Карие"},{"value":"grey","label":"Серые"},{"value":"other","label":"Другой"}]',
				},
				{
					slug: "tattoos",
					displayName: "Татуировки / пирсинг",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 16,
					optionsJson:
						'[{"value":"none","label":"Нет"},{"value":"hidden","label":"Есть, скрытые"},{"value":"visible","label":"Есть, видимые"}]',
				},
				{
					slug: "has_valid_schengen",
					displayName: "Есть действующая шенген/US виза",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					position: 17,
				},
				{
					slug: "additional_skills",
					displayName: "Доп. навыки",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					hint: "вокал, акробатика, языки и т.д.",
					position: 18,
				},
			],
		},
		{
			slug: "intake_complete",
			phase: "qualify",
			displayName: "Анкета собрана",
			goal: "Подтвердить полноту анкеты и подготовить кандидатку к рассмотрению.",
			guidance:
				"Поблагодарите за заполнение, кратко подтвердите, что данные приняты, и предупредите, что анкета уходит на оценку/партнёру. Не обещайте одобрение и не называйте сроки решения как гарантию.",
			kind: "active",
			stageType: "assessment",
			position: 1,
			color: "#f59e0b",
			nextStages: ["approved", "partner_review", "rejected"],
			fields: [],
		},
		{
			slug: "partner_review",
			phase: "offer",
			displayName: "На рассмотрении у партнёра",
			goal: "Удержать кандидатку на связи, пока партнёр рассматривает анкету.",
			guidance:
				"Спокойно сообщите, что анкета на рассмотрении у партнёра и решение занимает время. Отвечайте на вопросы, но не торопите партнёра и не гарантируйте результат; при запросе уточняйте, что сообщите сразу, как будет ответ.",
			kind: "active",
			stageType: "external_approval",
			position: 2,
			color: "#8b5cf6",
			staleTimeoutDays: 14,
			nextStages: ["approved", "rejected"],
			fields: [],
		},
		{
			slug: "approved",
			phase: "offer",
			displayName: "Одобрена",
			goal: "Сообщить об одобрении и плавно перевести к сбору документов.",
			guidance:
				"Поздравьте с одобрением, коротко объясните следующий шаг — подготовку документов и фото/видео. Сохраняйте деловой позитивный тон, без лишних обещаний по условиям контракта.",
			kind: "active",
			stageType: "milestone",
			position: 3,
			color: "#22c55e",
			nextStages: ["docs_pending"],
			fields: [],
		},
		{
			slug: "docs_pending",
			phase: "clear",
			displayName: "Сбор документов",
			goal: "Получить все нужные документы: скан загранпаспорта, фотографии и видео.",
			guidance:
				"Чётко перечислите, что нужно прислать (скан загранпаспорта, 6–8 фото, видео-визитку и видео танца) и в каком виде. Мягко напоминайте о недостающем, поясняйте требования к качеству, не давите.",
			kind: "active",
			stageType: "document_upload",
			position: 4,
			color: "#f59e0b",
			staleTimeoutDays: 21,
			nextStages: ["docs_complete", "rejected"],
			fields: [
				{
					slug: "passport_scan",
					displayName: "Скан загранпаспорта",
					fieldType: "file",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "photos",
					displayName: "Фотографии (6–8 шт.)",
					fieldType: "file",
					required: true,
					aiExtractable: false,
					position: 1,
				},
				{
					slug: "video_intro",
					displayName: "Видео (2 видео)",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					position: 2,
				},
				{
					slug: "dance_video",
					displayName: "Видео танца (1 мин.)",
					fieldType: "file",
					required: false,
					aiExtractable: false,
					position: 3,
				},
			],
		},
		{
			slug: "docs_complete",
			phase: "clear",
			displayName: "Документы собраны",
			goal: "Подтвердить получение полного пакета документов и анонсировать визовый этап.",
			guidance:
				"Подтвердите, что все документы получены и приняты, поблагодарите. Предупредите, что дальше — заполнение визовой анкеты, настройте на внимательность к точности данных.",
			kind: "active",
			stageType: "milestone",
			position: 5,
			color: "#22c55e",
			nextStages: ["visa_form"],
			fields: [],
		},
		{
			slug: "visa_form",
			phase: "clear",
			displayName: "Заполнение визовой анкеты",
			goal: "Собрать все данные для официальной визовой анкеты строго по документам.",
			guidance:
				"Запрашивайте поля по порядку и подчёркивайте, что имена, даты и номера вводятся латиницей и точно как в загранпаспорте. Будьте терпеливы и аккуратны, перепроверяйте сомнительные значения, не выдумывайте данные за кандидатку.",
			kind: "active",
			stageType: "form_fill",
			position: 6,
			color: "#3b82f6",
			nextStages: ["visa_filing", "rejected"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "visa_application_city",
					displayName: "Город подачи документов",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "Ближайшее консульство или визовый центр",
					position: 0,
				},
				{
					slug: "family_name",
					displayName: "Фамилия (латиницей)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "Как в загранпаспорте",
					position: 1,
				},
				{
					slug: "given_name",
					displayName: "Имя (латиницей)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "Как в загранпаспорте",
					position: 2,
				},
				{
					slug: "date_of_birth",
					displayName: "Дата рождения",
					fieldType: "date",
					required: true,
					aiExtractable: true,
					position: 3,
				},
				{
					slug: "country_of_birth",
					displayName: "Страна рождения (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 4,
				},
				{
					slug: "birth_province",
					displayName: "Область / штат рождения (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 5,
				},
				{
					slug: "city_of_birth",
					displayName: "Город рождения (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 6,
				},
				{
					slug: "marital_status",
					displayName: "Семейное положение",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 7,
					optionsJson:
						'[{"value":"single","label":"Single"},{"value":"married","label":"Married"},{"value":"divorced","label":"Divorced"},{"value":"widowed","label":"Widowed"}]',
				},
				{
					slug: "current_nationality",
					displayName: "Гражданство (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 8,
				},
				{
					slug: "national_id_number",
					displayName: "Номер внутреннего паспорта",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 9,
				},
				{
					slug: "other_nationalities",
					displayName: "Другое гражданство (если есть)",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 10,
				},
				{
					slug: "other_permanent_residence",
					displayName: "ПМЖ в другой стране",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					position: 11,
				},
				{
					slug: "held_other_nationalities",
					displayName: "Было ли другое гражданство ранее",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					position: 12,
				},
				{
					slug: "passport_number",
					displayName: "Номер загранпаспорта",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 13,
				},
				{
					slug: "passport_issuing_country",
					displayName: "Страна выдачи загранпаспорта (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 14,
				},
				{
					slug: "passport_issuing_place",
					displayName: "Место выдачи загранпаспорта",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 15,
				},
				{
					slug: "passport_expiration_date",
					displayName: "Дата окончания загранпаспорта",
					fieldType: "date",
					required: true,
					aiExtractable: true,
					position: 16,
				},
				{
					slug: "current_address",
					displayName: "Адрес проживания (на английском)",
					fieldType: "textarea",
					required: true,
					aiExtractable: true,
					position: 17,
				},
				{
					slug: "phone",
					displayName: "Телефон",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 18,
				},
				{
					slug: "mobile_phone",
					displayName: "Мобильный телефон",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 19,
				},
				{
					slug: "email",
					displayName: "Email",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 20,
				},
				{
					slug: "father_name",
					displayName: "Имя отца (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 21,
				},
				{
					slug: "father_nationality",
					displayName: "Гражданство отца (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 22,
				},
				{
					slug: "father_dob",
					displayName: "Дата рождения отца",
					fieldType: "date",
					required: false,
					aiExtractable: true,
					position: 23,
				},
				{
					slug: "mother_name",
					displayName: "Имя матери (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 24,
				},
				{
					slug: "mother_nationality",
					displayName: "Гражданство матери (на английском)",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 25,
				},
				{
					slug: "mother_dob",
					displayName: "Дата рождения матери",
					fieldType: "date",
					required: false,
					aiExtractable: true,
					position: 26,
				},
				{
					slug: "been_to_china",
					displayName: "Были ли в Китае",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 27,
				},
				{
					slug: "previous_chinese_visa",
					displayName: "Предыдущие китайские визы (тип, номер, дата)",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 28,
				},
				{
					slug: "work_experience",
					displayName: "Опыт работы (обратный порядок)",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 29,
				},
				{
					slug: "education",
					displayName: "Образование",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 30,
				},
				{
					slug: "travel_history_12mo",
					displayName: "Поездки за рубеж за 12 месяцев",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 31,
				},
				{
					slug: "family_other",
					displayName: "Муж и дети (если есть)",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 32,
				},
			],
		},
		{
			slug: "visa_filing",
			phase: "clear",
			displayName: "Подача документов на визу",
			goal: "Сопроводить кандидатку на этапе подачи документов в консульство/визовый центр.",
			guidance:
				"Сообщите, что документы поданы на оформление визы, и объясните, чего ждать дальше. Отвечайте на организационные вопросы по подаче, но не гарантируйте сроки и исход рассмотрения консульством.",
			kind: "active",
			stageType: "external_approval",
			position: 7,
			color: "#8b5cf6",
			nextStages: ["visa_waiting"],
			fields: [],
		},
		{
			slug: "visa_waiting",
			phase: "clear",
			displayName: "Ожидание решения по визе",
			goal: "Поддерживать контакт с кандидаткой во время ожидания решения по визе.",
			guidance:
				"Спокойно поясните, что виза на рассмотрении и это может занять время. Будьте на связи, отвечайте на вопросы, но не давите на консульство и не обещайте конкретную дату или положительный исход.",
			kind: "active",
			stageType: "waiting",
			position: 8,
			color: "#94a3b8",
			staleTimeoutDays: 90,
			nextStages: ["ready_to_work", "rejected"],
			fields: [],
		},
		{
			slug: "ready_to_work",
			phase: "fulfill",
			displayName: "Готова к работе",
			goal: "Подтвердить готовность кандидатки к выезду и переходу к работе.",
			guidance:
				"Поздравьте с получением визы и готовностью к работе, обозначьте ближайшие организационные шаги по выезду. Сохраняйте деловой поддерживающий тон и уточняйте оставшиеся вопросы по логистике.",
			kind: "active",
			stageType: "milestone",
			position: 9,
			color: "#10b981",
			nextStages: ["closed"],
			fields: [],
		},
		{
			slug: "closed",
			displayName: "Завершено",
			kind: "terminal_won",
			stageType: "milestone",
			position: 10,
			color: "#10b981",
			nextStages: [],
			fields: [],
		},
		{
			slug: "rejected",
			displayName: "Отказ",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 11,
			color: "#ef4444",
			nextStages: [],
			fields: [],
		},
	],

	// Универсальный шаблон найма — подходит для любого HR-агентства без
	// специфики ОАЭ/артистов. Используется при продажах через партнёрскую сеть.
	recruitment_generic: [
		{
			slug: "new_lead",
			displayName: "Новый лид",
			goal: "Познакомиться с кандидатом и зафиксировать имя, контакт и интересующую должность.",
			guidance:
				"Тепло поприветствуйте, поблагодарите за отклик и дружелюбно уточните недостающие данные: как зовут, как лучше связаться и на какую позицию претендует. Не задавайте лишних вопросов про опыт на этом этапе — только базовое знакомство.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["qualifying", "rejected"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "full_name",
					displayName: "Имя и фамилия",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "phone",
					displayName: "Телефон / Telegram",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "position_interest",
					displayName: "Интересующая должность",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 2,
				},
			],
		},
		{
			slug: "qualifying",
			displayName: "Квалификация",
			goal: "Оценить релевантность кандидата: опыт, зарплатные ожидания и готовность выйти на работу.",
			guidance:
				"Спрашивайте по одному, без давления: сколько лет опыта, ожидания по зарплате (с валютой), когда готов приступить, при необходимости — готовность к релокации. Будьте доброжелательны и нейтральны, не обещайте оффер и не критикуйте запросы кандидата.",
			kind: "active",
			stageType: "form_fill",
			position: 1,
			color: "#f59e0b",
			nextStages: ["interview_scheduled", "rejected"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "experience_years",
					displayName: "Опыт работы (лет)",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "current_salary",
					displayName: "Текущая зарплата",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					hint: "укажите валюту",
					position: 1,
				},
				{
					slug: "expected_salary",
					displayName: "Ожидаемая зарплата",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "укажите валюту",
					position: 2,
				},
				{
					slug: "availability",
					displayName: "Когда готов выйти",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					hint: "например: сразу / через 2 недели / после 1 июня",
					position: 3,
				},
				{
					slug: "relocation",
					displayName: "Готов к релокации",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					position: 4,
				},
				{
					slug: "notes",
					displayName: "Дополнительно",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 5,
				},
			],
		},
		{
			slug: "interview_scheduled",
			displayName: "Интервью назначено",
			goal: "Согласовать удобные дату, время и формат интервью и подтвердить договорённость.",
			guidance:
				"Предложите варианты времени и уточните удобный формат (онлайн, офис или телефон). Чётко проговорите дату, время и что подготовить, вежливо подтвердите запись и напомните, что при изменениях кандидат может написать.",
			kind: "active",
			stageType: "milestone",
			position: 2,
			color: "#8b5cf6",
			nextStages: ["offer_sent", "rejected"],
			fields: [
				{
					slug: "interview_date",
					displayName: "Дата и время интервью",
					fieldType: "date",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "interview_format",
					displayName: "Формат",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 1,
					optionsJson:
						'[{"value":"online","label":"Онлайн"},{"value":"office","label":"Офис"},{"value":"phone","label":"Телефон"}]',
				},
			],
		},
		{
			slug: "offer_sent",
			displayName: "Оффер отправлен",
			goal: "Донести условия оффера и помочь кандидату принять решение о выходе.",
			guidance:
				"Понятно изложите предложенную зарплату и предполагаемую дату выхода, ответьте на вопросы по условиям. Сохраняйте позитивный тон, мягко уточните решение и срок, не давите со сроками сверх меры.",
			kind: "active",
			stageType: "milestone",
			position: 3,
			color: "#ec4899",
			staleTimeoutDays: 7,
			nextStages: ["hired", "rejected"],
			fields: [
				{
					slug: "salary_offered",
					displayName: "Предложенная зарплата",
					fieldType: "text",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "start_date",
					displayName: "Дата выхода",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "hired",
			displayName: "Принят",
			kind: "terminal_won",
			stageType: "milestone",
			position: 4,
			color: "#22c55e",
			nextStages: [],
			fields: [],
		},
		{
			slug: "rejected",
			displayName: "Отказ",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 5,
			color: "#ef4444",
			nextStages: [],
			fields: [],
		},
	],

	// Воронка продаж lead-engine самого себя.
	// Используется для тенанта-бота, который квалифицирует рекрутинговые
	// агентства как потенциальных клиентов платформы. Мета-демо: человек
	// видит продукт в действии прямо в процессе продажи.
	leadengine_sales_v1: [
		{
			slug: "new_lead",
			displayName: "Новый контакт",
			goal: "Познакомиться с агентством и понять, как оно сейчас обрабатывает входящие заявки.",
			guidance:
				"Тепло начните диалог, узнайте имя, название агентства и город, мягко выясните, как обрабатывают входящих кандидатов сейчас. Не презентуйте продукт сразу — сперва контакт и контекст.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["qualifying", "not_interested"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "name",
					displayName: "Имя",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "agency_name",
					displayName: "Название агентства",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "city",
					displayName: "Город / страна",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 2,
				},
			],
		},
		{
			slug: "qualifying",
			displayName: "Квалификация (NEPQ)",
			goal: "Выявить боль: объём лидов, потери из-за скорости ответа, текущий инструмент и бюджет.",
			guidance:
				"Задавайте проблемно-ориентированные вопросы в духе NEPQ: сколько лидов в день, теряются ли из-за медленных ответов, чем пользуются и какой бюджет. Усиливайте осознание проблемы, не продавайте в лоб.",
			kind: "active",
			stageType: "form_fill",
			position: 1,
			color: "#f59e0b",
			nextStages: ["objection_handling", "trial_offered", "not_interested"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "leads_per_day",
					displayName: "Входящих лидов в день",
					fieldType: "number",
					required: true,
					aiExtractable: true,
					hint: "примерно сколько пишут в Telegram/WhatsApp в день",
					position: 0,
				},
				{
					slug: "response_time_problem",
					displayName: "Теряете лиды из-за скорости ответа",
					fieldType: "boolean",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "current_tool",
					displayName: "Текущий инструмент",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 2,
					optionsJson:
						'[{"value":"none","label":"Ничего, отвечаем вручную"},{"value":"manychat","label":"ManyChat"},{"value":"other_bot","label":"Другой бот"},{"value":"crm","label":"CRM с чатом"},{"value":"other","label":"Другое"}]',
				},
				{
					slug: "team_size",
					displayName: "Операторов на входящих",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					hint: "сколько человек обрабатывают входящие заявки",
					position: 3,
				},
				{
					slug: "monthly_budget_ok",
					displayName: "Готов к $99/мес",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					hint: "если упомянули бюджет или цену",
					position: 4,
				},
			],
		},
		{
			slug: "objection_handling",
			displayName: "Работа с возражением",
			goal: "Снять ключевое возражение и вернуть фокус на ценность решения.",
			guidance:
				"Спокойно выслушайте сомнение (цена, доверие, «у нас уже есть бот»), отзеркальте его и ответьте фактами и выгодой. Не спорьте и не давите — ведите к пробному периоду.",
			kind: "active",
			stageType: "assessment",
			position: 2,
			color: "#8b5cf6",
			staleTimeoutDays: 3,
			nextStages: ["trial_offered", "not_interested"],
			fields: [
				{
					slug: "main_objection",
					displayName: "Главное возражение",
					fieldType: "select",
					required: false,
					aiExtractable: true,
					position: 0,
					optionsJson:
						'[{"value":"price","label":"Дорого"},{"value":"need_developer","label":"Сложно без разработчика"},{"value":"data_safety","label":"Безопасность данных"},{"value":"ai_quality","label":"AI не так хорошо отвечает"},{"value":"no_time","label":"Нет времени разбираться"},{"value":"other","label":"Другое"}]',
				},
				{
					slug: "objection_resolved",
					displayName: "Возражение закрыто",
					fieldType: "boolean",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "trial_offered",
			displayName: "Триал предложен",
			goal: "Предложить запуск пробного периода и получить согласие подключиться.",
			guidance:
				"Чётко объясните, что входит в триал и как быстро он развернётся, снимите страх сложного внедрения. Подведите к конкретному «да» и следующему шагу подключения.",
			kind: "active",
			stageType: "milestone",
			position: 3,
			color: "#ec4899",
			staleTimeoutDays: 7,
			nextStages: ["trial_started", "not_interested"],
			fields: [
				{
					slug: "signup_link_sent",
					displayName: "Ссылка на регистрацию отправлена",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "referral_code_shared",
					displayName: "Партнёрский код передан",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					hint: "если лид пришёл от партнёра",
					position: 1,
				},
			],
		},
		{
			slug: "trial_started",
			displayName: "Зарегистрировался",
			kind: "terminal_won",
			stageType: "milestone",
			position: 4,
			color: "#22c55e",
			nextStages: [],
			fields: [],
		},
		{
			slug: "not_interested",
			displayName: "Не интересует",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 5,
			color: "#6b7280",
			nextStages: [],
			fields: [],
		},
	],
	saas: [
		{
			slug: "discovery",
			displayName: "Первичное знакомство",
			goal: "Собрать профиль компании и контакт, понять главную боль в работе с лидами.",
			guidance:
				"Задавайте вопросы по одному, дружелюбно и без давления: сфера, размер команды, объём лидов и что именно болит. Сначала разберитесь в ситуации клиента, не предлагайте тариф.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["qualified"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "company_name",
					displayName: "Компания",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "industry",
					displayName: "Сфера деятельности",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "team_size",
					displayName: "Размер команды",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 2,
					optionsJson:
						'[{"value":"solo","label":"Только я"},{"value":"2-5","label":"2–5"},{"value":"6-20","label":"6–20"},{"value":"20+","label":"20+"}]',
				},
				{
					slug: "monthly_lead_volume",
					displayName: "Лидов в месяц",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					hint: "Примерный объём входящих лидов",
					position: 3,
				},
				{
					slug: "pain_point",
					displayName: "Главная боль",
					fieldType: "textarea",
					required: true,
					aiExtractable: true,
					position: 4,
				},
				{
					slug: "contact_name",
					displayName: "Имя",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 5,
				},
				{
					slug: "contact_role",
					displayName: "Должность",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 6,
				},
				{
					slug: "contact_phone",
					displayName: "Телефон",
					fieldType: "phone",
					required: true,
					aiExtractable: true,
					position: 7,
				},
			],
		},
		{
			slug: "qualified",
			phase: "qualify",
			displayName: "Квалифицирован",
			goal: "Оценить серьёзность лида: бюджет, текущее решение и готовность двигаться к демо.",
			guidance:
				"Аккуратно проясните, чем пользуются сейчас и какой бюджет закладывают, свяжите это с озвученной болью. Не продавайте в лоб — подведите к идее показать продукт на демо.",
			kind: "active",
			stageType: "interaction",
			position: 1,
			color: "#8b5cf6",
			staleTimeoutDays: 7,
			nextStages: ["demo_scheduled", "lost"],
			fields: [
				{
					slug: "budget_per_month",
					displayName: "Бюджет в месяц (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "current_solution",
					displayName: "Текущее решение",
					fieldType: "text",
					required: false,
					aiExtractable: true,
					position: 1,
				},
			],
		},
		{
			slug: "demo_scheduled",
			phase: "qualify",
			displayName: "Демо назначено",
			goal: "Согласовать удобные дату и время демо и довести лида до встречи.",
			guidance:
				"Предложите 2–3 слота, подтвердите выбор и кратко напомните, что покажете под боль клиента. Будьте конкретны, снимите страх «потратить время впустую».",
			kind: "active",
			stageType: "milestone",
			position: 2,
			color: "#f59e0b",
			staleTimeoutDays: 3,
			nextStages: ["demo_done", "lost"],
			fields: [
				{
					slug: "demo_date",
					displayName: "Дата демо",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
		{
			slug: "demo_done",
			phase: "qualify",
			displayName: "Демо проведено",
			goal: "Зафиксировать впечатление после демо и определить уровень интереса.",
			guidance:
				"Спросите, что понравилось и какие остались вопросы или сомнения, отработайте возражения по существу. Если интерес тёплый или горячий — мягко предложите подготовить коммерческое предложение.",
			kind: "active",
			stageType: "interaction",
			position: 3,
			color: "#ec4899",
			staleTimeoutDays: 5,
			nextStages: ["proposal_sent", "lost"],
			fields: [
				{
					slug: "demo_notes",
					displayName: "Заметки по демо",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "interest_level",
					displayName: "Уровень интереса",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 1,
					optionsJson:
						'[{"value":"hot","label":"Горячий"},{"value":"warm","label":"Тёплый"},{"value":"cold","label":"Холодный"}]',
				},
			],
		},
		{
			slug: "proposal_sent",
			phase: "offer",
			displayName: "КП отправлено",
			goal: "Презентовать подходящий тариф и сумму, получить реакцию на предложение.",
			guidance:
				"Подберите план под размер команды и объём лидов, объясните ценность, а не только цену. Уточните, всё ли понятно в КП, и аккуратно подведите к обсуждению условий.",
			kind: "active",
			stageType: "document_signature",
			position: 4,
			color: "#6366f1",
			staleTimeoutDays: 7,
			nextStages: ["negotiation", "lost"],
			fields: [
				{
					slug: "proposal_plan",
					displayName: "Тарифный план",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 0,
					optionsJson:
						'[{"value":"starter","label":"Starter"},{"value":"growth","label":"Growth"},{"value":"enterprise","label":"Enterprise"}]',
				},
				{
					slug: "proposal_amount_usd",
					displayName: "Сумма КП (USD/мес)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "negotiation",
			phase: "offer",
			displayName: "Переговоры",
			goal: "Снять финальные возражения и согласовать условия для подписания договора.",
			guidance:
				"Выслушайте сомнения по цене и срокам, ищите компромисс в рамках разумного, фиксируйте договорённости. Держите консультативный тон, ведите к конкретному решению без напора.",
			kind: "active",
			stageType: "interaction",
			position: 5,
			color: "#0ea5e9",
			staleTimeoutDays: 10,
			nextStages: ["signed", "lost"],
			fields: [
				{
					slug: "negotiation_notes",
					displayName: "Ход переговоров",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "agreed_amount_usd",
					displayName: "Согласованная сумма (USD/мес)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "signed",
			displayName: "Договор подписан",
			kind: "terminal_won",
			stageType: "milestone",
			position: 6,
			color: "#22c55e",
			nextStages: [],
			fields: [
				{
					slug: "signed_date",
					displayName: "Дата подписания",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "mrr_usd",
					displayName: "MRR (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "lost",
			displayName: "Не состоялось",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 7,
			color: "#6b7280",
			nextStages: [],
			fields: [
				{
					slug: "lost_reason",
					displayName: "Причина",
					fieldType: "select",
					required: false,
					aiExtractable: false,
					position: 0,
					optionsJson:
						'[{"value":"price","label":"Цена"},{"value":"competitor","label":"Конкурент"},{"value":"no_budget","label":"Нет бюджета"},{"value":"not_ready","label":"Не готовы"},{"value":"other","label":"Другое"}]',
				},
			],
		},
	],
	video: [
		{
			slug: "inquiry",
			displayName: "Первичный запрос",
			goal: "Зафиксировать тип услуги, локацию и контакты, чтобы понять суть проекта и связаться с клиентом.",
			guidance:
				"Дружелюбно и по делу уточните, что нужно снять (мероприятие, корпоратив, Reels и т.д.), где и для чего, спросите про дату, бюджет и референсы. Не давите ценой и не обещайте смету до брифа — сейчас задача собрать вводные.",
			kind: "intake",
			stageType: "form_fill",
			position: 0,
			color: "#3b82f6",
			nextStages: ["brief_call"],
			autoAdvanceCondition: '{"type":"all_required_fields_filled"}',
			fields: [
				{
					slug: "service_type",
					displayName: "Тип услуги",
					fieldType: "select",
					required: true,
					aiExtractable: true,
					position: 0,
					optionsJson:
						'[{"value":"event","label":"Съёмка мероприятия"},{"value":"corporate","label":"Корпоративное видео"},{"value":"reels","label":"Reels / Shorts"},{"value":"photo","label":"Фотосессия"},{"value":"animation","label":"Анимация / Motion"},{"value":"other","label":"Другое"}]',
				},
				{
					slug: "event_date",
					displayName: "Дата съёмки",
					fieldType: "date",
					required: false,
					aiExtractable: true,
					position: 1,
				},
				{
					slug: "location",
					displayName: "Локация",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 2,
				},
				{
					slug: "style_ref",
					displayName: "Референсы / стиль",
					fieldType: "textarea",
					required: false,
					aiExtractable: true,
					position: 3,
				},
				{
					slug: "budget_usd",
					displayName: "Бюджет (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 4,
				},
				{
					slug: "contact_name",
					displayName: "Имя",
					fieldType: "text",
					required: true,
					aiExtractable: true,
					position: 5,
				},
				{
					slug: "contact_phone",
					displayName: "Телефон",
					fieldType: "phone",
					required: true,
					aiExtractable: true,
					position: 6,
				},
			],
		},
		{
			slug: "brief_call",
			phase: "qualify",
			displayName: "Бриф / звонок",
			goal: "Снять полный бриф: задачи, хронометраж, формат и ожидания клиента от видео.",
			guidance:
				"Говорите как творческий продюсер — заинтересованно расспросите про идею, целевую аудиторию, желаемый хронометраж и стиль, зафиксируйте детали в заметках. Слушайте больше, чем говорите, и не называйте цифры сметы до согласования объёма работ.",
			kind: "active",
			stageType: "interaction",
			position: 1,
			color: "#8b5cf6",
			staleTimeoutDays: 5,
			nextStages: ["quote_sent", "declined"],
			fields: [
				{
					slug: "duration_min",
					displayName: "Хронометраж (мин)",
					fieldType: "number",
					required: false,
					aiExtractable: true,
					position: 0,
				},
				{
					slug: "brief_notes",
					displayName: "Заметки по брифу",
					fieldType: "textarea",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "quote_sent",
			phase: "offer",
			displayName: "Смета отправлена",
			goal: "Презентовать смету и объём работ так, чтобы клиент понял ценность и был готов согласовать.",
			guidance:
				"Чётко и прозрачно опишите, что входит в смету (съёмочные дни, монтаж, правки), привяжите цену к задачам из брифа. Будьте открыты к вопросам по составу, но не торгуйтесь беспорядочно — объясняйте, из чего складывается стоимость.",
			kind: "active",
			stageType: "form_fill",
			position: 2,
			color: "#f59e0b",
			staleTimeoutDays: 7,
			nextStages: ["quote_approved", "declined"],
			fields: [
				{
					slug: "quote_amount_usd",
					displayName: "Сумма сметы (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "shoot_days",
					displayName: "Съёмочных дней",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "quote_approved",
			phase: "offer",
			displayName: "Смета согласована",
			goal: "Подтвердить согласование сметы и получить предоплату для старта работ.",
			guidance:
				"Поблагодарите за доверие, проговорите следующий шаг — внесение предоплаты и фиксацию даты съёмки. Спокойно и уверенно подскажите порядок оплаты, не создавая давления, но обозначив, что съёмка стартует после предоплаты.",
			kind: "active",
			stageType: "milestone",
			position: 3,
			color: "#ec4899",
			staleTimeoutDays: 5,
			nextStages: ["shoot_scheduled", "declined"],
			fields: [
				{
					slug: "deposit_paid",
					displayName: "Предоплата получена",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "deposit_amount_usd",
					displayName: "Сумма предоплаты (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "shoot_scheduled",
			phase: "fulfill",
			displayName: "Съёмка назначена",
			goal: "Согласовать дату и адрес съёмки и подготовить клиента к съёмочному дню.",
			guidance:
				"По-деловому подтвердите дату, локацию и тайминг, уточните организационные детали (доступ, реквизит, участники). Тон — собранный и заботливый, чтобы клиент чувствовал, что всё под контролем.",
			kind: "active",
			stageType: "milestone",
			position: 4,
			color: "#6366f1",
			staleTimeoutDays: 30,
			nextStages: ["editing", "declined"],
			fields: [
				{
					slug: "shoot_date",
					displayName: "Дата съёмки",
					fieldType: "date",
					required: true,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "shoot_address",
					displayName: "Адрес съёмки",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "editing",
			phase: "fulfill",
			displayName: "Монтаж",
			goal: "Держать клиента в курсе по монтажу и согласовать дедлайн и правки.",
			guidance:
				"Информируйте о ходе работы и сроках, аккуратно напоминайте про лимит правок, если клиент просит много изменений. Будьте отзывчивы к замечаниям, но защищайте рамки проекта и качество результата.",
			kind: "active",
			stageType: "interaction",
			position: 5,
			color: "#0ea5e9",
			staleTimeoutDays: 21,
			nextStages: ["delivery"],
			fields: [
				{
					slug: "editing_deadline",
					displayName: "Дедлайн монтажа",
					fieldType: "date",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "revisions_count",
					displayName: "Правок использовано",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "delivery",
			phase: "fulfill",
			displayName: "Сдача материала",
			goal: "Передать готовый материал и получить подтверждение приёмки от клиента.",
			guidance:
				"Передайте ссылку на готовое видео, попросите посмотреть и подтвердить приёмку. Тон — гордый за результат, но внимательный: уточните, всё ли устраивает, и зафиксируйте финальное согласование.",
			kind: "active",
			stageType: "milestone",
			position: 6,
			color: "#84cc16",
			staleTimeoutDays: 7,
			nextStages: ["invoiced"],
			fields: [
				{
					slug: "delivery_link",
					displayName: "Ссылка на материал",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 0,
				},
				{
					slug: "client_approved",
					displayName: "Клиент принял",
					fieldType: "boolean",
					required: true,
					aiExtractable: false,
					position: 1,
				},
			],
		},
		{
			slug: "invoiced",
			displayName: "Счёт выставлен",
			kind: "terminal_won",
			stageType: "milestone",
			position: 7,
			color: "#22c55e",
			nextStages: [],
			fields: [
				{
					slug: "final_amount_usd",
					displayName: "Финальная сумма (USD)",
					fieldType: "number",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
		{
			slug: "declined",
			displayName: "Отказ",
			kind: "terminal_lost",
			stageType: "milestone",
			position: 8,
			color: "#6b7280",
			nextStages: [],
			fields: [
				{
					slug: "decline_reason",
					displayName: "Причина",
					fieldType: "text",
					required: false,
					aiExtractable: false,
					position: 0,
				},
			],
		},
	],
};

const FUNNEL_TEMPLATE_ORDER = [
	"exchange",
	"concierge",
	"real_estate",
	"saas",
	"leadengine_sales_v1",
	"visa",
	"modeling",
	"scooter",
	"recruitment",
	"recruitment_generic",
	"video",
	"skeleton",
] as const;

const FUNNEL_TEMPLATE_META: Record<
	string,
	{
		displayName: string;
		description: string;
		verticalTemplateId?: string | null;
		isCreatable?: boolean;
	}
> = {
	exchange: {
		displayName: "Обменка",
		description: "Крипта, фиат, курс, KYC/AML, реквизиты и выдача.",
		verticalTemplateId: "exchange_v1",
	},
	concierge: {
		displayName: "Каталог услуг",
		description:
			"Набор услуг и заявок: обмен, трансфер, продукт, партнёрские сервисы или свои направления.",
		verticalTemplateId: "concierge_v1",
		isCreatable: false,
	},
	real_estate: {
		displayName: "Продажа недвижимости",
		description: "Заявка, квалификация, подбор объектов, показ и сделка.",
		verticalTemplateId: "real_estate_v1",
	},
	saas: {
		displayName: "SaaS / продукт",
		description: "Демо, квалификация, предложение, оплата и онбординг.",
		verticalTemplateId: "saas_v1",
	},
	leadengine_sales_v1: {
		displayName: "Продажа Lead Engine",
		description: "B2B-продажа продукта: диагностика, демо, оффер и запуск.",
		verticalTemplateId: null,
	},
	visa: {
		displayName: "Визы",
		description: "Визовая заявка, документы, проверка, подача и результат.",
		verticalTemplateId: "visa_v1",
	},
	modeling: {
		displayName: "Модельное агентство",
		description: "Кастинг, портфолио, интервью, оффер и контракт.",
		verticalTemplateId: "modeling_v1",
	},
	scooter: {
		displayName: "Аренда скутеров",
		description: "Подбор транспорта, документы, депозит, выдача и возврат.",
		verticalTemplateId: "scooter_v1",
	},
	recruitment: {
		displayName: "Рекрутинг",
		description: "Анкета, интервью, документы, оффер и выход кандидата.",
		verticalTemplateId: "recruitment_v1",
	},
	recruitment_generic: {
		displayName: "Рекрутинг generic",
		description: "Универсальная найм-воронка без доменной специализации.",
		verticalTemplateId: null,
	},
	video: {
		displayName: "Видео / продакшн",
		description: "Бриф, смета, предоплата, съёмка, монтаж и сдача.",
		verticalTemplateId: "video_v1",
	},
	skeleton: {
		displayName: "Пустой skeleton",
		description: "Базовый костяк capture → qualify → offer → clear → fulfill.",
		verticalTemplateId: null,
	},
};

function seedTemplateVerticalTemplateId(template: string): string | null {
	return FUNNEL_TEMPLATE_META[template]?.verticalTemplateId ?? null;
}

function listFunnelTemplateInfos() {
	const orderedKeys = new Set<string>();
	const keys: string[] = [];
	for (const key of FUNNEL_TEMPLATE_ORDER) {
		if (SEED_TEMPLATES[key]) {
			orderedKeys.add(key);
			keys.push(key);
		}
	}
	for (const key of Object.keys(SEED_TEMPLATES).sort()) {
		if (!orderedKeys.has(key)) keys.push(key);
	}

	return keys.map((key) => {
		const stages = SEED_TEMPLATES[key]!;
		const fieldsCount = stages.reduce(
			(sum, stage) => sum + stage.fields.length,
			0,
		);
		const meta = FUNNEL_TEMPLATE_META[key];
		let prevPhase: ActivePhase | null = null;
		const stagePreview = stages.map((stage) => {
			const phase = resolveSeedPhase(stage, prevPhase);
			if (phase) prevPhase = phase;
			return {
				slug: stage.slug,
				displayName: stage.displayName,
				kind: stage.kind,
				stageType: stage.stageType,
				phase,
				fieldsCount: stage.fields.length,
			};
		});
		return {
			key,
			displayName: meta?.displayName ?? key.replace(/_/g, " "),
			description: meta?.description ?? "Предустановленная воронка",
			verticalTemplateId: meta?.verticalTemplateId ?? null,
			isCreatable: meta?.isCreatable ?? true,
			stagesCount: stages.length,
			fieldsCount,
			stages: stagePreview,
		};
	});
}

/**
 * Funnel builder + skills list API.
 *
 * GET  /api/admin/funnel                       — активная воронка + все стадии + поля
 * POST /api/admin/funnel/stages                — создать стадию
 * PATCH /api/admin/funnel/stages/:stageId      — обновить стадию
 * DELETE /api/admin/funnel/stages/:stageId     — удалить стадию
 * POST /api/admin/funnel/stages/:stageId/fields — создать поле
 * PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId — обновить поле
 * DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId — удалить поле
 * PATCH /api/admin/funnel/stages/reorder       — переставить позиции
 *
 * GET  /api/admin/skills                       — полный список скилов
 */
/**
 * Программный seed воронки по ключу из SEED_TEMPLATES.
 * Используется install-endpoint'ом вертикалей.
 */
export async function seedFunnelByKey(
	db: Db,
	tenantId: number,
	templateKey: string,
	adminId?: number,
): Promise<{ funnelId: number; stagesCreated: number } | { error: string }> {
	const stages = SEED_TEMPLATES[templateKey];
	if (!stages) return { error: `unknown template key: ${templateKey}` };
	return applyFunnelStages(db, tenantId, stages, templateKey, {
		targetSlug: templateKey,
	});
}

/** Каталог допустимых значений — shared с AI workflow builder для валидации. */
export const STAGE_KINDS = [
	"intake",
	"active",
	"terminal_won",
	"terminal_lost",
] as const;
export const STAGE_TYPES = [
	"form_fill",
	"document_upload",
	"document_signature",
	"rate_confirmation",
	"external_approval",
	"payment",
	"awaiting_operator",
	"interaction",
	"assessment",
	"waiting",
	"milestone",
] as const;
export const FIELD_TYPES = [
	"text",
	"textarea",
	"number",
	"date",
	"select",
	"multiselect",
	"boolean",
	"phone",
	"email",
	"photo",
	"file",
	"video",
] as const;

export type { SeedStage };

/**
 * Фаза костяка для стадии при сидировании: явный тег → эвристика; null для
 * якорей (intake/terminal). Общая логика для applyFunnelStages и тестов костяка.
 */
export function resolveSeedPhase(
	stage: Pick<SeedStage, "kind" | "stageType" | "phase">,
	prevPhase: ActivePhase | null,
): ActivePhase | null {
	if (stage.kind !== "active") return null;
	return stage.phase ?? deriveDefaultPhase(stage.stageType, prevPhase);
}

/**
 * Создаёт воронку из набора стадий (заменяя текущую активную воронку тенанта).
 * Используется и seed-шаблонами вертикалей, и AI workflow builder'ом.
 */
export async function applyFunnelStages(
	db: Db,
	tenantId: number,
	stages: SeedStage[],
	funnelSlug: string,
	opts: { targetSlug?: string } = {},
): Promise<{ funnelId: number; stagesCreated: number }> {
	const now = Math.floor(Date.now() / 1000);
	return withTenant(db, tenantId, async (tx) => {
		const targetSlug = opts.targetSlug ?? null;
		let [funnel] = await tx
			.select()
			.from(funnels)
			.where(
				targetSlug
					? and(eq(funnels.tenantId, tenantId), eq(funnels.slug, targetSlug))
					: and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)),
			)
			.limit(1);

		if (!funnel) {
			const [created] = await tx
				.insert(funnels)
				.values({
					tenantId,
					slug: targetSlug ?? funnelSlug,
					isActive: true,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			funnel = created!;
		}

		const existingStages = await tx
			.select({ id: stageDefinitions.id })
			.from(stageDefinitions)
			.where(eq(stageDefinitions.funnelId, funnel.id));
		const existingStageIds = existingStages.map((s) => s.id);

		// Какие лиды сейчас стоят на стадиях этой воронки — их перенесём на
		// стадию НОВОЙ воронки ТОЙ ЖЕ фазы (сохраняя прогресс), чтобы не
		// осиротить (FK set null → лид исчезает из канбана) и не свалить всех
		// на первую стадию. Без этого «замена воронки» теряет/сбрасывает лиды.
		const leadsOnFunnel =
			existingStageIds.length > 0
				? await tx
						.select({
							id: leads.id,
							oldPhase: stageDefinitions.phase,
							oldKind: stageDefinitions.kind,
						})
						.from(leads)
						.innerJoin(
							stageDefinitions,
							eq(stageDefinitions.id, leads.stageDefinitionId),
						)
						.where(
							and(
								eq(leads.tenantId, tenantId),
								inArray(leads.stageDefinitionId, existingStageIds),
							),
						)
				: [];

		for (const s of existingStages) {
			await tx.delete(stageFields).where(eq(stageFields.stageId, s.id));
		}
		if (existingStages.length > 0) {
			await tx
				.delete(stageDefinitions)
				.where(eq(stageDefinitions.funnelId, funnel.id));
		}

		let stagesCreated = 0;
		let prevPhase: ActivePhase | null = null;
		let initialStage: { id: number; slug: string } | null = null;
		const createdStages: Array<{
			id: number;
			slug: string;
			phase: string | null;
			kind: string;
			position: number;
		}> = [];
		for (const stageTpl of stages) {
			const { fields, ...stageData } = stageTpl;
			const phase = resolveSeedPhase(stageData, prevPhase);
			if (phase) prevPhase = phase;
			const [stage] = await tx
				.insert(stageDefinitions)
				.values({
					tenantId,
					funnelId: funnel.id,
					slug: stageData.slug,
					displayName: stageData.displayName,
					kind: stageData.kind,
					stageType: stageData.stageType,
					phase,
					position: stageData.position,
					color: stageData.color ?? null,
					staleTimeoutDays: stageData.staleTimeoutDays ?? null,
					nextStages: stageData.nextStages,
					autoAdvanceCondition: stageData.autoAdvanceCondition ?? null,
					goal: stageData.goal ?? null,
					guidance: stageData.guidance ?? null,
					supportMode: stageData.supportMode ?? false,
					createdAt: now,
					updatedAt: now,
				})
				.returning({ id: stageDefinitions.id, slug: stageDefinitions.slug });

			if (!stage) continue;
			stagesCreated++;
			createdStages.push({
				id: stage.id,
				slug: stage.slug,
				phase,
				kind: stageData.kind,
				position: stageData.position,
			});
			// Стартовая стадия = intake (или первая созданная) — fallback переноса.
			if (!initialStage || stageData.kind === "intake") initialStage = stage;

			for (const fieldTpl of fields) {
				await tx.insert(stageFields).values({
					stageId: stage.id,
					tenantId,
					slug: fieldTpl.slug,
					displayName: fieldTpl.displayName,
					fieldType: fieldTpl.fieldType,
					required: fieldTpl.required,
					aiExtractable: fieldTpl.aiExtractable,
					hint: fieldTpl.hint ?? null,
					...(fieldTpl.optionsJson
						? { optionsJson: fieldTpl.optionsJson }
						: {}),
					position: fieldTpl.position,
					createdAt: now,
				});
			}
		}

		// Переносим лиды со старых стадий на новые ТОЙ ЖЕ фазы (сохраняя прогресс).
		// Терминальные kind → новый терминал того же kind; иначе fallback intake.
		if (initialStage && leadsOnFunnel.length > 0) {
			const byPhase = new Map<string, { id: number; slug: string }>();
			for (const cs of [...createdStages].sort(
				(a, b) => a.position - b.position,
			)) {
				if (cs.phase && !byPhase.has(cs.phase))
					byPhase.set(cs.phase, { id: cs.id, slug: cs.slug });
			}
			const byKind = new Map<string, { id: number; slug: string }>();
			for (const cs of createdStages) {
				if (
					(cs.kind === "terminal_won" || cs.kind === "terminal_lost") &&
					!byKind.has(cs.kind)
				) {
					byKind.set(cs.kind, { id: cs.id, slug: cs.slug });
				}
			}
			// Группируем лиды по целевой стадии и обновляем батчами.
			const targetToLeadIds = new Map<
				number,
				{ slug: string; ids: number[] }
			>();
			for (const l of leadsOnFunnel) {
				const target =
					(l.oldKind === "terminal_won" || l.oldKind === "terminal_lost"
						? byKind.get(l.oldKind)
						: l.oldPhase
							? byPhase.get(l.oldPhase)
							: null) ?? initialStage;
				const entry = targetToLeadIds.get(target.id) ?? {
					slug: target.slug,
					ids: [],
				};
				entry.ids.push(l.id);
				targetToLeadIds.set(target.id, entry);
			}
			for (const [stageId, { slug, ids }] of targetToLeadIds) {
				await tx
					.update(leads)
					.set({ stageDefinitionId: stageId, state: slug, updatedAt: now })
					.where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids)));
			}
		}

		return { funnelId: funnel.id, stagesCreated };
	});
}

/**
 * Программный seed навыков из SKILLS_CATALOGUE.
 * Используется install-endpoint'ом вертикалей.
 */
export async function seedSkillsCatalogue(
	db: Db,
	tenantId: number,
): Promise<{ seeded: number; updated: number; skipped: number }> {
	const nowEpoch = Math.floor(Date.now() / 1000);
	let seeded = 0;
	let updated = 0;
	let skipped = 0;

	await withTenant(db, tenantId, async (tx) => {
		for (const entry of SKILLS_CATALOGUE) {
			const [existing] = await tx
				.select({ id: skills.id, promptFragment: skills.promptFragment })
				.from(skills)
				.where(and(eq(skills.tenantId, tenantId), eq(skills.slug, entry.slug)));

			if (!existing) {
				await tx
					.insert(skills)
					.values({
						tenantId,
						slug: entry.slug,
						family: entry.family,
						displayName: entry.displayName,
						description: entry.description,
						promptFragment: entry.promptFragment,
						applicableStagesJson: JSON.stringify(entry.applicableStageKinds),
						intent: entry.intent,
						isEnabled: entry.isEnabled,
						createdAt: nowEpoch,
						updatedAt: nowEpoch,
					})
					.onConflictDoNothing();
				seeded++;
			} else if (existing.promptFragment !== entry.promptFragment) {
				await tx
					.update(skills)
					.set({ promptFragment: entry.promptFragment, updatedAt: nowEpoch })
					.where(eq(skills.id, existing.id));
				updated++;
			} else {
				skipped++;
			}
		}
	});

	return { seeded, updated, skipped };
}

export interface AdminFunnelRoutesOpts {
	db: Db;
}

type FunnelRow = typeof funnels.$inferSelect;

async function loadFunnelData(tx: Db, tenantId: number, funnel: FunnelRow) {
	const stages = await tx
		.select()
		.from(stageDefinitions)
		.where(
			and(
				eq(stageDefinitions.tenantId, tenantId),
				eq(stageDefinitions.funnelId, funnel.id),
			),
		)
		.orderBy(asc(stageDefinitions.position));

	const fields =
		stages.length > 0
			? await tx
					.select()
					.from(stageFields)
					.where(
						and(
							eq(stageFields.tenantId, tenantId),
							inArray(
								stageFields.stageId,
								stages.map((s) => s.id),
							),
						),
					)
					.orderBy(asc(stageFields.position))
			: [];

	const fieldsByStage = fields.reduce<Record<number, typeof fields>>(
		(acc, f) => {
			(acc[f.stageId] ??= []).push(f);
			return acc;
		},
		{},
	);

	return {
		funnel: {
			id: funnel.id,
			slug: funnel.slug,
			verticalTemplateId: funnel.verticalTemplateId,
			isActive: funnel.isActive,
		},
		stages: stages.map((s) => ({
			...s,
			fields: fieldsByStage[s.id] ?? [],
		})),
	};
}

export function makeAdminFunnelRoutes(opts: AdminFunnelRoutesOpts): Hono {
	const app = new Hono();

	/**
	 * GET /api/admin/funnel/templates
	 * Returns built-in funnel presets available for creating business directions.
	 */
	app.get("/api/admin/funnel/templates", (c) => {
		return c.json({ items: listFunnelTemplateInfos() });
	});

	/**
	 * GET /api/admin/funnels
	 * Returns all active/inactive business directions for the tenant.
	 */
	app.get("/api/admin/funnels", async (c) => {
		const tenantId = c.var.tenantId;
		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const rows = await tx
				.select()
				.from(funnels)
				.where(eq(funnels.tenantId, tenantId))
				.orderBy(desc(funnels.isActive), asc(funnels.id));

			const stageCounts =
				rows.length > 0
					? await tx
							.select({
								funnelId: stageDefinitions.funnelId,
								stagesCount: count(),
							})
							.from(stageDefinitions)
							.where(
								and(
									eq(stageDefinitions.tenantId, tenantId),
									inArray(
										stageDefinitions.funnelId,
										rows.map((f) => f.id),
									),
								),
							)
							.groupBy(stageDefinitions.funnelId)
					: [];
			const stageCountMap = new Map(
				stageCounts.map((r) => [r.funnelId, Number(r.stagesCount)]),
			);

			const leadCounts =
				rows.length > 0
					? await tx
							.select({
								funnelId: stageDefinitions.funnelId,
								leadsCount: count(),
							})
							.from(leads)
							.innerJoin(
								stageDefinitions,
								eq(leads.stageDefinitionId, stageDefinitions.id),
							)
							.where(
								and(
									eq(leads.tenantId, tenantId),
									inArray(
										stageDefinitions.funnelId,
										rows.map((f) => f.id),
									),
								),
							)
							.groupBy(stageDefinitions.funnelId)
					: [];
			const leadCountMap = new Map(
				leadCounts.map((r) => [r.funnelId, Number(r.leadsCount)]),
			);

			return rows.map((f) => ({
				id: f.id,
				slug: f.slug,
				verticalTemplateId: f.verticalTemplateId,
				isActive: f.isActive,
				stagesCount: stageCountMap.get(f.id) ?? 0,
				leadsCount: leadCountMap.get(f.id) ?? 0,
				createdAt: f.createdAt,
				updatedAt: f.updatedAt,
			}));
		});
		return c.json({ items: result });
	});

	/**
	 * GET /api/admin/funnels/:id
	 * Returns one funnel with stages/fields.
	 */
	app.get("/api/admin/funnels/:id", async (c) => {
		const tenantId = c.var.tenantId;
		const id = Number(c.req.param("id"));
		if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const [funnel] = await tx
				.select()
				.from(funnels)
				.where(and(eq(funnels.tenantId, tenantId), eq(funnels.id, id)))
				.limit(1);
			if (!funnel) return null;
			return loadFunnelData(tx, tenantId, funnel);
		});

		if (!result) return c.json({ error: "funnel not found" }, 404);
		return c.json(result);
	});

	/**
	 * POST /api/admin/funnels
	 * Body: { slug, template? }
	 */
	app.post("/api/admin/funnels", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;
		const body = await c.req
			.json<{ slug?: string; template?: string }>()
			.catch(() => ({}) as { slug?: string; template?: string });
		const slug =
			typeof body.slug === "string"
				? body.slug.trim().toLowerCase().replace(/\s+/g, "_")
				: "";
		if (!slug || !/^[a-z0-9][a-z0-9_-]{1,48}$/.test(slug)) {
			return c.json({ error: "valid slug required" }, 400);
		}

		const template =
			typeof body.template === "string" && body.template in SEED_TEMPLATES
				? body.template
				: "skeleton";
		const verticalTemplateId = seedTemplateVerticalTemplateId(template);
		const templateMeta = FUNNEL_TEMPLATE_META[template];
		if (templateMeta?.isCreatable === false) {
			return c.json(
				{
					error: "template is not creatable as a direction",
					template,
					reason: "service catalog is configured separately from funnels",
				},
				400,
			);
		}
		if (template !== "skeleton") {
			const existing = await withTenant(opts.db, tenantId, (tx) =>
				tx
					.select({ id: funnels.id, slug: funnels.slug })
					.from(funnels)
					.where(
						and(
							eq(funnels.tenantId, tenantId),
							verticalTemplateId
								? or(
										eq(funnels.verticalTemplateId, verticalTemplateId),
										eq(funnels.slug, template),
									)
								: eq(funnels.slug, template),
						),
					)
					.limit(1),
			);
			if (existing[0]) {
				return c.json(
					{
						error: "template already installed",
						funnelId: existing[0].id,
						slug: existing[0].slug,
						template,
						verticalTemplateId,
					},
					409,
				);
			}
		}

		const result = await applyFunnelStages(
			opts.db,
			tenantId,
			SEED_TEMPLATES[template]!,
			slug,
			{ targetSlug: slug },
		);
		if (verticalTemplateId) {
			await withTenant(opts.db, tenantId, (tx) =>
				tx
					.update(funnels)
					.set({ verticalTemplateId, updatedAt: Math.floor(Date.now() / 1000) })
					.where(eq(funnels.id, result.funnelId)),
			);
		}

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "funnel.create",
			targetKind: "funnel",
			targetId: String(result.funnelId),
			details: { slug, template, verticalTemplateId },
		});

		return c.json({ ok: true, ...result, template, verticalTemplateId }, 201);
	});

	/**
	 * PATCH /api/admin/funnels/:id
	 */
	app.patch("/api/admin/funnels/:id", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;
		const id = Number(c.req.param("id"));
		if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
		const body =
			await c.req.json<
				Partial<{
					slug: string;
					isActive: boolean;
					verticalTemplateId: string | null;
				}>
			>();
		const now = Math.floor(Date.now() / 1000);
		const patch: Partial<{
			slug: string;
			isActive: boolean;
			verticalTemplateId: string | null;
			updatedAt: number;
		}> = {
			updatedAt: now,
		};
		if (typeof body.slug === "string")
			patch.slug = body.slug.trim().toLowerCase().replace(/\s+/g, "_");
		if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
		if (body.verticalTemplateId !== undefined)
			patch.verticalTemplateId = body.verticalTemplateId;

		const [updated] = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.update(funnels)
				.set(patch)
				.where(and(eq(funnels.tenantId, tenantId), eq(funnels.id, id)))
				.returning({ id: funnels.id }),
		);
		if (!updated) return c.json({ error: "funnel not found" }, 404);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "funnel.update",
			targetKind: "funnel",
			targetId: String(id),
			details: patch,
		});
		return c.json({ ok: true });
	});

	/**
	 * GET /api/admin/funnel
	 * Возвращает активную воронку тенанта со всеми стадиями и полями.
	 */
	app.get("/api/admin/funnel", async (c) => {
		const tenantId = c.var.tenantId;

		const result = await withTenant(opts.db, tenantId, async (tx) => {
			const [funnel] = await tx
				.select()
				.from(funnels)
				.where(and(eq(funnels.tenantId, tenantId), eq(funnels.isActive, true)))
				.orderBy(asc(funnels.id))
				.limit(1);

			if (!funnel) return null;
			return loadFunnelData(tx, tenantId, funnel);
		});

		if (!result) return c.json({ funnel: null, stages: [] });
		return c.json(result);
	});

	/**
	 * POST /api/admin/funnel/stages
	 * Body: { funnelId, slug, displayName, kind, stageType, position?, color?, icon?,
	 *         description?, staleTimeoutDays?, checkinIntervalDays?, supportMode? }
	 */
	app.post("/api/admin/funnel/stages", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;
		const body = await c.req.json<{
			funnelId: number;
			slug: string;
			displayName: string;
			kind?: string;
			stageType?: string;
			phase?: string;
			position?: number;
			color?: string;
			icon?: string;
			description?: string;
			staleTimeoutDays?: number;
			checkinIntervalDays?: number;
			supportMode?: boolean;
			nextStages?: string[];
		}>();

		if (!body.funnelId || !body.slug || !body.displayName) {
			return c.json({ error: "funnelId, slug, displayName required" }, 400);
		}

		const now = Math.floor(Date.now() / 1000);
		const [stage] = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.insert(stageDefinitions)
				.values({
					tenantId,
					funnelId: body.funnelId,
					slug: body.slug,
					displayName: body.displayName,
					description: body.description ?? undefined,
					position: body.position ?? 0,
					kind: body.kind ?? "active",
					stageType: body.stageType ?? "form_fill",
					phase: body.phase ?? null,
					color: body.color ?? undefined,
					icon: body.icon ?? undefined,
					staleTimeoutDays: body.staleTimeoutDays ?? undefined,
					checkinIntervalDays: body.checkinIntervalDays ?? undefined,
					supportMode: body.supportMode ?? false,
					nextStages: body.nextStages ?? [],
					createdAt: now,
					updatedAt: now,
				})
				.returning(),
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "stage.create",
			targetKind: "stage_definition",
			targetId: String(stage?.id),
			details: { slug: body.slug },
		});

		return c.json(stage, 201);
	});

	/**
	 * PATCH /api/admin/funnel/stages/:stageId
	 */
	app.patch("/api/admin/funnel/stages/:stageId", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;
		const stageId = Number(c.req.param("stageId"));
		if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

		const body =
			await c.req.json<
				Partial<{
					displayName: string;
					description: string;
					kind: string;
					stageType: string;
					phase: string;
					position: number;
					color: string;
					icon: string;
					staleTimeoutDays: number;
					checkinIntervalDays: number;
					supportMode: boolean;
					nextStages: string[];
					configJson: string;
					goal: string | null;
					guidance: string | null;
					autoAdvanceCondition: string | null;
					partnerWebhookUrl: string | null;
					partnerWebhookMode: string;
				}>
			>();

		const now = Math.floor(Date.now() / 1000);
		const patch: Record<string, unknown> = { updatedAt: now };
		if (body.displayName !== undefined) patch.displayName = body.displayName;
		if (body.description !== undefined) patch.description = body.description;
		if (body.kind !== undefined) patch.kind = body.kind;
		if (body.stageType !== undefined) patch.stageType = body.stageType;
		if (body.phase !== undefined) patch.phase = body.phase;
		if (body.position !== undefined) patch.position = body.position;
		if (body.color !== undefined) patch.color = body.color;
		if (body.icon !== undefined) patch.icon = body.icon;
		if (body.staleTimeoutDays !== undefined)
			patch.staleTimeoutDays = body.staleTimeoutDays;
		if (body.checkinIntervalDays !== undefined)
			patch.checkinIntervalDays = body.checkinIntervalDays;
		if (body.supportMode !== undefined) patch.supportMode = body.supportMode;
		if (body.nextStages !== undefined) patch.nextStages = body.nextStages;
		if (body.configJson !== undefined) patch.configJson = body.configJson;
		if (body.goal !== undefined) patch.goal = body.goal;
		if (body.guidance !== undefined) patch.guidance = body.guidance;
		if (body.autoAdvanceCondition !== undefined)
			patch.autoAdvanceCondition = body.autoAdvanceCondition;
		if (body.partnerWebhookUrl !== undefined)
			patch.partnerWebhookUrl = body.partnerWebhookUrl;
		if (body.partnerWebhookMode !== undefined)
			patch.partnerWebhookMode = body.partnerWebhookMode;

		await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.update(stageDefinitions)
				// biome-ignore lint/suspicious/noExplicitAny: dynamic patch object
				.set(patch as any)
				.where(
					and(
						eq(stageDefinitions.id, stageId),
						eq(stageDefinitions.tenantId, tenantId),
					),
				),
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "stage.update",
			targetKind: "stage_definition",
			targetId: String(stageId),
		});

		return c.json({ ok: true });
	});

	/**
	 * DELETE /api/admin/funnel/stages/:stageId
	 */
	app.delete("/api/admin/funnel/stages/:stageId", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;
		const stageId = Number(c.req.param("stageId"));
		if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

		await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.delete(stageDefinitions)
				.where(
					and(
						eq(stageDefinitions.id, stageId),
						eq(stageDefinitions.tenantId, tenantId),
					),
				),
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "stage.delete",
			targetKind: "stage_definition",
			targetId: String(stageId),
		});

		return c.json({ ok: true });
	});

	/**
	 * PATCH /api/admin/funnel/stages/reorder
	 * Body: { order: Array<{ id: number, position: number }> }
	 */
	app.patch("/api/admin/funnel/stages/reorder", async (c) => {
		const tenantId = c.var.tenantId;
		const { order } = await c.req.json<{
			order: Array<{ id: number; position: number }>;
		}>();
		if (!Array.isArray(order))
			return c.json({ error: "order array required" }, 400);

		const now = Math.floor(Date.now() / 1000);
		await withTenant(opts.db, tenantId, async (tx) => {
			for (const { id, position } of order) {
				await tx
					.update(stageDefinitions)
					.set({ position, updatedAt: now })
					.where(
						and(
							eq(stageDefinitions.id, id),
							eq(stageDefinitions.tenantId, tenantId),
						),
					);
			}
		});

		return c.json({ ok: true });
	});

	// ── Stage fields ──────────────────────────────────────────────────────────

	/**
	 * POST /api/admin/funnel/stages/:stageId/fields
	 */
	app.post("/api/admin/funnel/stages/:stageId/fields", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;
		const stageId = Number(c.req.param("stageId"));
		if (!Number.isFinite(stageId)) return c.json({ error: "bad stageId" }, 400);

		const body = await c.req.json<{
			slug: string;
			displayName: string;
			fieldType?: string;
			required?: boolean;
			position?: number;
			hint?: string;
			aiExtractable?: boolean;
			optionsJson?: string;
			validationJson?: string;
		}>();

		if (!body.slug || !body.displayName) {
			return c.json({ error: "slug, displayName required" }, 400);
		}

		const now = Math.floor(Date.now() / 1000);
		const [field] = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.insert(stageFields)
				.values({
					stageId,
					tenantId,
					slug: body.slug,
					displayName: body.displayName,
					fieldType: body.fieldType ?? "text",
					required: body.required ?? false,
					position: body.position ?? 0,
					hint: body.hint ?? null,
					aiExtractable: body.aiExtractable ?? false,
					optionsJson: body.optionsJson ?? "[]",
					validationJson: body.validationJson ?? "{}",
					createdAt: now,
				})
				.returning(),
		);

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "stage_field.create",
			targetKind: "stage_field",
			targetId: String(field?.id),
		});

		return c.json(field, 201);
	});

	/**
	 * PATCH /api/admin/funnel/stages/:stageId/fields/:fieldId
	 */
	app.patch("/api/admin/funnel/stages/:stageId/fields/:fieldId", async (c) => {
		const tenantId = c.var.tenantId;
		const fieldId = Number(c.req.param("fieldId"));
		if (!Number.isFinite(fieldId)) return c.json({ error: "bad fieldId" }, 400);

		const body =
			await c.req.json<
				Partial<{
					displayName: string;
					fieldType: string;
					required: boolean;
					position: number;
					hint: string;
					aiExtractable: boolean;
					optionsJson: string;
					validationJson: string;
				}>
			>();

		const patch: Record<string, unknown> = {};
		if (body.displayName !== undefined) patch.displayName = body.displayName;
		if (body.fieldType !== undefined) patch.fieldType = body.fieldType;
		if (body.required !== undefined) patch.required = body.required;
		if (body.position !== undefined) patch.position = body.position;
		if (body.hint !== undefined) patch.hint = body.hint;
		if (body.aiExtractable !== undefined)
			patch.aiExtractable = body.aiExtractable;
		if (body.optionsJson !== undefined) patch.optionsJson = body.optionsJson;
		if (body.validationJson !== undefined)
			patch.validationJson = body.validationJson;

		await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.update(stageFields)
				// biome-ignore lint/suspicious/noExplicitAny: dynamic patch
				.set(patch as any)
				.where(
					and(eq(stageFields.id, fieldId), eq(stageFields.tenantId, tenantId)),
				),
		);

		return c.json({ ok: true });
	});

	/**
	 * DELETE /api/admin/funnel/stages/:stageId/fields/:fieldId
	 */
	app.delete("/api/admin/funnel/stages/:stageId/fields/:fieldId", async (c) => {
		const tenantId = c.var.tenantId;
		const fieldId = Number(c.req.param("fieldId"));
		if (!Number.isFinite(fieldId)) return c.json({ error: "bad fieldId" }, 400);

		await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.delete(stageFields)
				.where(
					and(eq(stageFields.id, fieldId), eq(stageFields.tenantId, tenantId)),
				),
		);

		return c.json({ ok: true });
	});

	// ── Seed templates ───────────────────────────────────────────────────────

	/**
	 * POST /api/admin/funnel/seed
	 * Body: { template: "visa" | "real_estate" | "modeling" }
	 * Создаёт или заменяет воронку из предустановленного шаблона.
	 * Если у тенанта уже есть активная воронка — добавляет стадии/поля к ней;
	 * если нет — создаёт новую воронку со slug = template.
	 */
	app.post("/api/admin/funnel/seed", async (c) => {
		const tenantId = c.var.tenantId;
		const adminId = (c.var.adminId as number | null) ?? undefined;

		const body = await c.req.json<{ template: string }>();
		const stages = SEED_TEMPLATES[body.template];
		if (!stages) {
			return c.json(
				{
					error: `Unknown template. Available: ${Object.keys(SEED_TEMPLATES).join(", ")}`,
				},
				400,
			);
		}

		const now = Math.floor(Date.now() / 1000);
		const verticalTemplateId = seedTemplateVerticalTemplateId(body.template);

		const result = await withTenant(opts.db, tenantId, async (tx) => {
			// Найти или создать отдельную воронку под шаблон. Это сохраняет уже
			// установленную обменку/недвижку/продукт как самостоятельные направления.
			let [funnel] = await tx
				.select()
				.from(funnels)
				.where(
					and(eq(funnels.tenantId, tenantId), eq(funnels.slug, body.template)),
				)
				.limit(1);

			if (!funnel) {
				const [created] = await tx
					.insert(funnels)
					.values({
						tenantId,
						slug: body.template,
						verticalTemplateId,
						isActive: true,
						createdAt: now,
						updatedAt: now,
					})
					.returning();
				funnel = created!;
			} else if (verticalTemplateId) {
				await tx
					.update(funnels)
					.set({ verticalTemplateId, updatedAt: now })
					.where(eq(funnels.id, funnel.id));
			}

			// Удалить существующие стадии этой воронки (полная замена)
			const existingStages = await tx
				.select({ id: stageDefinitions.id })
				.from(stageDefinitions)
				.where(eq(stageDefinitions.funnelId, funnel.id));

			for (const s of existingStages) {
				await tx.delete(stageFields).where(eq(stageFields.stageId, s.id));
			}
			if (existingStages.length > 0) {
				await tx
					.delete(stageDefinitions)
					.where(eq(stageDefinitions.funnelId, funnel.id));
			}

			// Вставить стадии и поля из шаблона
			const createdStages: Array<{ id: number; slug: string }> = [];
			for (const stageTpl of stages) {
				const { fields, ...stageData } = stageTpl;
				const [stage] = await tx
					.insert(stageDefinitions)
					.values({
						tenantId,
						funnelId: funnel.id,
						slug: stageData.slug,
						displayName: stageData.displayName,
						kind: stageData.kind,
						stageType: stageData.stageType,
						position: stageData.position,
						color: stageData.color ?? null,
						staleTimeoutDays: stageData.staleTimeoutDays ?? null,
						nextStages: stageData.nextStages,
						autoAdvanceCondition: stageData.autoAdvanceCondition ?? null,
						supportMode: stageData.supportMode ?? false,
						createdAt: now,
						updatedAt: now,
					})
					.returning({ id: stageDefinitions.id, slug: stageDefinitions.slug });

				if (!stage) continue;
				createdStages.push(stage);

				for (const fieldTpl of fields) {
					await tx.insert(stageFields).values({
						stageId: stage.id,
						tenantId,
						slug: fieldTpl.slug,
						displayName: fieldTpl.displayName,
						fieldType: fieldTpl.fieldType,
						required: fieldTpl.required,
						aiExtractable: fieldTpl.aiExtractable,
						hint: fieldTpl.hint ?? null,
						...(fieldTpl.optionsJson
							? { optionsJson: fieldTpl.optionsJson }
							: {}),
						position: fieldTpl.position,
						createdAt: now,
					});
				}
			}

			return { funnelId: funnel.id, stagesCreated: createdStages.length };
		});

		await recordAudit(opts.db, {
			tenantId,
			adminId,
			action: "funnel.seed",
			targetKind: "funnel",
			targetId: String(result.funnelId),
			details: {
				template: body.template,
				stagesCreated: result.stagesCreated,
				verticalTemplateId,
			},
		});

		return c.json({ ok: true, ...result, verticalTemplateId });
	});

	// ── Skills ────────────────────────────────────────────────────────────────

	/**
	 * GET /api/admin/funnel/analytics
	 * Per-stage funnel analytics: current leads, entries, exits, avg time in stage.
	 */
	app.get("/api/admin/funnel/analytics", async (c) => {
		const tenantId = c.var.tenantId;
		const funnelIdRaw = c.req.query("funnelId");
		const funnelId = funnelIdRaw ? Number(funnelIdRaw) : null;
		if (funnelIdRaw && !Number.isFinite(funnelId))
			return c.json({ error: "bad funnelId" }, 400);

		const stages = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select({
					id: stageDefinitions.id,
					slug: stageDefinitions.slug,
					displayName: stageDefinitions.displayName,
					kind: stageDefinitions.kind,
					color: stageDefinitions.color,
					position: stageDefinitions.position,
				})
				.from(stageDefinitions)
				.where(
					funnelId
						? and(
								eq(stageDefinitions.tenantId, tenantId),
								eq(stageDefinitions.funnelId, funnelId),
							)
						: eq(stageDefinitions.tenantId, tenantId),
				)
				.orderBy(asc(stageDefinitions.position)),
		);

		if (stages.length === 0) return c.json({ stages: [] });

		// Leads currently in each stage
		const currentCounts = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select({
					stageDefinitionId: leads.stageDefinitionId,
					n: count(),
				})
				.from(leads)
				.where(eq(leads.tenantId, tenantId))
				.groupBy(leads.stageDefinitionId),
		);
		const currentMap = new Map(
			currentCounts.map((r) => [r.stageDefinitionId, Number(r.n)]),
		);

		// Entries per stage slug (toState events)
		const entryCounts = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select({ toState: leadEvents.toState, n: count() })
				.from(leadEvents)
				.where(eq(leadEvents.tenantId, tenantId))
				.groupBy(leadEvents.toState),
		);
		const entryMap = new Map(entryCounts.map((r) => [r.toState, Number(r.n)]));

		// Average time in stage: for each (lead, stageSlug) entry event, find the
		// next exit event and compute duration. Aggregated per stageSlug.
		const avgTimeRows = await withTenant(opts.db, tenantId, async (tx) =>
			tx.execute(sql`
        SELECT
          e_in.to_state AS slug,
          AVG(e_out.created_at - e_in.created_at)::float AS avg_seconds
        FROM lead_events e_in
        JOIN LATERAL (
          SELECT created_at
          FROM lead_events
          WHERE lead_id = e_in.lead_id
            AND from_state = e_in.to_state
            AND created_at > e_in.created_at
          ORDER BY created_at ASC
          LIMIT 1
        ) e_out ON TRUE
        WHERE e_in.tenant_id = ${tenantId}
        GROUP BY e_in.to_state
      `),
		);
		const avgMap = new Map<string, number>();
		for (const row of avgTimeRows as unknown as Array<{
			slug: string;
			avg_seconds: number | null;
		}>) {
			if (row.avg_seconds !== null) {
				avgMap.set(row.slug, row.avg_seconds / 86400); // seconds → days
			}
		}

		const result = stages.map((s) => ({
			id: s.id,
			slug: s.slug,
			displayName: s.displayName,
			kind: s.kind,
			color: s.color,
			position: s.position,
			leadsCurrent: currentMap.get(s.id) ?? 0,
			leadsEntered: entryMap.get(s.slug) ?? 0,
			avgDaysInStage: avgMap.has(s.slug)
				? Math.round(avgMap.get(s.slug)! * 10) / 10
				: null,
		}));

		return c.json({ stages: result });
	});

	/**
	 * GET /api/admin/funnel/phase-stats
	 * Сквозная воронка по макро-фазам костяка (capture → … → won/lost).
	 * Группирует лидов по effectivePhase их текущей стадии. Метрика
	 * vertical-agnostic — сопоставима между любыми вертикалями.
	 */
	app.get("/api/admin/funnel/phase-stats", async (c) => {
		const tenantId = c.var.tenantId;

		const stages = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select({
					id: stageDefinitions.id,
					kind: stageDefinitions.kind,
					phase: stageDefinitions.phase,
				})
				.from(stageDefinitions)
				.where(eq(stageDefinitions.tenantId, tenantId)),
		);

		const counts = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select({ stageDefinitionId: leads.stageDefinitionId, n: count() })
				.from(leads)
				.where(eq(leads.tenantId, tenantId))
				.groupBy(leads.stageDefinitionId),
		);

		// stageDefinitionId → фаза костяка (capture/won/lost из kind, остальное из phase)
		const phaseByStage = new Map<number, FunnelPhase | null>();
		for (const s of stages) phaseByStage.set(s.id, effectivePhase(s));

		const totals = new Map<FunnelPhase, number>();
		let unassigned = 0;
		for (const r of counts) {
			const n = Number(r.n);
			const p =
				r.stageDefinitionId != null
					? phaseByStage.get(r.stageDefinitionId)
					: null;
			if (p) totals.set(p, (totals.get(p) ?? 0) + n);
			else unassigned += n;
		}

		const phases = FUNNEL_PHASES.map((phase) => ({
			phase,
			leads: totals.get(phase) ?? 0,
		}));

		return c.json({ phases, unassigned });
	});

	/**
	 * GET /api/admin/skills
	 * Полный список скилов тенанта с ELO-рейтингами.
	 */
	app.get("/api/admin/skills", async (c) => {
		const tenantId = c.var.tenantId;

		const rows = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select()
				.from(skills)
				.where(eq(skills.tenantId, tenantId))
				.orderBy(asc(skills.family), asc(skills.displayName)),
		);

		return c.json({ items: rows });
	});

	/**
	 * POST /api/admin/skills/seed
	 * Засевает каталог навыков из SKILLS_CATALOGUE.
	 * Новые slug'и → INSERT, изменившиеся promptFragment → UPDATE.
	 * Удалённые из каталога slug'и — НЕ трогаются (data stays).
	 * Returns: { seeded, updated, skipped }
	 */
	app.post("/api/admin/skills/seed", async (c) => {
		const tenantId = c.var.tenantId;
		const nowEpoch = Math.floor(Date.now() / 1000);

		let seeded = 0;
		let updated = 0;
		let skipped = 0;

		await withTenant(opts.db, tenantId, async (tx) => {
			for (const entry of SKILLS_CATALOGUE) {
				const [existing] = await tx
					.select({ id: skills.id, promptFragment: skills.promptFragment })
					.from(skills)
					.where(
						and(eq(skills.tenantId, tenantId), eq(skills.slug, entry.slug)),
					);

				if (!existing) {
					await tx
						.insert(skills)
						.values({
							tenantId,
							slug: entry.slug,
							family: entry.family,
							displayName: entry.displayName,
							description: entry.description,
							promptFragment: entry.promptFragment,
							applicableStagesJson: JSON.stringify(entry.applicableStageKinds),
							intent: entry.intent,
							isEnabled: entry.isEnabled,
							createdAt: nowEpoch,
							updatedAt: nowEpoch,
						})
						.onConflictDoNothing();
					seeded++;
				} else if (existing.promptFragment !== entry.promptFragment) {
					await tx
						.update(skills)
						.set({ promptFragment: entry.promptFragment, updatedAt: nowEpoch })
						.where(eq(skills.id, existing.id));
					updated++;
				} else {
					skipped++;
				}
			}
		});

		return c.json({
			ok: true,
			seeded,
			updated,
			skipped,
			total: SKILLS_CATALOGUE.length,
		});
	});

	/**
	 * PATCH /api/admin/skills/:slug
	 * Обновить isEnabled и/или promptFragment конкретного навыка.
	 * Body: { isEnabled?: boolean, promptFragment?: string }
	 */
	app.patch("/api/admin/skills/:slug", async (c) => {
		const tenantId = c.var.tenantId;
		const slug = c.req.param("slug");

		let body: { isEnabled?: unknown; promptFragment?: unknown };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		const hasIsEnabled = typeof body.isEnabled === "boolean";
		const hasPromptFragment =
			typeof body.promptFragment === "string" &&
			body.promptFragment.trim().length > 0;
		if (!hasIsEnabled && !hasPromptFragment) {
			return c.json({ error: "nothing to update" }, 400);
		}

		const setValues: {
			updatedAt: number;
			isEnabled?: boolean;
			promptFragment?: string;
		} = { updatedAt: Math.floor(Date.now() / 1000) };
		if (hasIsEnabled) setValues.isEnabled = body.isEnabled as boolean;
		if (hasPromptFragment)
			setValues.promptFragment = (body.promptFragment as string).trim();

		const updated = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.update(skills)
				.set(setValues)
				.where(and(eq(skills.tenantId, tenantId), eq(skills.slug, slug)))
				.returning({ id: skills.id }),
		);

		if (updated.length === 0) return c.json({ error: "skill not found" }, 404);
		return c.json({ ok: true });
	});

	/**
	 * GET /api/admin/styles
	 * Список стилей тенанта (не удалённых).
	 */
	app.get("/api/admin/styles", async (c) => {
		const tenantId = c.var.tenantId;

		const rows = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select()
				.from(styles)
				.where(and(eq(styles.tenantId, tenantId), isNull(styles.deletedAt)))
				.orderBy(asc(styles.slug), asc(styles.version)),
		);

		return c.json({ items: rows });
	});

	/**
	 * GET /api/admin/experiments
	 * Список экспериментов тенанта.
	 */
	app.get("/api/admin/experiments", async (c) => {
		const tenantId = c.var.tenantId;

		const rows = await withTenant(opts.db, tenantId, async (tx) =>
			tx
				.select()
				.from(experiments)
				.where(eq(experiments.tenantId, tenantId))
				.orderBy(asc(experiments.createdAt)),
		);

		return c.json({ items: rows });
	});

	return app;
}
