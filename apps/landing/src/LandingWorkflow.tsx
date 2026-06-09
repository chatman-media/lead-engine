import { useState } from "react";
import {
	DEMO_URL,
	FaqAccordion,
	type FaqItem,
	type Lang,
	LangToggle,
	type Plan,
	PricingSection,
	SIGNUP_URL,
} from "./shared.tsx";

type Localized = Record<Lang, string>;

interface LandingCopy {
	navCta: string;
	bannerTag: string;
	banner: string;
	title: [string, string, string];
	sub: string;
	ctaPrimary: string;
	ctaSecondary: string;
	kpiTitle: string;
	boardLabel: string;
	boardTitle: string;
	boardSub: string;
	handoffLabel: string;
	handoffTitle: string;
	handoffSub: string;
	pricingLabel: string;
	pricingTitle: string;
	pricingNote: string;
	faqLabel: string;
	faqTitle: string;
	faqDemo: string;
	footer: {
		privacy: string;
		terms: string;
		copy: string;
	};
}

const t = (value: Localized, lang: Lang) => value[lang];

const SERVICE_STRIP: Array<Localized & { href: string }> = [
	{ ru: "Трансферы", en: "Transfers", href: "/demo/workflows/transfer" },
	{ ru: "Клининг", en: "Cleaning", href: "/demo/workflows/cleaning" },
	{ ru: "Массаж", en: "Massage", href: "/demo/workflows/massage" },
	{ ru: "Жилье", en: "Housing", href: "/demo/workflows/housing" },
	{ ru: "Свой процесс", en: "Custom flow", href: "/demo/workflows/custom" },
];

const KPIS: Array<{ value: string; label: Localized; trend?: string }> = [
	{
		value: "24/7",
		label: { ru: "AI принимает входящие", en: "AI accepts inbound requests" },
		trend: "always on",
	},
	{
		value: "<30с",
		label: { ru: "первый ответ клиенту", en: "first reply to a client" },
		trend: "no idle chats",
	},
	{
		value: "1",
		label: { ru: "очередь для всех каналов", en: "queue for all channels" },
	},
	{
		value: "4",
		label: { ru: "понятные стадии сделки", en: "clear deal stages" },
	},
	{
		value: "HITL",
		label: {
			ru: "оператор в точке решения",
			en: "operator at decision points",
		},
	},
];

const PHASES = [
	{
		key: "capture",
		title: { ru: "Принять", en: "Capture" },
		accent: "#6aa6ff",
	},
	{
		key: "qualify",
		title: { ru: "Уточнить", en: "Qualify" },
		accent: "#7dd3fc",
	},
	{
		key: "approve",
		title: { ru: "Согласовать", en: "Approve" },
		accent: "#fbbf77",
	},
	{
		key: "handoff",
		title: { ru: "Передать", en: "Handoff" },
		accent: "#95d68f",
	},
] as const;

type PhaseKey = (typeof PHASES)[number]["key"];

