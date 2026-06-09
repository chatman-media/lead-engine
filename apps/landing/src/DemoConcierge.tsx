import { useState } from "react";
import {
	DEMO_URL,
	Footer,
	type Lang,
	Nav,
	SIGNUP_URL,
	TelegramMockup,
	type TgMessage,
} from "./shared.tsx";

// Multi-service demo: one inbound message can turn into several operational
// requests, each with its own fields, stage, offer logic and human handoff.

type L = { ru: string; en: string };
const t = (v: L, lang: Lang) => v[lang];

const COPY = {
	ru: {
		bannerTag: "Live demo",
		banner:
			"Один AI front office для бизнеса, который продаёт не одну услугу, а целый набор операций.",
		title: ["Один AI-пульт ведёт ", "весь набор услуг"],
		sub: "Клиент пишет одним сообщением: трансфер, уборка, массаж, салон красоты, бронь жилья, обмен, срочный ремонт, кастомный оффер. AI разбирает хаос на отдельные заявки, собирает поля, считает следующий шаг и зовёт человека только в точку решения.",
		ctaPrimary: "Собрать свой набор услуг",
		ctaSecondary: "Обсудить workflow",
		kpiTitle: "Service ops сегодня",
		boardLabel: "Операционный пульт",
		boardTitle: "Не один сценарий. Параллельные workflows по всем услугам.",
		boardSub:
			"Каждая карточка знает тип услуги, недостающие поля, статус, деньги и кто должен принять решение. Один клиент может иметь несколько заявок одновременно.",
		dialogLabel: "Входящее сообщение",
		dialogTitle: "AI дробит один чат на несколько заявок",
		dialogSub:
			"Клиент не обязан выбирать форму. Он пишет как привык. Система сама понимает, что внутри сообщения три разные операции, и ведёт каждую по своему workflow.",
		handoffLabel: "Human handoff",
		handoffTitle: "Человек подключается не в чат, а в точку решения",
		handoffSub:
			"Менеджер не читает всю переписку. Он получает короткую карточку: что клиент хочет, какие поля собраны, какое решение нужно и сколько времени осталось.",
		marketLabel: "Provider marketplace",
		marketTitle: "Подключай исполнителей услуг из витрины",
		marketSub:
			"Трансфер, уборка, массаж, салон, жильё или свой провайдер: добавил в marketplace — услуга появилась в каталоге, AI понял поля заявки, оператор получил handoff, провайдер подтвердил слот.",
		marketInstall: "Добавить провайдера",
		marketRoute: "AI route",
		marketHandoff: "provider handoff",
		svcLabel: "Набор услуг",
		svcTitle: "Покажи бизнес как систему, а не как бота",
		svcSub:
			"Каждая услуга получает свои поля, правила, цены, источники знаний и стадии. Всё это живёт в одной панели, а не в десяти чатах.",
		svcType: "Поток",
		svcFields: "Поля",
		svcDecision: "Где нужен человек",
		svcOwner: "После решения",
		ctaTitle: "Нужно показать не бота, а операционную машину?",
		ctaSub:
			"Опиши, какие услуги продаёшь. Lead Engine соберёт ветки, поля, handoff-правила и поведение AI под твой бизнес.",
		notify:
			"AI создал 5 заявок из одного сообщения: transfer, cleaning, massage, beauty, housing",
		ctaBubble: "Открыть заявки в ops board →",
		botName: "Lead Engine Ops",
		footer: {
			privacy: "Политика конфиденциальности",
			terms: "Условия использования",
			copy: "© 2026 Lead Engine",
		},
	},
	en: {
		bannerTag: "Live demo",
		banner:
			"One AI front office for businesses that sell a full set of operations, not a single service.",
		title: ["One AI control tower runs ", "your entire service stack"],
		sub: "A client writes one messy message: transfer, cleaning, massage, beauty salon, housing booking, exchange, urgent maintenance, custom offer. AI splits the chaos into separate requests, collects fields, calculates the next step and brings in a human only where judgment is needed.",
		ctaPrimary: "Build my service stack",
		ctaSecondary: "Discuss workflow",
		kpiTitle: "Service ops today",
		boardLabel: "Operations board",
		boardTitle: "Not one script. Parallel workflows across every service.",
		boardSub:
			"Every card knows the service type, missing fields, status, money and the decision owner. One client can run several requests at the same time.",
		dialogLabel: "Inbound message",
		dialogTitle: "AI splits one chat into multiple requests",
		dialogSub:
			"The client does not need to pick a form. They write naturally. The system detects three separate operations inside the message and runs each through its own workflow.",
		handoffLabel: "Human handoff",
		handoffTitle: "Humans join the decision point, not the whole chat",
		handoffSub:
			"A manager does not read the entire thread. They get a compact card: what the client wants, which fields are collected, what decision is needed and how much time is left.",
		marketLabel: "Provider marketplace",
		marketTitle: "Connect service providers from the marketplace",
		marketSub:
			"Transfer, cleaning, massage, salon, housing or your own provider: install it from the marketplace, the service appears in the catalog, AI knows the request fields, the operator gets the handoff and the provider confirms the slot.",
		marketInstall: "Add provider",
		marketRoute: "AI route",
		marketHandoff: "provider handoff",
		svcLabel: "Service stack",
		svcTitle: "Show the business as a system, not as a bot",
		svcSub:
			"Every service gets its own fields, rules, prices, knowledge sources and stages. Everything lives in one board instead of ten chats.",
		svcType: "Flow",
		svcFields: "Fields",
		svcDecision: "Human decision",
		svcOwner: "After decision",
		ctaTitle: "Need to show an operating machine, not a chatbot?",
		ctaSub:
			"Describe the services you sell. Lead Engine builds branches, fields, handoff rules and AI behavior around your business.",
		notify:
			"AI created 5 requests from one message: transfer, cleaning, massage, beauty, housing",
		ctaBubble: "Open requests in ops board →",
		botName: "Lead Engine Ops",
		footer: {
			privacy: "Privacy Policy",
			terms: "Terms of Use",
			copy: "© 2026 Lead Engine",
		},
	},
};

