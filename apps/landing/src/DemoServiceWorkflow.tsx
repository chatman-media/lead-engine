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

type L = { ru: string; en: string };
type WorkflowKey =
	| "transfer"
	| "cleaning"
	| "massage"
	| "beauty"
	| "housing"
	| "custom";

const t = (value: L, lang: Lang) => value[lang];

const WORKFLOWS: Record<
	WorkflowKey,
	{
		label: L;
		title: L;
		sub: L;
		inbound: L;
		kpis: { value: string; label: L }[];
		fields: string[];
		stages: { title: L; desc: L; owner: string }[];
		provider: { name: string; sla: L; handoff: L; result: L };
		messages: Record<Lang, TgMessage[]>;
	}
> = {
	transfer: {
		label: { ru: "Transfer workflow", en: "Transfer workflow" },
		title: {
			ru: "Трансфер как workflow: рейс, машина, водитель, ETA",
			en: "Transfer as workflow: flight, car, driver, ETA",
		},
		sub: {
			ru: "AI собирает рейс, время, маршрут, пассажиров, багаж и класс машины. Оператор выбирает провайдера только если нужен ручной слот или нестандартная цена.",
			en: "AI collects flight, time, route, passengers, luggage and car class. Operator chooses a provider only when a manual slot or custom price is needed.",
		},
		inbound: {
			ru: "«Нужно встретить партнёра завтра, рейс QR834, 2 чемодана, минивэн до Kata»",
			en: "“Need airport pickup tomorrow, flight QR834, 2 bags, minivan to Kata”",
		},
		kpis: [
			{
				value: "7 мин",
				label: { ru: "driver confirm SLA", en: "driver confirm SLA" },
			},
			{ value: "฿1 200", label: { ru: "offer ready", en: "offer ready" } },
			{ value: "1", label: { ru: "human decision", en: "human decision" } },
		],
		fields: [
			"flight",
			"arrival_time",
			"pickup",
			"dropoff",
			"passengers",
			"luggage",
			"car_class",
		],
		stages: [
			{
				title: { ru: "Request capture", en: "Request capture" },
				desc: {
					ru: "AI вытаскивает рейс и маршрут из сообщения.",
					en: "AI extracts flight and route from the message.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Provider match", en: "Provider match" },
				desc: {
					ru: "Marketplace ищет минивэн с нужным SLA.",
					en: "Marketplace searches for a minivan with the required SLA.",
				},
				owner: "system",
			},
			{
				title: { ru: "Driver handoff", en: "Driver handoff" },
				desc: {
					ru: "Оператор подтверждает водителя и цену.",
					en: "Operator confirms driver and price.",
				},
				owner: "operator",
			},
			{
				title: { ru: "Confirmed", en: "Confirmed" },
				desc: {
					ru: "AI отправляет детали встречи и держит напоминание.",
					en: "AI sends pickup details and keeps the reminder.",
				},
				owner: "AI",
			},
		],
		provider: {
			name: "Phuket Transfer Network",
			sla: { ru: "водитель до 7 минут", en: "driver in 7 minutes" },
			handoff: {
				ru: "нужен минивэн и flight tracking",
				en: "minivan and flight tracking needed",
			},
			result: {
				ru: "клиент получил авто, водителя и ETA",
				en: "client got car, driver and ETA",
			},
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужен трансфер завтра. Рейс QR834, прилёт 14:20, минивэн до Kata.",
				},
				{
					from: "bot",
					text: "Принял: QR834, 14:20, минивэн, airport pickup -> Kata. Пассажиров и багаж сколько?",
				},
				{ from: "user", text: "3 человека и 2 чемодана." },
				{
					from: "bot",
					text: "Провайдер найден. Оператор подтверждает водителя и цену, затем пришлю детали.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need transfer tomorrow. Flight QR834, arrives 14:20, minivan to Kata.",
				},
				{
					from: "bot",
					text: "Captured: QR834, 14:20, minivan, airport pickup -> Kata. How many passengers and bags?",
				},
				{ from: "user", text: "3 people and 2 bags." },
				{
					from: "bot",
					text: "Provider found. Operator is confirming driver and price, then I will send details.",
					cta: true,
				},
			],
		},
	},
	cleaning: {
		label: { ru: "Cleaning workflow", en: "Cleaning workflow" },
		title: {
			ru: "Уборка как workflow: адрес, доступ, объём, исполнитель",
			en: "Cleaning as workflow: address, access, scope, crew",
		},
		sub: {
			ru: "AI отделяет checkout-cleaning от поддерживающей уборки, собирает адрес, доступ, фото, площадь, laundry и дедлайн. Оператор получает только назначение бригады.",
			en: "AI separates checkout from maintenance cleaning, collects address, access, photos, area, laundry and deadline. Operator only gets crew assignment.",
		},
		inbound: {
			ru: "«Завтра checkout уборка в Kata, ключ у охраны, нужно ещё laundry»",
			en: "“Checkout cleaning tomorrow in Kata, key with security, need laundry too”",
		},
		kpis: [
			{
				value: "15 мин",
				label: { ru: "crew confirm SLA", en: "crew confirm SLA" },
			},
			{ value: "฿1 450", label: { ru: "scope offer", en: "scope offer" } },
			{ value: "4", label: { ru: "required fields", en: "required fields" } },
		],
		fields: [
			"address",
			"cleaning_type",
			"access",
			"rooms",
			"photos",
			"laundry",
			"deadline",
		],
		stages: [
			{
				title: { ru: "Scope intake", en: "Scope intake" },
				desc: {
					ru: "AI уточняет тип уборки и объём.",
					en: "AI clarifies cleaning type and scope.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Access check", en: "Access check" },
				desc: {
					ru: "Адрес, ключ, контакт охраны, фото.",
					en: "Address, key, security contact, photos.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Crew assignment", en: "Crew assignment" },
				desc: {
					ru: "Оператор назначает исполнителя и дедлайн.",
					en: "Operator assigns crew and deadline.",
				},
				owner: "operator",
			},
			{
				title: { ru: "Done proof", en: "Done proof" },
				desc: {
					ru: "Фото результата и follow-up клиенту.",
					en: "Completion photos and client follow-up.",
				},
				owner: "AI",
			},
		],
		provider: {
			name: "Island Cleaning Crew",
			sla: { ru: "бригада до 15 минут", en: "crew in 15 minutes" },
			handoff: { ru: "нужно назначить бригаду", en: "crew assignment needed" },
			result: {
				ru: "клиент получил подтверждение и ETA",
				en: "client got confirmation and ETA",
			},
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужна checkout уборка завтра в Kata, ключ у охраны, ещё laundry.",
				},
				{
					from: "bot",
					text: "Принял. Сколько спален и есть ли фото текущего состояния?",
				},
				{ from: "user", text: "2 спальни, фото сейчас отправлю." },
				{
					from: "bot",
					text: "Заявка собрана. Передаю оператору на бригаду, затем пришлю ETA.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need checkout cleaning tomorrow in Kata, key with security, laundry too.",
				},
				{
					from: "bot",
					text: "Got it. How many bedrooms and do you have photos of current state?",
				},
				{ from: "user", text: "2 bedrooms, sending photos now." },
				{
					from: "bot",
					text: "Request captured. Passing to operator for crew assignment, then I will send ETA.",
					cta: true,
				},
			],
		},
	},
	massage: {
		label: { ru: "Massage workflow", en: "Massage workflow" },
		title: {
			ru: "Массаж как workflow: тип, слот, мастер, депозит",
			en: "Massage as workflow: type, slot, therapist, deposit",
		},
		sub: {
			ru: "AI собирает тип массажа, длительность, адрес, количество людей и окно времени. Оператор подтверждает мастера, выезд и депозит.",
			en: "AI collects massage type, duration, address, people count and time window. Operator confirms therapist, travel and deposit.",
		},
		inbound: {
			ru: "«Сегодня deep tissue на двоих после 20:00, выезд в апартаменты»",
			en: "“Deep tissue for two today after 20:00, therapist to apartment”",
		},
		kpis: [
			{ value: "10 мин", label: { ru: "therapist SLA", en: "therapist SLA" } },
			{ value: "฿2 400", label: { ru: "deposit flow", en: "deposit flow" } },
			{ value: "2", label: { ru: "therapists", en: "therapists" } },
		],
		fields: [
			"massage_type",
			"duration",
			"people",
			"address",
			"time_window",
			"travel_fee",
			"deposit",
		],
		stages: [
			{
				title: { ru: "Preference intake", en: "Preference intake" },
				desc: {
					ru: "Тип массажа, длительность, противопоказания.",
					en: "Massage type, duration, contraindications.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Slot match", en: "Slot match" },
				desc: {
					ru: "Система ищет мастера и окно времени.",
					en: "System searches therapist and time slot.",
				},
				owner: "system",
			},
			{
				title: { ru: "Therapist handoff", en: "Therapist handoff" },
				desc: {
					ru: "Оператор подтверждает выезд и депозит.",
					en: "Operator confirms travel and deposit.",
				},
				owner: "operator",
			},
			{
				title: { ru: "Booked", en: "Booked" },
				desc: {
					ru: "AI отправляет подтверждение и напоминание.",
					en: "AI sends confirmation and reminder.",
				},
				owner: "AI",
			},
		],
		provider: {
			name: "Spa Mobile Masters",
			sla: { ru: "мастер до 10 минут", en: "therapist in 10 minutes" },
			handoff: { ru: "нужен мастер на выезд", en: "mobile therapist needed" },
			result: {
				ru: "слот подтверждён, депозит отправлен",
				en: "slot confirmed, deposit sent",
			},
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужен deep tissue массаж на двоих сегодня после 20:00, выезд.",
				},
				{
					from: "bot",
					text: "Принял. Длительность 60 или 90 минут? И какой адрес?",
				},
				{ from: "user", text: "90 минут, адрес в Rawai." },
				{
					from: "bot",
					text: "Передаю оператору на мастеров и депозит. После подтверждения пришлю слот.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need deep tissue massage for two today after 20:00, mobile.",
				},
				{ from: "bot", text: "Got it. 60 or 90 minutes? And what address?" },
				{ from: "user", text: "90 minutes, Rawai address." },
				{
					from: "bot",
					text: "Passing to operator for therapists and deposit. I will send slot after confirmation.",
					cta: true,
				},
			],
		},
	},
	beauty: {
		label: { ru: "Beauty salon workflow", en: "Beauty salon workflow" },
		title: {
			ru: "Салон красоты как workflow: услуга, мастер, слот, предоплата",
			en: "Beauty salon as workflow: service, specialist, slot, prepayment",
		},
		sub: {
			ru: "AI собирает услугу, пожелания, фото-референс, окно времени и предпочтения по мастеру. Оператор подтверждает слот и условия.",
			en: "AI collects service, preferences, reference photos, time window and specialist preference. Operator confirms slot and terms.",
		},
		inbound: {
			ru: "«Нужны волосы и ногти завтра после обеда, рядом с Bang Tao»",
			en: "“Need hair and nails tomorrow afternoon near Bang Tao”",
		},
		kpis: [
			{ value: "3", label: { ru: "services bundled", en: "services bundled" } },
			{ value: "฿2 300", label: { ru: "prepayment", en: "prepayment" } },
			{ value: "16:30", label: { ru: "slot held", en: "slot held" } },
		],
		fields: [
			"service",
			"reference_photo",
			"area",
			"time_window",
			"specialist",
			"prepayment",
		],
		stages: [
			{
				title: { ru: "Service split", en: "Service split" },
				desc: {
					ru: "Hair, nails, makeup не смешиваются в одну строку.",
					en: "Hair, nails, makeup do not collapse into one line.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Preference capture", en: "Preference capture" },
				desc: {
					ru: "Референс, район, время, пожелания.",
					en: "Reference, area, time, preferences.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Slot approval", en: "Slot approval" },
				desc: {
					ru: "Оператор держит слот и мастера.",
					en: "Operator holds slot and specialist.",
				},
				owner: "operator",
			},
			{
				title: { ru: "Reminder", en: "Reminder" },
				desc: {
					ru: "AI отправляет адрес и reminder.",
					en: "AI sends address and reminder.",
				},
				owner: "AI",
			},
		],
		provider: {
			name: "Bang Tao Beauty Desk",
			sla: { ru: "слот до 12 минут", en: "slot in 12 minutes" },
			handoff: { ru: "нужно удержать мастера", en: "specialist hold needed" },
			result: {
				ru: "запись и предоплата подтверждены",
				en: "booking and prepayment confirmed",
			},
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужны волосы и ногти завтра после обеда, желательно Bang Tao.",
				},
				{
					from: "bot",
					text: "Принял. Можете прислать референс и желаемое время?",
				},
				{ from: "user", text: "После 15:00, фото отправляю." },
				{
					from: "bot",
					text: "Собрал заявку. Оператор держит слот и мастера, затем пришлю предоплату.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need hair and nails tomorrow afternoon, ideally Bang Tao.",
				},
				{
					from: "bot",
					text: "Got it. Can you send a reference and preferred time?",
				},
				{ from: "user", text: "After 15:00, sending photo." },
				{
					from: "bot",
					text: "Request captured. Operator is holding slot and specialist, then I will send prepayment.",
					cta: true,
				},
			],
		},
	},
	housing: {
		label: { ru: "Housing workflow", en: "Housing workflow" },
		title: {
			ru: "Бронь жилья как workflow: даты, район, бюджет, условия",
			en: "Housing booking as workflow: dates, area, budget, terms",
		},
		sub: {
			ru: "AI собирает даты, район, спальни, бюджет, тип объекта и ограничения. Оператор выбирает объекты, условия брони и депозит.",
			en: "AI collects dates, area, bedrooms, budget, property type and constraints. Operator chooses listings, booking terms and deposit.",
		},
		inbound: {
			ru: "«Нужна вилла на неделю, 2 спальни, Kata/Rawai, до 90k бат»",
			en: "“Need villa for a week, 2 bedrooms, Kata/Rawai, up to 90k baht”",
		},
		kpis: [
			{ value: "3", label: { ru: "matched listings", en: "matched listings" } },
			{ value: "฿90k", label: { ru: "budget", en: "budget" } },
			{ value: "30 мин", label: { ru: "options SLA", en: "options SLA" } },
		],
		fields: [
			"dates",
			"area",
			"bedrooms",
			"budget",
			"property_type",
			"deposit_terms",
		],
		stages: [
			{
				title: { ru: "Need intake", en: "Need intake" },
				desc: {
					ru: "Даты, район, спальни, бюджет.",
					en: "Dates, area, bedrooms, budget.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Listing match", en: "Listing match" },
				desc: {
					ru: "Marketplace отдаёт варианты и условия.",
					en: "Marketplace returns listings and terms.",
				},
				owner: "system",
			},
			{
				title: { ru: "Terms handoff", en: "Terms handoff" },
				desc: {
					ru: "Оператор подтверждает доступность и депозит.",
					en: "Operator confirms availability and deposit.",
				},
				owner: "operator",
			},
			{
				title: { ru: "Booked / deposit", en: "Booked / deposit" },
				desc: {
					ru: "AI ведёт клиента к брони.",
					en: "AI moves client to booking.",
				},
				owner: "AI",
			},
		],
		provider: {
			name: "StayKey Housing Desk",
			sla: { ru: "3 варианта до 30 минут", en: "3 options in 30 minutes" },
			handoff: { ru: "нужны условия брони", en: "booking terms needed" },
			result: {
				ru: "3 объекта отправлены, депозит готов",
				en: "3 listings sent, deposit ready",
			},
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужна вилла на неделю, 2 спальни, Kata или Rawai, до 90k бат.",
				},
				{
					from: "bot",
					text: "Принял. Какие даты заезда и выезда? Нужен бассейн?",
				},
				{ from: "user", text: "12-19 июня, бассейн желательно." },
				{
					from: "bot",
					text: "Подобрал критерии. Оператор проверяет 3 объекта и условия депозита.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need villa for a week, 2 bedrooms, Kata or Rawai, up to 90k baht.",
				},
				{
					from: "bot",
					text: "Got it. Check-in and check-out dates? Pool required?",
				},
				{ from: "user", text: "June 12-19, pool preferred." },
				{
					from: "bot",
					text: "Criteria captured. Operator is checking 3 listings and deposit terms.",
					cta: true,
				},
			],
		},
	},
	custom: {
		label: { ru: "Custom workflow", en: "Custom workflow" },
		title: {
			ru: "Кастомная услуга как workflow: не FAQ, а управляемая заявка",
			en: "Custom service as workflow: not FAQ, but a controlled request",
		},
		sub: {
			ru: "Для ремонта, частного ужина, VIP-показа, экскурсии или любой ручной услуги AI собирает контекст, фото, ограничения, бюджет и срочность. Человек принимает решение, система возвращает клиента в поток.",
			en: "For maintenance, private dinner, VIP viewing, tour or any manual service, AI collects context, photos, constraints, budget and urgency. Human decides, system returns the client to flow.",
		},
		inbound: {
			ru: "«Нужно срочно решить нестандартную задачу, пришлю фото и адрес»",
			en: "“Need to solve a non-standard request urgently, sending photos and address”",
		},
		kpis: [
			{ value: "8 мин", label: { ru: "decision SLA", en: "decision SLA" } },
			{
				value: "photos",
				label: { ru: "context captured", en: "context captured" },
			},
			{ value: "human", label: { ru: "price owner", en: "price owner" } },
		],
		fields: [
			"context",
			"photos",
			"address",
			"urgency",
			"budget",
			"constraints",
			"decision_owner",
		],
		stages: [
			{
				title: { ru: "Context capture", en: "Context capture" },
				desc: {
					ru: "AI собирает вводные и фото.",
					en: "AI collects context and photos.",
				},
				owner: "AI",
			},
			{
				title: { ru: "Decision card", en: "Decision card" },
				desc: {
					ru: "Система формирует короткую карточку решения.",
					en: "System creates a compact decision card.",
				},
				owner: "system",
			},
			{
				title: { ru: "Human quote", en: "Human quote" },
				desc: {
					ru: "Менеджер ставит цену, срок и условия.",
					en: "Manager sets price, timing and terms.",
				},
				owner: "operator",
			},
			{
				title: { ru: "Client close", en: "Client close" },
				desc: {
					ru: "AI отправляет оффер и держит follow-up.",
					en: "AI sends offer and holds follow-up.",
				},
				owner: "AI",
			},
		],
		provider: {
			name: "Custom Provider",
			sla: { ru: "ручное решение", en: "manual decision" },
			handoff: { ru: "нужна оценка человека", en: "human estimate needed" },
			result: { ru: "оффер вернулся клиенту", en: "offer returned to client" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужно срочно починить кондиционер. Адрес Rawai, фото отправляю.",
				},
				{
					from: "bot",
					text: "Принял. Собрал адрес, фото и срочность. Есть желаемое окно времени?",
				},
				{ from: "user", text: "Сегодня до вечера." },
				{
					from: "bot",
					text: "Передаю оператору на цену и исполнителя. Вернусь с оффером в этом диалоге.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need urgent AC repair. Rawai address, sending photos.",
				},
				{
					from: "bot",
					text: "Got it. Captured address, photos and urgency. Any preferred time window?",
				},
				{ from: "user", text: "Today before evening." },
				{
					from: "bot",
					text: "Passing to operator for price and provider. I will return with the offer in this dialog.",
					cta: true,
				},
			],
		},
	},
};