const LEADS: Array<{
	phase: PhaseKey;
	who: string;
	tag: Localized;
	title: Localized;
	summary: Localized;
	time: string;
}> = [
	{
		phase: "capture",
		who: "Анна",
		tag: { ru: "новая", en: "new" },
		title: { ru: "Трансфер из аэропорта", en: "Airport transfer" },
		summary: {
			ru: "AI принял дату, рейс и гостей",
			en: "AI captured date, flight and guests",
		},
		time: "09:18",
	},
	{
		phase: "capture",
		who: "Ilya",
		tag: { ru: "чат", en: "chat" },
		title: { ru: "Подбор виллы на неделю", en: "Villa search for a week" },
		summary: {
			ru: "Канал: Telegram, клиент ждет варианты",
			en: "Telegram lead, client waits for options",
		},
		time: "09:21",
	},
	{
		phase: "qualify",
		who: "Maya",
		tag: { ru: "уточнить", en: "clarify" },
		title: { ru: "Клининг после выезда", en: "Checkout cleaning" },
		summary: {
			ru: "Нужны адрес и время доступа",
			en: "Needs address and access window",
		},
		time: "09:24",
	},
	{
		phase: "qualify",
		who: "Sergey",
		tag: { ru: "бюджет", en: "budget" },
		title: { ru: "Долгосрочная аренда", en: "Long-stay rental" },
		summary: {
			ru: "AI уточнил район, срок и лимит",
			en: "AI clarified area, term and limit",
		},
		time: "09:27",
	},
	{
		phase: "approve",
		who: "Nina",
		tag: { ru: "решение", en: "decision" },
		title: { ru: "Массаж для двоих", en: "Massage for two" },
		summary: {
			ru: "Оператор выбирает исполнителя",
			en: "Operator picks the provider",
		},
		time: "09:31",
	},
	{
		phase: "handoff",
		who: "Alex",
		tag: { ru: "готово", en: "ready" },
		title: { ru: "Встреча и заселение", en: "Meet and check-in" },
		summary: {
			ru: "Условия согласованы, задача в работе",
			en: "Terms approved, task in progress",
		},
		time: "09:36",
	},
];

const HANDOFFS = [
	{
		meta: { ru: "AI", en: "AI" },
		title: {
			ru: "Принимает и ведет диалог",
			en: "Captures and drives the conversation",
		},
		desc: {
			ru: "Отвечает быстро, задает нужные вопросы и доводит клиента до следующего шага.",
			en: "Replies fast, asks the right questions and moves the client to the next step.",
		},
	},
	{
		meta: { ru: "Оператор", en: "Operator" },
		title: { ru: "Подключается к решению", en: "Steps in for decisions" },
		desc: {
			ru: "Видит контекст и принимает решение там, где нужны цена, условия или личный контроль.",
			en: "Sees context and decides where price, terms or personal control matter.",
		},
	},
	{
		meta: { ru: "Сделка", en: "Deal" },
		title: {
			ru: "Не теряется между чатами",
			en: "Does not get lost between chats",
		},
		desc: {
			ru: "Каждая заявка живет в понятной очереди: принято, уточняется, согласуется, передано.",
			en: "Every request lives in a clear queue: captured, qualified, approved and handed off.",
		},
	},
];

const COPY = {
	ru: {
		navCta: "Попробовать",
		bannerTag: "Lead Engine",
		banner:
			"Главная в стиле демо: та же темная система, карточки процессов и единая очередь заявок.",
		title: [
			"AI принимает заявки, ",
			"ведет сделки",
			" и зовет оператора только в нужный момент",
		],
		sub: "Lead Engine превращает Telegram, WhatsApp и web-формы в управляемый front office: AI отвечает клиенту, собирает вводные, двигает сделку по стадиям и передает человеку готовый контекст.",
		ctaPrimary: "Запустить бесплатно",
		ctaSecondary: "Смотреть демо",
		kpiTitle: "Операционный контур",
		boardLabel: "Единая очередь",
		boardTitle: "Не dashboard ради dashboard, а рабочий экран для заявок",
		boardSub:
			"Предприниматель видит, где зависли клиенты и где нужен человек. Технические детали остаются внутри системы.",
		handoffLabel: "Human-in-the-loop",
		handoffTitle: "Оператор сидит в каждом диалоге, но не делает рутину",
		handoffSub:
			"AI держит скорость и структуру. Человек остается там, где важны условия, доверие и финальное решение.",
		pricingLabel: "Тарифы",
		pricingTitle: "Начните с одного процесса и расширяйте по мере роста",
		pricingNote:
			"Для пилота достаточно одного канала, базы знаний и простого workflow.",
		faqLabel: "FAQ",
		faqTitle: "Частые вопросы",
		faqDemo: "Обсудить демо",
		footer: {
			privacy: "Privacy",
			terms: "Terms",
			copy: "© 2026 Lead Engine. AI front office for inbound revenue.",
		},
	},
	en: {
		navCta: "Try it",
		bannerTag: "Lead Engine",
		banner:
			"Homepage aligned with the demo style: dark system UI, workflow cards and one request queue.",
		title: [
			"AI captures requests, ",
			"runs deals",
			" and calls an operator only when needed",
		],
		sub: "Lead Engine turns Telegram, WhatsApp and web forms into a managed front office: AI replies, gathers context, moves deals through stages and hands over a clean brief to a human.",
		ctaPrimary: "Start free",
		ctaSecondary: "View demo",
		kpiTitle: "Operating loop",
		boardLabel: "Unified queue",
		boardTitle: "Not a dashboard for show. A working screen for requests.",
		boardSub:
			"The owner sees where clients are stuck and where a human is needed. Technical details stay inside the system.",
		handoffLabel: "Human-in-the-loop",
		handoffTitle:
			"An operator is present in every dialog, without doing the routine",
		handoffSub:
			"AI keeps speed and structure. People stay responsible for terms, trust and final decisions.",
		pricingLabel: "Pricing",
		pricingTitle: "Start with one workflow and expand as volume grows",
		pricingNote:
			"A pilot only needs one channel, a knowledge base and a simple workflow.",
		faqLabel: "FAQ",
		faqTitle: "Common questions",
		faqDemo: "Book a demo",
		footer: {
			privacy: "Privacy",
			terms: "Terms",
			copy: "© 2026 Lead Engine. AI front office for inbound revenue.",
		},
	},
} satisfies Record<Lang, LandingCopy>;