const SERVICE_STRIP: (L & { href: string })[] = [
	{ ru: "трансфер", en: "transfer", href: "/demo/workflows/transfer" },
	{ ru: "уборка", en: "cleaning", href: "/demo/workflows/cleaning" },
	{ ru: "массаж", en: "massage", href: "/demo/workflows/massage" },
	{
		ru: "салон красоты",
		en: "beauty salon",
		href: "/demo/workflows/beauty",
	},
	{
		ru: "бронь жилья",
		en: "housing booking",
		href: "/demo/workflows/housing",
	},
	{ ru: "exchange", en: "exchange", href: "/demo/workflows/exchange" },
	{ ru: "custom offer", en: "custom offer", href: "/demo/workflows/custom" },
	{ ru: "vertical demos", en: "vertical demos", href: "/demo/verticals" },
];

const KPIS: { value: string; label: L; trend?: string }[] = [
	{
		value: "84",
		label: { ru: "заявки сегодня", en: "requests today" },
		trend: "+18%",
	},
	{ value: "21", label: { ru: "workflow в работе", en: "active workflows" } },
	{ value: "6", label: { ru: "ждут человека", en: "need a human" } },
	{
		value: "$38.7k",
		label: { ru: "service pipeline", en: "service pipeline" },
		trend: "+11%",
	},
	{ value: "19 сек", label: { ru: "ср. ответ", en: "avg. response" } },
];

const PHASES: { key: string; title: L; accent: string }[] = [
	{
		key: "capture",
		title: { ru: "Входящие", en: "Inbound" },
		accent: "#6aa6ff",
	},
	{ key: "split", title: { ru: "Разбор", en: "Split" }, accent: "#95c1ff" },
	{ key: "fields", title: { ru: "Поля", en: "Fields" }, accent: "#5fd0c8" },
	{ key: "offer", title: { ru: "Оффер", en: "Offer" }, accent: "#c4b5fd" },
	{ key: "human", title: { ru: "Решение", en: "Decision" }, accent: "#fbbf77" },
	{ key: "done", title: { ru: "Готово", en: "Done" }, accent: "#91d990" },
];

type Lead = {
	phase: string;
	who: string;
	dir: L;
	amt: string;
	note: L;
	time: string;
	tag: L;
};