const COPY = {
	ru: {
		ctaPrimary: "Собрать такой workflow",
		ctaSecondary: "Обсудить в Telegram",
		boardLabel: "Workflow demo",
		inputLabel: "Inbound",
		fieldsLabel: "Fields",
		providerLabel: "Provider marketplace",
		providerTitle: "Провайдер добавлен в каталог, AI знает поля и handoff",
		footer: {
			privacy: "Политика конфиденциальности",
			terms: "Условия использования",
			copy: "© 2026 Lead Engine",
		},
	},
	en: {
		ctaPrimary: "Build this workflow",
		ctaSecondary: "Discuss in Telegram",
		boardLabel: "Workflow demo",
		inputLabel: "Inbound",
		fieldsLabel: "Fields",
		providerLabel: "Provider marketplace",
		providerTitle:
			"Provider is installed into catalog, AI knows fields and handoff",
		footer: {
			privacy: "Privacy Policy",
			terms: "Terms of Use",
			copy: "© 2026 Lead Engine",
		},
	},
};

export default function DemoServiceWorkflow({
	workflowKey,
}: {
	workflowKey: WorkflowKey;
}) {
	const [lang, setLang] = useState<Lang>("ru");
	const c = COPY[lang];
	const workflow = WORKFLOWS[workflowKey];

	return (
		<>
			<Nav cta={c.ctaPrimary} lang={lang} setLang={setLang} />

			<div className="demo-banner">
				<div className="container demo-banner-inner">
					<span className="demo-banner-tag">{t(workflow.label, lang)}</span>
					<span>{t(workflow.inbound, lang)}</span>
				</div>
			</div>

			<section className="hero service-workflow-hero">
				<div className="container">
					<div className="service-workflow-grid">
						<div>
							<div className="hero-badge">provider marketplace · workflow</div>
							<h1 className="hero-headline" style={{ maxWidth: 800 }}>
								{t(workflow.title, lang)}
							</h1>
							<p className="hero-sub">{t(workflow.sub, lang)}</p>
							<div className="hero-actions">
								<a href={SIGNUP_URL} className="btn btn-primary btn-lg">
									{c.ctaPrimary}
								</a>
								<a href={DEMO_URL} className="btn btn-secondary btn-lg">
									{c.ctaSecondary}
								</a>
							</div>
							<div className="exchange-proof-strip">
								<a href="/demo/workflows/exchange">exchange</a>
								<a href="/demo/workflows/transfer">transfer</a>
								<a href="/demo/workflows/cleaning">cleaning</a>
								<a href="/demo/services">all services</a>
							</div>
						</div>
						<div className="service-workflow-panel">
							<div className="section-label">{c.boardLabel}</div>
							<div className="service-kpis">
								{workflow.kpis.map((kpi) => (
									<div key={`${kpi.value}-${kpi.label.en}`}>
										<strong>{kpi.value}</strong>
										<span>{t(kpi.label, lang)}</span>
									</div>
								))}
							</div>
							<div className="service-inbound">
								<span>{c.inputLabel}</span>
								<strong>{t(workflow.inbound, lang)}</strong>
							</div>
							<div className="service-field-cloud">
								{workflow.fields.map((field) => (
									<span key={field}>{field}</span>
								))}
							</div>
						</div>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="workflow-step-row">
						{workflow.stages.map((stage, index) => (
							<div
								key={stage.owner + stage.title.en}
								className="workflow-step-card"
							>
								<span>{String(index + 1).padStart(2, "0")}</span>
								<strong>{t(stage.title, lang)}</strong>
								<p>{t(stage.desc, lang)}</p>
								<em>{stage.owner}</em>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.providerLabel}</div>
					<h2 className="section-title">{c.providerTitle}</h2>
					<div className="service-provider-scene">
						<div>
							<span>installed provider</span>
							<strong>{workflow.provider.name}</strong>
							<p>{t(workflow.provider.sla, lang)}</p>
						</div>
						<div>
							<span>handoff</span>
							<strong>{t(workflow.provider.handoff, lang)}</strong>
							<p>{"provider match -> operator decision -> client update"}</p>
						</div>
						<div>
							<span>result</span>
							<strong>{t(workflow.provider.result, lang)}</strong>
							<p>service catalog routeType=partner_service</p>
						</div>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="hero-inner">
						<div>
							<div className="section-label">Telegram side</div>
							<h2 className="section-title" style={{ textAlign: "left" }}>
								{t(workflow.label, lang)}
							</h2>
							<p className="section-sub">{t(workflow.sub, lang)}</p>
						</div>
						<TelegramMockup
							botName="Lead Engine Ops"
							ctaLabel="Open workflow card ->"
							messages={workflow.messages[lang]}
							notify={`handoff: ${t(workflow.provider.handoff, lang)}`}
						/>
					</div>
				</div>
			</section>

			<Footer {...c.footer} />
		</>
	);
}