const PLANS: Record<Lang, Plan[]> = {
	ru: [
		{
			name: "Pilot",
			price: "$0",
			priceUnit: "/мес",
			features: ["1 канал", "1 workflow", "50 диалогов", "База знаний"],
			cta: "Начать",
		},
		{
			name: "Growth",
			price: "$49",
			priceUnit: "/мес",
			popular: true,
			features: [
				"3 канала",
				"5 workflows",
				"Операторские handoff",
				"История сделок",
			],
			cta: "Подключить",
		},
		{
			name: "Custom",
			price: "Индивидуально",
			isCustom: true,
			features: [
				"Маркетплейс услуг",
				"Интеграции",
				"SLA и роли",
				"Помощь с запуском",
			],
			cta: "Обсудить",
		},
	],
	en: [
		{
			name: "Pilot",
			price: "$0",
			priceUnit: "/mo",
			features: [
				"1 channel",
				"1 workflow",
				"50 conversations",
				"Knowledge base",
			],
			cta: "Start",
		},
		{
			name: "Growth",
			price: "$49",
			priceUnit: "/mo",
			popular: true,
			features: [
				"3 channels",
				"5 workflows",
				"Operator handoff",
				"Deal history",
			],
			cta: "Connect",
		},
		{
			name: "Custom",
			price: "Custom",
			isCustom: true,
			features: [
				"Service marketplace",
				"Integrations",
				"SLA and roles",
				"Launch support",
			],
			cta: "Discuss",
		},
	],
};

const FAQ = {
	ru: [
		{
			q: "Это заменяет менеджера?",
			a: "Нет. AI берет на себя первый ответ, уточнения и структуру сделки. Менеджер подключается, когда нужно принять решение или согласовать условия.",
		},
		{
			q: "Нужно показывать предпринимателю технические поля?",
			a: "Нет. Главный экран показывает стадии, статус и понятный следующий шаг. Внутренние поля workflow остаются в настройках.",
		},
		{
			q: "Можно начать с одного направления?",
			a: "Да. Обычно пилот запускается с одного канала и одного процесса, например трансферы, заявки на услуги или подбор жилья.",
			hasDemo: true,
		},
	],
	en: [
		{
			q: "Does this replace a manager?",
			a: "No. AI handles first replies, clarifying questions and deal structure. A manager steps in when a decision or terms approval is needed.",
		},
		{
			q: "Will operators see technical workflow fields?",
			a: "No. The main screen shows stages, status and a clear next step. Internal workflow fields stay in settings.",
		},
		{
			q: "Can we start with one service line?",
			a: "Yes. A pilot usually starts with one channel and one workflow, such as transfers, service requests or housing search.",
			hasDemo: true,
		},
	],
} satisfies Record<Lang, FaqItem[]>;