const LEADS: Lead[] = [
	{
		phase: "capture",
		who: "@max_live",
		dir: { ru: "5 услуг в одном сообщении", en: "5 services in one message" },
		amt: "—",
		note: {
			ru: "«Трансфер, уборка, массаж, салон и жильё»",
			en: "“Transfer, cleaning, massage, salon and housing”",
		},
		time: "now",
		tag: { ru: "multi", en: "multi" },
	},
	{
		phase: "capture",
		who: "+66 82 *** 014",
		dir: { ru: "срочный ремонт кондиционера", en: "urgent AC repair" },
		amt: "—",
		note: {
			ru: "клиент прислал фото и адрес",
			en: "client sent photo and address",
		},
		time: "2м",
		tag: { ru: "repair", en: "repair" },
	},
	{
		phase: "capture",
		who: "@olga_stay",
		dir: { ru: "бронь жилья · 2 спальни", en: "housing · 2 bedrooms" },
		amt: "—",
		note: {
			ru: "нужна вилла 12–19 июня, до ฿90k",
			en: "needs villa Jun 12–19, up to ฿90k",
		},
		time: "4м",
		tag: { ru: "housing", en: "housing" },
	},
	{
		phase: "capture",
		who: "@kate_spa",
		dir: { ru: "массаж сегодня", en: "massage today" },
		amt: "—",
		note: {
			ru: "2 человека, выезд в апартаменты",
			en: "2 people, therapist to apartment",
		},
		time: "6м",
		tag: { ru: "massage", en: "massage" },
	},
	{
		phase: "split",
		who: "@max_live",
		dir: {
			ru: "transfer + cleaning + massage + beauty + housing",
			en: "transfer + cleaning + massage + beauty + housing",
		},
		amt: "5 cards",
		note: {
			ru: "AI создал 5 отдельных заявок",
			en: "AI created 5 separate requests",
		},
		time: "1м",
		tag: { ru: "AI split", en: "AI split" },
	},
	{
		phase: "split",
		who: "@maya_family",
		dir: { ru: "няня + экскурсия + уборка", en: "nanny + tour + cleaning" },
		amt: "฿7 800",
		note: {
			ru: "связал услуги с одним клиентом",
			en: "linked services to one client",
		},
		time: "5м",
		tag: { ru: "bundle", en: "bundle" },
	},
	{
		phase: "split",
		who: "@irina_beauty",
		dir: { ru: "салон + трансфер", en: "beauty salon + transfer" },
		amt: "฿2 900",
		note: {
			ru: "AI разделил запись и поездку",
			en: "AI split appointment and ride",
		},
		time: "7м",
		tag: { ru: "beauty", en: "beauty" },
	},
	{
		phase: "fields",
		who: "@max_live",
		dir: { ru: "трансфер · минивэн", en: "transfer · minivan" },
		amt: "฿1 200",
		note: {
			ru: "собираем рейс, время, пассажиров",
			en: "collecting flight, time, passengers",
		},
		time: "3м",
		tag: { ru: "fields", en: "fields" },
	},
	{
		phase: "fields",
		who: "@kate_spa",
		dir: {
			ru: "массаж · oil / deep tissue",
			en: "massage · oil / deep tissue",
		},
		amt: "฿2 400",
		note: {
			ru: "собираем адрес, слот, тип массажа",
			en: "collecting address, slot, massage type",
		},
		time: "5м",
		tag: { ru: "massage", en: "massage" },
	},
	{
		phase: "fields",
		who: "@dmitry_ops",
		dir: { ru: "уборка · checkout", en: "cleaning · checkout" },
		amt: "฿1 450",
		note: {
			ru: "нужны адрес, доступ и объём",
			en: "needs address, access and scope",
		},
		time: "6м",
		tag: { ru: "cleaning", en: "cleaning" },
	},
	{
		phase: "fields",
		who: "+66 82 *** 014",
		dir: { ru: "ремонт · кондиционер", en: "maintenance · AC" },
		amt: "—",
		note: { ru: "нужны фото шильдика и слот", en: "needs unit photo and slot" },
		time: "6м",
		tag: { ru: "photo", en: "photo" },
	},
	{
		phase: "offer",
		who: "@max_live",
		dir: { ru: "USDT TRC20 → THB", en: "USDT TRC20 → THB" },
		amt: "฿16 600",
		note: {
			ru: "курс и реквизиты готовы",
			en: "rate and payment details ready",
		},
		time: "4м",
		tag: { ru: "exchange", en: "exchange" },
	},
	{
		phase: "offer",
		who: "@maya_family",
		dir: { ru: "острова · приватный тур", en: "islands · private tour" },
		amt: "฿12 400",
		note: {
			ru: "AI собрал бюджет и даты",
			en: "AI collected budget and dates",
		},
		time: "9м",
		tag: { ru: "tour", en: "tour" },
	},
	{
		phase: "offer",
		who: "@olga_stay",
		dir: { ru: "вилла · 2 спальни · Kata", en: "villa · 2 bedrooms · Kata" },
		amt: "฿84 000",
		note: {
			ru: "3 объекта подобраны, ждём выбор",
			en: "3 listings matched, awaiting choice",
		},
		time: "10м",
		tag: { ru: "housing", en: "housing" },
	},
	{
		phase: "offer",
		who: "@irina_beauty",
		dir: { ru: "салон · hair + nails", en: "salon · hair + nails" },
		amt: "฿2 300",
		note: {
			ru: "слот 16:30 и мастер готовы",
			en: "16:30 slot and specialist ready",
		},
		time: "12м",
		tag: { ru: "beauty", en: "beauty" },
	},
	{
		phase: "human",
		who: "@max_live",
		dir: { ru: "ужин · кастомное меню", en: "dinner · custom menu" },
		amt: "฿8 900",
		note: {
			ru: "нужна цена шефа и депозит",
			en: "needs chef price and deposit",
		},
		time: "11м",
		tag: { ru: "human", en: "human" },
	},
	{
		phase: "human",
		who: "@sasha_re",
		dir: { ru: "объект · VIP-показ", en: "property · VIP viewing" },
		amt: "$420k",
		note: {
			ru: "менеджер подтверждает слот",
			en: "manager confirms viewing slot",
		},
		time: "14м",
		tag: { ru: "VIP", en: "VIP" },
	},
	{
		phase: "human",
		who: "@kate_spa",
		dir: { ru: "массаж · выездной мастер", en: "massage · mobile therapist" },
		amt: "฿2 400",
		note: {
			ru: "нужно подтвердить мастера и депозит",
			en: "needs therapist confirmation and deposit",
		},
		time: "16м",
		tag: { ru: "human", en: "human" },
	},
	{
		phase: "done",
		who: "@nina_beauty",
		dir: { ru: "клиника · запись", en: "clinic · booking" },
		amt: "฿3 500",
		note: {
			ru: "анкета собрана, слот забронирован",
			en: "intake collected, slot booked",
		},
		time: "32м",
		tag: { ru: "won", en: "won" },
	},
	{
		phase: "done",
		who: "@dmitry_ops",
		dir: { ru: "уборка + laundry", en: "cleaning + laundry" },
		amt: "฿1 450",
		note: { ru: "исполнитель назначен", en: "operator assigned" },
		time: "1ч",
		tag: { ru: "done", en: "done" },
	},
	{
		phase: "done",
		who: "@max_live",
		dir: { ru: "трансфер · airport pickup", en: "transfer · airport pickup" },
		amt: "฿1 200",
		note: {
			ru: "водитель назначен, клиент получил детали",
			en: "driver assigned, client got details",
		},
		time: "1ч",
		tag: { ru: "transfer", en: "transfer" },
	},
];

const HANDOFFS: { title: L; desc: L; meta: L }[] = [
	{
		title: { ru: "Кастомная цена", en: "Custom price" },
		desc: {
			ru: "AI собрал вводные, бюджет, сроки и фото. Менеджеру осталось поставить цену.",
			en: "AI collected context, budget, timing and photos. Manager only needs to price it.",
		},
		meta: { ru: "ответ нужен: 8 мин", en: "reply due: 8 min" },
	},
	{
		title: { ru: "QR / оплата", en: "QR / payment" },
		desc: {
			ru: "Клиент дошёл до оплаты. Человек подтверждает пруф, AI продолжает диалог.",
			en: "Client reached payment. Human confirms proof, AI continues the conversation.",
		},
		meta: { ru: "следующий шаг готов", en: "next step ready" },
	},
	{
		title: { ru: "Бронь и слот", en: "Booking slot" },
		desc: {
			ru: "AI предложил варианты. Менеджер выбирает слот, система отправляет подтверждение.",
			en: "AI offered options. Manager picks the slot, system sends confirmation.",
		},
		meta: { ru: "клиент горячий", en: "client is hot" },
	},
];

const SERVICES: { type: L; fields: L; decision: L; owner: L }[] = [
	{
		type: { ru: "Exchange & payments", en: "Exchange & payments" },
		fields: {
			ru: "asset, network, amount, payout",
			en: "asset, network, amount, payout",
		},
		decision: {
			ru: "курс, реквизиты, подтверждение",
			en: "rate, details, confirmation",
		},
		owner: { ru: "AI ведёт до оплаты", en: "AI drives to payment" },
	},
	{
		type: { ru: "Transfer & delivery", en: "Transfer & delivery" },
		fields: {
			ru: "route, time, passengers, luggage",
			en: "route, time, passengers, luggage",
		},
		decision: { ru: "водитель, цена, слот", en: "driver, price, slot" },
		owner: {
			ru: "AI отправляет детали клиенту",
			en: "AI sends details to client",
		},
	},
	{
		type: { ru: "Cleaning & field ops", en: "Cleaning & field ops" },
		fields: {
			ru: "address, scope, date, access",
			en: "address, scope, date, access",
		},
		decision: { ru: "исполнитель и дедлайн", en: "operator and deadline" },
		owner: { ru: "AI держит follow-up", en: "AI holds the follow-up" },
	},
	{
		type: { ru: "Massage", en: "Massage" },
		fields: {
			ru: "тип массажа, адрес, слот, длительность",
			en: "massage type, address, slot, duration",
		},
		decision: {
			ru: "мастер, выезд, депозит",
			en: "therapist, travel, deposit",
		},
		owner: { ru: "AI подтверждает запись", en: "AI confirms appointment" },
	},
	{
		type: { ru: "Beauty salon", en: "Beauty salon" },
		fields: {
			ru: "услуга, мастер, слот, пожелания",
			en: "service, specialist, slot, preferences",
		},
		decision: {
			ru: "наличие мастера и предоплата",
			en: "specialist availability and prepayment",
		},
		owner: {
			ru: "AI шлёт адрес и напоминание",
			en: "AI sends address and reminder",
		},
	},
	{
		type: { ru: "Housing booking", en: "Housing booking" },
		fields: {
			ru: "даты, район, спальни, бюджет",
			en: "dates, area, bedrooms, budget",
		},
		decision: {
			ru: "подбор объекта и условия брони",
			en: "listing match and booking terms",
		},
		owner: { ru: "AI ведёт до депозита", en: "AI drives to deposit" },
	},
	{
		type: { ru: "Tours & bookings", en: "Tours & bookings" },
		fields: {
			ru: "date, people, package, pickup",
			en: "date, people, package, pickup",
		},
		decision: { ru: "наличие мест и депозит", en: "availability and deposit" },
		owner: { ru: "AI закрывает бронь", en: "AI closes the booking" },
	},
	{
		type: {
			ru: "Clinics, beauty, education",
			en: "Clinics, beauty, education",
		},
		fields: {
			ru: "goal, symptoms/level, slot, budget",
			en: "goal, symptoms/level, slot, budget",
		},
		decision: { ru: "специалист или программа", en: "specialist or program" },
		owner: { ru: "AI ведёт intake", en: "AI runs intake" },
	},
	{
		type: { ru: "Custom offer", en: "Custom offer" },
		fields: {
			ru: "контекст, фото, срочность, ограничения",
			en: "context, photos, urgency, constraints",
		},
		decision: { ru: "человеческая оценка", en: "human judgment" },
		owner: {
			ru: "AI возвращает клиента в поток",
			en: "AI returns client to the flow",
		},
	},
];