function LeadNav({
	lang,
	setLang,
	cta,
}: {
	lang: Lang;
	setLang: (lang: Lang) => void;
	cta: string;
}) {
	return (
		<nav className="nav">
			<div className="container">
				<div className="nav-inner">
					<a href="/" className="nav-logo">
						Lead<span>Engine</span>
					</a>
					<div className="nav-right">
						<LangToggle lang={lang} setLang={setLang} />
						<a href={SIGNUP_URL} className="btn btn-primary">
							{cta}
						</a>
					</div>
				</div>
			</div>
		</nav>
	);
}

function LeadFooter({ copy, privacy, terms }: LandingCopy["footer"]) {
	return (
		<footer className="footer">
			<div className="container">
				<div className="footer-inner">
					<div className="footer-logo">
						Lead<span>Engine</span>
					</div>
					<div className="footer-links">
						<a href="/privacy">{privacy}</a>
						<a href="/terms">{terms}</a>
					</div>
					<div className="footer-copy">{copy}</div>
				</div>
			</div>
		</footer>
	);
}

export default function LandingWorkflow() {
	const [lang, setLang] = useState<Lang>("ru");
	const c = COPY[lang];

	return (
		<>
			<LeadNav cta={c.navCta} lang={lang} setLang={setLang} />

			<div className="demo-banner">
				<div className="container demo-banner-inner">
					<span className="demo-banner-tag">{c.bannerTag}</span>
					<span>{c.banner}</span>
				</div>
			</div>

			<section className="hero demo-services-hero">
				<div className="container">
					<h1 className="hero-headline" style={{ maxWidth: 900 }}>
						{c.title[0]}
						<em>{c.title[1]}</em>
						{c.title[2]}
					</h1>
					<p className="hero-sub" style={{ maxWidth: 780 }}>
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
								key={service.href}
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
						{KPIS.map((kpi) => (
							<div key={kpi.value} className="demo-kpi">
								<div className="demo-kpi-value">{kpi.value}</div>
								<div className="demo-kpi-label">{t(kpi.label, lang)}</div>
								{kpi.trend && (
									<div className="demo-kpi-trend">↑ {kpi.trend}</div>
								)}
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
						{PHASES.map((phase) => {
							const cards = LEADS.filter((lead) => lead.phase === phase.key);
							return (
								<div key={phase.key} className="demo-col">
									<div className="demo-col-head">
										<span
											className="demo-col-dot"
											style={{ background: phase.accent }}
										/>
										{t(phase.title, lang)}
										<span className="demo-col-count">{cards.length}</span>
									</div>
									{cards.map((lead) => (
										<div
											key={`${lead.who}-${lead.time}`}
											className="demo-card"
											style={{ borderLeftColor: phase.accent }}
										>
											<div className="demo-card-top">
												<span className="demo-card-who">{lead.who}</span>
												<span className="demo-badge">{t(lead.tag, lang)}</span>
											</div>
											<div className="demo-card-dir">{t(lead.title, lang)}</div>
											<div className="demo-card-amt">
												{t(lead.summary, lang)}
											</div>
											<div className="demo-card-meta">
												<span>{t(phase.title, lang)}</span>
												<span className="demo-card-time">{lead.time}</span>
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

			<PricingSection
				label={c.pricingLabel}
				note={c.pricingNote}
				plans={PLANS[lang]}
				title={c.pricingTitle}
			/>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.faqLabel}</div>
					<h2 className="section-title">{c.faqTitle}</h2>
					<FaqAccordion demoBtn={c.faqDemo} items={FAQ[lang]} />
				</div>
			</section>

			<LeadFooter {...c.footer} />
		</>
	);
}