const MARKETPLACE_CARDS: {
	category: L;
	name: string;
	sla: L;
	fields: string;
	status: L;
}[] = [
	{
		category: { ru: "Трансфер", en: "Transfer" },
		name: "Phuket Transfer Network",
		sla: { ru: "водитель до 7 мин", en: "driver in 7 min" },
		fields: "route, time, passengers",
		status: { ru: "installed", en: "installed" },
	},
	{
		category: { ru: "Уборка", en: "Cleaning" },
		name: "Island Cleaning Crew",
		sla: { ru: "бригада до 15 мин", en: "crew in 15 min" },
		fields: "address, scope, access",
		status: { ru: "installed", en: "installed" },
	},
	{
		category: { ru: "Массаж", en: "Massage" },
		name: "Spa Mobile Masters",
		sla: { ru: "мастер до 10 мин", en: "therapist in 10 min" },
		fields: "type, slot, duration",
		status: { ru: "add", en: "add" },
	},
	{
		category: { ru: "Жильё", en: "Housing" },
		name: "StayKey Housing Desk",
		sla: { ru: "3 варианта до 30 мин", en: "3 options in 30 min" },
		fields: "dates, area, budget",
		status: { ru: "add", en: "add" },
	},
];

const TG_MESSAGES: Record<Lang, TgMessage[]> = {
	ru: [
		{
			from: "user",
			text: "Привет. Нужно завтра встретить партнёра в аэропорту, сделать уборку, заказать массаж на вечер и найти жильё на неделю.",
		},
		{
			from: "bot",
			text: "Принял. Разделил на 4 заявки: трансфер, уборка, массаж и бронь жилья. Начну с трансфера: рейс и время прилёта?",
		},
		{ from: "user", text: "QR834, прилёт 14:20. Нужен минивэн." },
		{
			from: "bot",
			text: "Трансфер собран: минивэн, 14:20, airport pickup. По уборке: checkout или поддерживающая? И какой адрес?",
		},
		{
			from: "user",
			text: "Checkout, адрес Kata. Массаж deep tissue на двоих после 20:00. Жильё 2 спальни, до 90k бат.",
		},
		{
			from: "bot",
			text: "Готово: уборка ушла оператору на исполнителя, массаж — на подтверждение мастера, по жилью подобрал 3 варианта. Я продолжу, когда менеджер подтвердит условия.",
			cta: true,
		},
	],
	en: [
		{
			from: "user",
			text: "Hi. Tomorrow I need airport pickup for my partner, checkout cleaning, massage in the evening and housing for a week.",
		},
		{
			from: "bot",
			text: "Got it. I split this into 4 requests: transfer, cleaning, massage and housing booking. Transfer first: flight and arrival time?",
		},
		{ from: "user", text: "QR834, arrival 14:20. Need a minivan." },
		{
			from: "bot",
			text: "Transfer captured: minivan, 14:20, airport pickup. For cleaning: checkout or maintenance? And what address?",
		},
		{
			from: "user",
			text: "Checkout, Kata address. Deep tissue massage for two after 20:00. Housing: 2 bedrooms, up to 90k baht.",
		},
		{
			from: "bot",
			text: "Done: cleaning moved to operator for assignment, massage needs therapist confirmation, housing has 3 matched options. I will continue once manager confirms terms.",
			cta: true,
		},
	],
};

export default function DemoConcierge() {
	const [lang, setLang] = useState<Lang>("ru");
	const c = COPY[lang];

	return (
		<>
			<Nav lang={lang} setLang={setLang} cta={c.ctaPrimary} />

			<div className="demo-banner">
				<div className="container demo-banner-inner">
					<span className="demo-banner-tag">{c.bannerTag}</span>
					<span>{c.banner}</span>
				</div>
			</div>

			<section className="hero demo-services-hero">
				<div className="container">
					<h1 className="hero-headline" style={{ maxWidth: 860 }}>
						{c.title[0]}
						<em>{c.title[1]}</em>
					</h1>
					<p className="hero-sub" style={{ maxWidth: 760 }}>
						{c.sub}
					</p>
					<div className="hero-actions">
						<a href={SIGNUP_URL} className="btn btn-primary btn-lg">
							{c.ctaPrimary}
						</a>
						<a href={DEMO_URL} className="btn btn-secondary btn-lg">
							{c.ctaSecondary}
						</a>
					</div>
					<div className="demo-service-strip">
						{SERVICE_STRIP.map((service) => (
							<a
								key={service.en}
								className="demo-service-pill"
								href={service.href}
							>
								{t(service, lang)}
							</a>
						))}
					</div>
				</div>
			</section>

			<section className="section" style={{ paddingTop: 0 }}>
				<div className="container">
					<div className="section-label">{c.kpiTitle}</div>
					<div className="demo-kpis">
						{KPIS.map((k) => (
							<div key={k.label.en} className="demo-kpi">
								<div className="demo-kpi-value">{k.value}</div>
								<div className="demo-kpi-label">{t(k.label, lang)}</div>
								{k.trend && <div className="demo-kpi-trend">↑ {k.trend}</div>}
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.boardLabel}</div>
					<h2 className="section-title">{c.boardTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.boardSub}
					</p>
					<div className="demo-board">
						{PHASES.map((ph) => {
							const cards = LEADS.filter((l) => l.phase === ph.key);
							return (
								<div key={ph.key} className="demo-col">
									<div className="demo-col-head">
										<span
											className="demo-col-dot"
											style={{ background: ph.accent }}
										/>
										{t(ph.title, lang)}
										<span className="demo-col-count">{cards.length}</span>
									</div>
									{cards.map((l) => (
										<div
											key={`${l.phase}-${l.who}-${l.tag.en}`}
											className="demo-card"
											style={{ borderLeftColor: ph.accent }}
										>
											<div className="demo-card-top">
												<span className="demo-card-who">{l.who}</span>
												<span className="demo-badge">{t(l.tag, lang)}</span>
											</div>
											<div className="demo-card-dir">{t(l.dir, lang)}</div>
											<div className="demo-card-amt">{l.amt}</div>
											<div className="demo-card-meta">
												<span>{t(l.note, lang)}</span>
												<span className="demo-card-time">{l.time}</span>
											</div>
										</div>
									))}
								</div>
							);
						})}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="hero-inner">
						<div>
							<div className="section-label">{c.dialogLabel}</div>
							<h2 className="section-title" style={{ textAlign: "left" }}>
								{c.dialogTitle}
							</h2>
							<p className="section-sub">{c.dialogSub}</p>
						</div>
						<TelegramMockup
							botName={c.botName}
							ctaLabel={c.ctaBubble}
							messages={TG_MESSAGES[lang]}
							notify={c.notify}
						/>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.marketLabel}</div>
					<h2 className="section-title">{c.marketTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.marketSub}
					</p>
					<div className="demo-marketplace">
						<div className="demo-marketplace-panel">
							<div className="demo-marketplace-head">
								<span>Marketplace</span>
								<strong>curated + custom</strong>
							</div>
							<div className="demo-marketplace-grid">
								{MARKETPLACE_CARDS.map((provider) => (
									<div key={provider.name} className="demo-marketplace-card">
										<div className="demo-marketplace-top">
											<span>{t(provider.category, lang)}</span>
											<em>{t(provider.status, lang)}</em>
										</div>
										<strong>{provider.name}</strong>
										<p>{t(provider.sla, lang)}</p>
										<div>{provider.fields}</div>
									</div>
								))}
							</div>
						</div>
						<div className="demo-marketplace-route">
							<div className="demo-route-step">
								<span>01</span>
								<strong>{c.marketInstall}</strong>
								<p>partner → partner_service → service catalog</p>
							</div>
							<div className="demo-route-step">
								<span>02</span>
								<strong>{c.marketRoute}</strong>
								<p>request type → required fields → next action</p>
							</div>
							<div className="demo-route-step">
								<span>03</span>
								<strong>{c.marketHandoff}</strong>
								<p>awaiting provider → operator decision → won</p>
							</div>
						</div>
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.handoffLabel}</div>
					<h2 className="section-title">{c.handoffTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.handoffSub}
					</p>
					<div className="demo-decision-grid">
						{HANDOFFS.map((item) => (
							<div key={item.title.en} className="demo-decision">
								<div className="demo-decision-meta">{t(item.meta, lang)}</div>
								<h3>{t(item.title, lang)}</h3>
								<p>{t(item.desc, lang)}</p>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.svcLabel}</div>
					<h2 className="section-title">{c.svcTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.svcSub}
					</p>
					<div className="demo-rate demo-service-matrix">
						<table className="demo-rate-table">
							<thead>
								<tr>
									<th>{c.svcType}</th>
									<th>{c.svcFields}</th>
									<th>{c.svcDecision}</th>
									<th>{c.svcOwner}</th>
								</tr>
							</thead>
							<tbody>
								{SERVICES.map((s) => (
									<tr key={s.type.en}>
										<td>{t(s.type, lang)}</td>
										<td>{t(s.fields, lang)}</td>
										<td>{t(s.decision, lang)}</td>
										<td className="demo-rate-dev">{t(s.owner, lang)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container demo-cta">
					<h2 className="section-title">{c.ctaTitle}</h2>
					<p
						className="section-sub"
						style={{ margin: "0 auto 28px", textAlign: "center" }}
					>
						{c.ctaSub}
					</p>
					<div className="hero-actions" style={{ justifyContent: "center" }}>
						<a href={SIGNUP_URL} className="btn btn-primary btn-lg">
							{c.ctaPrimary}
						</a>
						<a href={DEMO_URL} className="btn btn-secondary btn-lg">
							{c.ctaSecondary}
						</a>
					</div>
				</div>
			</section>

			<Footer {...c.footer} />
		</>
	);
}
