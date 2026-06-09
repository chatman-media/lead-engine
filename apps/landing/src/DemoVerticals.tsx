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
type VerticalKey =
	| "recruitment"
	| "real-estate"
	| "visa"
	| "scooter"
	| "modeling"
	| "video"
	| "dental"
	| "auto-service"
	| "online-school";

const t = (value: L, lang: Lang) => value[lang];

const COPY = {
	ru: {
		ctaPrimary: "Собрать vertical pack",
		ctaSecondary: "Обсудить демо",
		overviewBadge: "Vertical demo library",
		overviewTitle: [
			"Не один бот. ",
			"Разные операционные системы под разные бизнесы.",
		],
		overviewSub:
			"Каждая вертикаль показывает не переписку, а управляемую воронку: входящий запрос, поля, scoring, оффер, operator handoff, документы, оплата и статус сделки.",
		overviewBoard: "Вертикальные пульты",
		overviewBoardSub:
			"Один продуктовый слой. Разные workflow-правила, поля, базы знаний и точки решения.",
		implemented: "Implemented vertical packs",
		implementedSub:
			"Эти демо собраны по реальным vertical templates из продукта. Тэг ведёт на отдельный workflow-пульт.",
		liveSpecials: "Live specialty demos",
		openDemo: "Открыть demo",
		boardLabel: "Ops board",
		inputLabel: "Inbound",
		backboneLabel: "Workflow backbone",
		backboneTitle: "Стадии, поля и ответственный живут в карточке заявки",
		opsLabel: "Execution layer",
		opsTitle: "AI ведёт рутину, человек получает только решение",
		knowledgeLabel: "Knowledge + rules",
		knowledgeTitle: "Вертикаль знает документы, ограничения и следующий шаг",
		telegramLabel: "Client interface",
		telegramTitle: "Бот остаётся интерфейсом. Внутри работает workflow engine.",
		tagOverview: "all verticals",
		footer: {
			privacy: "Политика конфиденциальности",
			terms: "Условия использования",
			copy: "© 2026 Lead Engine",
		},
	},
	en: {
		ctaPrimary: "Build vertical pack",
		ctaSecondary: "Discuss demo",
		overviewBadge: "Vertical demo library",
		overviewTitle: [
			"Not one bot. ",
			"Different operating systems for different businesses.",
		],
		overviewSub:
			"Every vertical shows a managed funnel, not a chat: inbound request, fields, scoring, offer, operator handoff, documents, payment and deal status.",
		overviewBoard: "Vertical control rooms",
		overviewBoardSub:
			"One product layer. Different workflow rules, fields, knowledge bases and decision points.",
		implemented: "Implemented vertical packs",
		implementedSub:
			"These demos follow real vertical templates already present in the product. Each tag opens its own workflow control room.",
		liveSpecials: "Live specialty demos",
		openDemo: "Open demo",
		boardLabel: "Ops board",
		inputLabel: "Inbound",
		backboneLabel: "Workflow backbone",
		backboneTitle: "Stages, fields and owner live inside the request card",
		opsLabel: "Execution layer",
		opsTitle: "AI handles routine work, humans receive only the decision",
		knowledgeLabel: "Knowledge + rules",
		knowledgeTitle:
			"The vertical knows documents, constraints and the next step",
		telegramLabel: "Client interface",
		telegramTitle:
			"The bot is only the interface. Workflow engine runs inside.",
		tagOverview: "all verticals",
		footer: {
			privacy: "Privacy Policy",
			terms: "Terms of Use",
			copy: "© 2026 Lead Engine",
		},
	},
};

const SPECIAL_DEMOS: (L & { href: string; note: L })[] = [
	{
		ru: "exchange",
		en: "exchange",
		href: "/demo/workflows/exchange",
		note: {
			ru: "курс, KYC, реквизиты, проверка оплаты, выдача",
			en: "rate, KYC, requisites, payment check, payout",
		},
	},
	{
		ru: "multi-service desk",
		en: "multi-service desk",
		href: "/demo/services",
		note: {
			ru: "трансфер, уборка, массаж, жильё, provider marketplace",
			en: "transfer, cleaning, massage, housing, provider marketplace",
		},
	},
	{
		ru: "provider marketplace",
		en: "provider marketplace",
		href: "/demo/services#marketplace",
		note: {
			ru: "витрина исполнителей, установка в каталог, handoff",
			en: "provider shelf, catalog install, handoff",
		},
	},
];

const VERTICAL_ORDER: VerticalKey[] = [
	"recruitment",
	"real-estate",
	"visa",
	"scooter",
	"modeling",
	"video",
	"dental",
	"auto-service",
	"online-school",
];

const VERTICALS: Record<
	VerticalKey,
	{
		label: L;
		template: string;
		href: string;
		tone: "blue" | "green" | "amber" | "violet" | "cyan" | "red";
		title: L;
		sub: L;
		inbound: L;
		kpis: { value: string; label: L }[];
		fields: string[];
		stages: { phase: string; title: L; desc: L; owner: string }[];
		ops: { title: L; desc: L; status: L }[];
		knowledge: { title: L; desc: L }[];
		handoff: { title: L; desc: L; decision: L };
		messages: Record<Lang, TgMessage[]>;
	}
> = {
	recruitment: {
		label: { ru: "Рекрутинг", en: "Recruitment" },
		template: "recruitment_v1",
		href: "/demo/verticals/recruitment",
		tone: "blue",
		title: {
			ru: "Рекрутинг: кандидат проходит путь до анкеты и recruiter handoff",
			en: "Recruitment: candidate moves to intake and recruiter handoff",
		},
		sub: {
			ru: "AI не отвечает общими фразами. Он квалифицирует кандидата по вакансии, собирает анкету, проверяет готовность к релокации, подсвечивает риски и отдаёт рекрутеру только горячие карточки.",
			en: "AI does not answer with generic text. It qualifies against the job, collects intake, checks relocation readiness, highlights risks and hands recruiters only hot cards.",
		},
		inbound: {
			ru: "«Хочу работу в Дубае, танцевала 2 года, но боюсь по визе»",
			en: "“I want a job in Dubai, danced for 2 years, worried about visa”",
		},
		kpis: [
			{
				value: "32",
				label: { ru: "поля visa/intake", en: "visa/intake fields" },
			},
			{ value: "78%", label: { ru: "анкета собрана", en: "intake complete" } },
			{ value: "11", label: { ru: "горячие за день", en: "hot today" } },
		],
		fields: [
			"experience",
			"age",
			"city",
			"salary_expectation",
			"relocation_ready",
			"passport",
			"visa_history",
			"photos",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Первый интерес", en: "First interest" },
				desc: {
					ru: "AI понимает страну, роль и мотивацию.",
					en: "AI detects country, role and motivation.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Квалификация", en: "Qualification" },
				desc: {
					ru: "Опыт, документы, готовность, риски.",
					en: "Experience, documents, readiness, risks.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Подбор вакансии", en: "Job match" },
				desc: {
					ru: "Подходящая позиция и условия из базы знаний.",
					en: "Matched role and terms from knowledge base.",
				},
				owner: "AI",
			},
			{
				phase: "clear",
				title: { ru: "Visa form", en: "Visa form" },
				desc: {
					ru: "Пошаговая анкета, документы и фото.",
					en: "Step-by-step form, documents and photos.",
				},
				owner: "candidate",
			},
			{
				phase: "handoff",
				title: { ru: "Рекрутер", en: "Recruiter" },
				desc: {
					ru: "Готовый бриф и причина handoff.",
					en: "Complete brief and handoff reason.",
				},
				owner: "operator",
			},
		],
		ops: [
			{
				title: { ru: "Scoring", en: "Scoring" },
				desc: {
					ru: "Опыт 2 года, релокация возможна, страх по визе.",
					en: "2 years experience, relocation possible, visa concern.",
				},
				status: { ru: "qualified", en: "qualified" },
			},
			{
				title: { ru: "Missing fields", en: "Missing fields" },
				desc: {
					ru: "Паспорт, видео, рост, текущий город.",
					en: "Passport, video, height, current city.",
				},
				status: { ru: "collecting", en: "collecting" },
			},
			{
				title: { ru: "Recruiter brief", en: "Recruiter brief" },
				desc: {
					ru: "Горячая, нужен звонок и visa reassurance.",
					en: "Hot lead, needs call and visa reassurance.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "Вакансии и условия", en: "Jobs and terms" },
				desc: {
					ru: "AI отвечает по зарплатам, графику, жилью и контракту из KB.",
					en: "AI answers salary, schedule, housing and contract from KB.",
				},
			},
			{
				title: { ru: "Visa interview", en: "Visa interview" },
				desc: {
					ru: "32 поля анкеты, валидация дат, латиница, история виз.",
					en: "32 form fields, date validation, latin names, visa history.",
				},
			},
			{
				title: { ru: "NEPQ/SPIN", en: "NEPQ/SPIN" },
				desc: {
					ru: "Стиль ведёт к следующему шагу, а не просто информирует.",
					en: "Style moves to the next step instead of only informing.",
				},
			},
		],
		handoff: {
			title: { ru: "Когда нужен человек", en: "When human is needed" },
			desc: {
				ru: "Кандидат подходит, но боится визы и просит гарантий. Рекрутер получает короткий бриф, историю сообщений и готовый next best action.",
				en: "Candidate fits, but worries about visa and asks for guarantees. Recruiter gets a compact brief, message history and next best action.",
			},
			decision: { ru: "звонок рекрутера", en: "recruiter call" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Хочу работу в Дубае, танцевала 2 года, но боюсь по визе.",
				},
				{
					from: "bot",
					text: "Понял. Уточню опыт и документы, потом покажу подходящие варианты. Паспорт действующий есть?",
				},
				{ from: "user", text: "Да, паспорт есть. Мне 23, сейчас в Алматы." },
				{
					from: "bot",
					text: "Подходит под 2 вакансии. Осталось видео и рост. По визе рекрутер подключится и объяснит процесс.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "I want a Dubai job, danced for 2 years, but worried about visa.",
				},
				{
					from: "bot",
					text: "Got it. I will check experience and documents, then match roles. Do you have a valid passport?",
				},
				{ from: "user", text: "Yes. I am 23, currently in Almaty." },
				{
					from: "bot",
					text: "You match 2 roles. I still need video and height. Recruiter will step in to explain visa process.",
					cta: true,
				},
			],
		},
	},
	"real-estate": {
		label: { ru: "Недвижимость", en: "Real estate" },
		template: "real_estate_v1",
		href: "/demo/verticals/real-estate",
		tone: "green",
		title: {
			ru: "Недвижимость: qualification, viewings, MOU и DLD transfer",
			en: "Real estate: qualification, viewings, MOU and DLD transfer",
		},
		sub: {
			ru: "AI ведёт покупателя по реальному `real_estate_v1`: квартира или вилла, ready/off-plan, цель покупки, бюджет, способ оплаты, формат просмотра. Дальше карточка идёт через viewings, offer negotiation, MOU, NOC/ипотеку, handover support и DLD transfer.",
			en: "AI runs the buyer through the real `real_estate_v1`: apartment or villa, ready/off-plan, purchase goal, budget, payment method and viewing format. Then the card moves through viewings, offer negotiation, MOU, NOC/mortgage, handover support and DLD transfer.",
		},
		inbound: {
			ru: "«Ищу готовую 1BR квартиру в Dubai Marina до 1.4M AED, инвестиция, cash, хочу смотреть завтра»",
			en: "“Looking for a ready 1BR apartment in Dubai Marina under 1.4M AED, investment, cash, want viewing tomorrow”",
		},
		kpis: [
			{ value: "12", label: { ru: "intake fields", en: "intake fields" } },
			{ value: "8", label: { ru: "deal stages", en: "deal stages" } },
			{
				value: "4",
				label: { ru: "KB listings matched", en: "KB listings matched" },
			},
		],
		fields: [
			"property_type",
			"construction_status",
			"residency_goal",
			"bedrooms",
			"locations",
			"budget_usd",
			"payment_method",
			"market_type",
			"ownership_preference",
			"meeting_format",
			"contact_name",
			"contact_phone",
		],
		stages: [
			{
				phase: "qualification",
				title: { ru: "Квалификация", en: "Qualification" },
				desc: {
					ru: "Квартира/вилла, ready/off-plan, цель, спальни, район, бюджет.",
					en: "Apartment/villa, ready/off-plan, goal, bedrooms, area, budget.",
				},
				owner: "AI",
			},
			{
				phase: "viewings",
				title: { ru: "Просмотры", en: "Viewings" },
				desc: {
					ru: "RAG shortlist из KB, формат показа, слот, агент, reminder.",
					en: "RAG shortlist from KB, viewing format, slot, agent, reminder.",
				},
				owner: "AI + broker",
			},
			{
				phase: "offer_negotiation",
				title: { ru: "Оффер и переговоры", en: "Offer negotiation" },
				desc: {
					ru: "Цена, торг, service charge, yield только из KB context.",
					en: "Price, negotiation, service charge, yield only from KB context.",
				},
				owner: "broker",
			},
			{
				phase: "mou_signed",
				title: { ru: "MOU подписан", en: "MOU signed" },
				desc: {
					ru: "Form F или SPA, депозит, next steps по сделке.",
					en: "Form F or SPA, deposit, next steps for the deal.",
				},
				owner: "operator",
			},
			{
				phase: "noc_application",
				title: { ru: "NOC от застройщика", en: "Developer NOC" },
				desc: {
					ru: "Опциональная ветка для вторички: запрос NOC и контроль сроков.",
					en: "Optional resale branch: NOC request and timeline control.",
				},
				owner: "operator",
			},
			{
				phase: "mortgage_approval",
				title: { ru: "Одобрение ипотеки", en: "Mortgage approval" },
				desc: {
					ru: "Опциональная ветка: LTV, банк, документы, статус approval.",
					en: "Optional branch: LTV, bank, documents, approval status.",
				},
				owner: "mortgage broker",
			},
			{
				phase: "handover_support",
				title: { ru: "Платежи и приемка", en: "Payments and handover" },
				desc: {
					ru: "Платежный график, стройка, приемка, handover checklist.",
					en: "Payment schedule, construction, snagging, handover checklist.",
				},
				owner: "ops",
			},
			{
				phase: "dld_transfer",
				title: { ru: "Сделка закрыта", en: "Deal closed" },
				desc: {
					ru: "DLD transfer, статус won, документы сделки в карточке.",
					en: "DLD transfer, won status, deal documents in the card.",
				},
				owner: "broker",
			},
		],
		ops: [
			{
				title: { ru: "Qualification card", en: "Qualification card" },
				desc: {
					ru: "property_type=Квартира, construction_status=Готовый объект, residency_goal=Инвестиция.",
					en: "property_type=Apartment, construction_status=Ready, residency_goal=Investment.",
				},
				status: { ru: "qualified", en: "qualified" },
			},
			{
				title: { ru: "KB shortlist", en: "KB shortlist" },
				desc: {
					ru: "4 объекта из базы: район, метраж, цена, статус, yield без выдумок.",
					en: "4 listings from KB: area, size, price, status, yield without guessing.",
				},
				status: { ru: "matched", en: "matched" },
			},
			{
				title: { ru: "Viewing route", en: "Viewing route" },
				desc: {
					ru: "Офлайн просмотр завтра или онлайн-видеотур, агент и reminder.",
					en: "Offline viewing tomorrow or online video tour, agent and reminder.",
				},
				status: { ru: "viewings", en: "viewings" },
			},
			{
				title: { ru: "Deal clear gates", en: "Deal clear gates" },
				desc: {
					ru: "После MOU система ведёт NOC, ипотеку, платежи, приемку и DLD transfer.",
					en: "After MOU the system tracks NOC, mortgage, payments, handover and DLD transfer.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "База объектов", en: "Listings base" },
				desc: {
					ru: "Каждый объект в KB: тип, район, цена, площадь, статус, yield, ссылка.",
					en: "Each KB listing: type, area, price, size, status, yield, link.",
				},
			},
			{
				title: { ru: "Deal stages", en: "Deal stages" },
				desc: {
					ru: "viewings → offer_negotiation → mou_signed → NOC/ипотека → handover → DLD.",
					en: "viewings -> offer_negotiation -> mou_signed -> NOC/mortgage -> handover -> DLD.",
				},
			},
			{
				title: { ru: "Handoff broker", en: "Broker handoff" },
				desc: {
					ru: "Брокеру уходит карточка с intake, matched units, вопросом клиента и next action.",
					en: "Broker receives a card with intake, matched units, client question and next action.",
				},
			},
		],
		handoff: {
			title: { ru: "Где нужен брокер", en: "Where broker is needed" },
			desc: {
				ru: "AI собрал intake, shortlist и viewing route. Человек нужен для переговоров по цене, проверки объекта, MOU/SPA и сделочных clear-gates.",
				en: "AI collected intake, shortlist and viewing route. Human is needed for price negotiation, property check, MOU/SPA and deal clear gates.",
			},
			decision: { ru: "offer + MOU decision", en: "offer + MOU decision" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Ищу готовую 1BR квартиру в Dubai Marina до 1.4M AED, инвестиция, cash, хочу смотреть завтра.",
				},
				{
					from: "bot",
					text: "Принял: квартира, готовый объект, Marina, 1BR, до 1.4M AED, инвестиция, cash. Интересует первичка, resale или оба варианта?",
				},
				{
					from: "user",
					text: "Можно оба, но freehold. Хочу ROI и service charge.",
				},
				{
					from: "bot",
					text: "Нашёл 4 объекта из базы. Yield покажу только там, где он подтверждён. Есть просмотр завтра 12:30 и видеотур 16:00. Брокер проверит торг и MOU-условия.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Looking for a ready 1BR apartment in Dubai Marina under 1.4M AED, investment, cash, viewing tomorrow.",
				},
				{
					from: "bot",
					text: "Captured: apartment, ready unit, Marina, 1BR, under 1.4M AED, investment, cash. Primary, resale or both?",
				},
				{
					from: "user",
					text: "Both are fine, but freehold. Need ROI and service charge.",
				},
				{
					from: "bot",
					text: "Found 4 listings from KB. I will show yield only where confirmed. Viewing tomorrow 12:30 and video tour 16:00. Broker will check negotiation and MOU terms.",
					cta: true,
				},
			],
		},
	},
	visa: {
		label: { ru: "Visa & Immigration", en: "Visa & Immigration" },
		template: "visa_v1",
		href: "/demo/verticals/visa",
		tone: "amber",
		title: {
			ru: "Визы: eligibility, документы, оплата и lawyer handoff",
			en: "Visa: eligibility, documents, payment and lawyer handoff",
		},
		sub: {
			ru: "AI определяет тип визы, гражданство, сроки, бюджет и риски. Затем собирает документы, строит checklist, объясняет требования из базы знаний и зовёт специалиста только на проверку.",
			en: "AI identifies visa type, nationality, timeline, budget and risks. Then it collects documents, builds checklist, explains requirements from KB and calls specialist only for review.",
		},
		inbound: {
			ru: "«Хочу Thailand Privilege, паспорт РФ, семья 3 человека, нужно понять сроки и документы»",
			en: "“Need Thailand Privilege, Russian passport, family of 3, want timeline and documents”",
		},
		kpis: [
			{
				value: "18",
				label: { ru: "документов в checklist", en: "documents in checklist" },
			},
			{ value: "3", label: { ru: "члена семьи", en: "family members" } },
			{ value: "1", label: { ru: "legal review", en: "legal review" } },
		],
		fields: [
			"nationality",
			"visa_type",
			"family_size",
			"passport_scan",
			"bank_statement",
			"timeline",
			"budget",
			"risk_flags",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Eligibility", en: "Eligibility" },
				desc: {
					ru: "Тип визы, гражданство, цель, сроки.",
					en: "Visa type, nationality, goal, timeline.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Checklist", en: "Checklist" },
				desc: {
					ru: "Документы под конкретный кейс.",
					en: "Documents for this exact case.",
				},
				owner: "AI",
			},
			{
				phase: "clear",
				title: { ru: "Document intake", en: "Document intake" },
				desc: {
					ru: "Паспорт, выписки, фото, OCR.",
					en: "Passport, statements, photos, OCR.",
				},
				owner: "client",
			},
			{
				phase: "offer",
				title: { ru: "Service quote", en: "Service quote" },
				desc: {
					ru: "Стоимость, timeline, условия оплаты.",
					en: "Price, timeline, payment terms.",
				},
				owner: "AI",
			},
			{
				phase: "handoff",
				title: { ru: "Legal review", en: "Legal review" },
				desc: {
					ru: "Юрист проверяет риск и финальный пакет.",
					en: "Lawyer checks risk and final package.",
				},
				owner: "operator",
			},
		],
		ops: [
			{
				title: { ru: "Eligibility result", en: "Eligibility result" },
				desc: {
					ru: "Подходит Privilege, family package, без красных флагов.",
					en: "Privilege fit, family package, no red flags.",
				},
				status: { ru: "eligible", en: "eligible" },
			},
			{
				title: { ru: "Document gap", en: "Document gap" },
				desc: {
					ru: "Нет выписки за 6 месяцев и фото ребёнка.",
					en: "Missing 6-month statement and child photo.",
				},
				status: { ru: "collecting", en: "collecting" },
			},
			{
				title: { ru: "Lawyer review", en: "Lawyer review" },
				desc: {
					ru: "Проверить семейный пакет и сроки подачи.",
					en: "Check family package and submission timeline.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "RAG по требованиям", en: "Requirements RAG" },
				desc: {
					ru: "AI отвечает по актуальным правилам, срокам и списку документов.",
					en: "AI answers from current rules, timelines and document list.",
				},
			},
			{
				title: { ru: "OCR документов", en: "Document OCR" },
				desc: {
					ru: "Паспорт и формы превращаются в поля карточки.",
					en: "Passport and forms become request-card fields.",
				},
			},
			{
				title: { ru: "Risk flags", en: "Risk flags" },
				desc: {
					ru: "Спорные кейсы уходят специалисту до обещаний клиенту.",
					en: "Ambiguous cases go to specialist before promises.",
				},
			},
		],
		handoff: {
			title: { ru: "Где нужен специалист", en: "Where specialist is needed" },
			desc: {
				ru: "AI собрал checklist и документы. Человек проверяет риски, eligibility и финальное коммерческое предложение.",
				en: "AI collected checklist and documents. Human verifies risks, eligibility and final commercial offer.",
			},
			decision: { ru: "legal approval", en: "legal approval" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Хочу Thailand Privilege, паспорт РФ, семья 3 человека, сроки и документы?",
				},
				{
					from: "bot",
					text: "Подходит. Уточню состав семьи, сроки въезда и бюджет, затем соберу checklist.",
				},
				{ from: "user", text: "2 взрослых и ребёнок, хотим начать в июле." },
				{
					from: "bot",
					text: "Собрал checklist на 18 документов. Нужны паспортные сканы и bank statement. Специалист проверит family package.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need Thailand Privilege, Russian passport, family of 3. Timeline and documents?",
				},
				{
					from: "bot",
					text: "Looks eligible. I will confirm family members, arrival timeline and budget, then build checklist.",
				},
				{ from: "user", text: "2 adults and a child, want to start in July." },
				{
					from: "bot",
					text: "Checklist has 18 documents. Need passport scans and bank statement. Specialist will review family package.",
					cta: true,
				},
			],
		},
	},
	scooter: {
		label: { ru: "Scooter rental", en: "Scooter rental" },
		template: "scooter_v1",
		href: "/demo/verticals/scooter",
		tone: "cyan",
		title: {
			ru: "Аренда байков: наличие, права, депозит, доставка и возврат",
			en: "Scooter rental: availability, license, deposit, delivery and return",
		},
		sub: {
			ru: "AI собирает даты, модель, права, адрес доставки и депозит. Он не отдаёт менеджеру каждое «сколько стоит», а доводит заявку до брони и reminder по возврату.",
			en: "AI collects dates, model, license, delivery address and deposit. It does not hand every price question to a manager, it moves the request to booking and return reminder.",
		},
		inbound: {
			ru: "«Нужен PCX на 10 дней с доставкой в Rawai, права есть, сколько депозит?»",
			en: "“Need PCX for 10 days delivered to Rawai, have license, deposit?”",
		},
		kpis: [
			{ value: "42", label: { ru: "заявки сегодня", en: "requests today" } },
			{ value: "9", label: { ru: "моделей доступно", en: "models available" } },
			{ value: "฿3k", label: { ru: "депозит", en: "deposit" } },
		],
		fields: [
			"dates",
			"model",
			"license",
			"delivery_address",
			"helmet_count",
			"deposit",
			"insurance",
			"return_time",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Inquiry", en: "Inquiry" },
				desc: {
					ru: "Даты, модель, адрес, количество шлемов.",
					en: "Dates, model, address, helmet count.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "License check", en: "License check" },
				desc: {
					ru: "Права обязательны до брони.",
					en: "License required before booking.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Availability", en: "Availability" },
				desc: {
					ru: "Модель, цена, депозит, страховка.",
					en: "Model, price, deposit, insurance.",
				},
				owner: "system",
			},
			{
				phase: "clear",
				title: { ru: "QR deposit", en: "QR deposit" },
				desc: {
					ru: "Оплата депозита и подтверждение.",
					en: "Deposit payment and confirmation.",
				},
				owner: "client",
			},
			{
				phase: "fulfill",
				title: { ru: "Delivery", en: "Delivery" },
				desc: {
					ru: "Курьер, ETA, фото выдачи, reminder.",
					en: "Courier, ETA, handover photo, reminder.",
				},
				owner: "operator",
			},
		],
		ops: [
			{
				title: { ru: "Inventory match", en: "Inventory match" },
				desc: {
					ru: "PCX доступен, fallback NMAX, доставка Rawai.",
					en: "PCX available, NMAX fallback, Rawai delivery.",
				},
				status: { ru: "available", en: "available" },
			},
			{
				title: { ru: "License required", en: "License required" },
				desc: {
					ru: "AI просит фото прав до QR.",
					en: "AI asks for license photo before QR.",
				},
				status: { ru: "required", en: "required" },
			},
			{
				title: { ru: "Delivery handoff", en: "Delivery handoff" },
				desc: {
					ru: "Оператор назначает курьера и время.",
					en: "Operator assigns courier and time.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "Inventory rules", en: "Inventory rules" },
				desc: {
					ru: "Доступность моделей, замены, минимальные сроки.",
					en: "Model availability, replacements, minimum terms.",
				},
			},
			{
				title: { ru: "Safety gate", en: "Safety gate" },
				desc: {
					ru: "Без прав заявка не уходит в оплату.",
					en: "No license means no payment stage.",
				},
			},
			{
				title: { ru: "Return automation", en: "Return automation" },
				desc: {
					ru: "Reminder за день, штрафы, фото возврата.",
					en: "Reminder one day before, penalties, return photos.",
				},
			},
		],
		handoff: {
			title: { ru: "Где нужен оператор", en: "Where operator is needed" },
			desc: {
				ru: "AI собрал бронь и проверил права. Оператор нужен только для доставки, замены модели или спорного депозита.",
				en: "AI collected booking and checked license. Operator is needed only for delivery, model replacement or disputed deposit.",
			},
			decision: { ru: "назначить курьера", en: "assign courier" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужен PCX на 10 дней с доставкой в Rawai, права есть, сколько депозит?",
				},
				{
					from: "bot",
					text: "PCX доступен. Депозит ฿3 000, доставка Rawai возможна. Пришлите фото прав?",
				},
				{ from: "user", text: "Сейчас пришлю. Нужны два шлема." },
				{
					from: "bot",
					text: "Добавил 2 шлема. После проверки прав отправлю QR на депозит и назначу доставку.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need PCX for 10 days delivered to Rawai, have license, deposit?",
				},
				{
					from: "bot",
					text: "PCX is available. Deposit is ฿3,000, Rawai delivery possible. Send license photo?",
				},
				{ from: "user", text: "Sending now. Need two helmets." },
				{
					from: "bot",
					text: "Added 2 helmets. After license check I will send deposit QR and schedule delivery.",
					cta: true,
				},
			],
		},
	},
	modeling: {
		label: { ru: "Modeling agency", en: "Modeling agency" },
		template: "modeling_v1",
		href: "/demo/verticals/modeling",
		tone: "violet",
		title: {
			ru: "Модельное агентство: intake, портфолио, casting review, контракт",
			en: "Modeling agency: intake, portfolio, casting review, contract",
		},
		sub: {
			ru: "AI собирает параметры, фото, видео, опыт, город и доступность. Кастинг-директор получает не пачку сообщений, а карточку кандидата с missing assets и решением.",
			en: "AI collects measurements, photos, video, experience, city and availability. Casting director gets a candidate card with missing assets and decision, not a pile of messages.",
		},
		inbound: {
			ru: "«Хочу попасть на кастинги в Дубае, фото есть, опыта мало»",
			en: "“Want castings in Dubai, have photos, limited experience”",
		},
		kpis: [
			{ value: "6", label: { ru: "assets needed", en: "assets needed" } },
			{ value: "24ч", label: { ru: "casting SLA", en: "casting SLA" } },
			{ value: "3", label: { ru: "рынка", en: "markets" } },
		],
		fields: [
			"height",
			"age",
			"city",
			"portfolio",
			"video_intro",
			"experience",
			"travel_ready",
			"contract_status",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Intake", en: "Intake" },
				desc: {
					ru: "Данные кандидата и ожидания.",
					en: "Candidate data and expectations.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Portfolio check", en: "Portfolio check" },
				desc: {
					ru: "Фото, видео, параметры, опыт.",
					en: "Photos, video, measurements, experience.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Casting review", en: "Casting review" },
				desc: {
					ru: "Подходит ли под рынок и бренд.",
					en: "Fit for market and brand.",
				},
				owner: "operator",
			},
			{
				phase: "fulfill",
				title: { ru: "Contract", en: "Contract" },
				desc: {
					ru: "Оффер, условия, show confirmation.",
					en: "Offer, terms, show confirmation.",
				},
				owner: "agent",
			},
			{
				phase: "won",
				title: { ru: "Show booked", en: "Show booked" },
				desc: {
					ru: "Подтверждение показа или съёмки.",
					en: "Show or shoot confirmation.",
				},
				owner: "system",
			},
		],
		ops: [
			{
				title: { ru: "Portfolio gap", en: "Portfolio gap" },
				desc: {
					ru: "Нет видео-интро и full-body фото.",
					en: "Missing intro video and full-body photo.",
				},
				status: { ru: "collecting", en: "collecting" },
			},
			{
				title: { ru: "Market fit", en: "Market fit" },
				desc: {
					ru: "Dubai/Europe возможны, нужен casting review.",
					en: "Dubai/Europe possible, casting review needed.",
				},
				status: { ru: "review", en: "review" },
			},
			{
				title: { ru: "Agent handoff", en: "Agent handoff" },
				desc: {
					ru: "Директор смотрит assets и принимает решение.",
					en: "Director reviews assets and decides.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "Casting criteria", en: "Casting criteria" },
				desc: {
					ru: "Рынок, рост, опыт, доступность, portfolio rules.",
					en: "Market, height, experience, availability, portfolio rules.",
				},
			},
			{
				title: { ru: "Asset gate", en: "Asset gate" },
				desc: {
					ru: "AI не двигает карточку без нужных фото/видео.",
					en: "AI does not move card without required photos/videos.",
				},
			},
			{
				title: { ru: "Offer terms", en: "Offer terms" },
				desc: {
					ru: "Контракт, город, show terms, travel requirements.",
					en: "Contract, city, show terms, travel requirements.",
				},
			},
		],
		handoff: {
			title: {
				ru: "Где нужен casting director",
				en: "Where casting director is needed",
			},
			desc: {
				ru: "AI собрал assets и параметры. Человек принимает субъективное решение: market fit, бренд, ставка, оффер.",
				en: "AI collected assets and measurements. Human makes subjective decision: market fit, brand, fee, offer.",
			},
			decision: { ru: "casting decision", en: "casting decision" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Хочу попасть на кастинги в Дубае, фото есть, опыта мало.",
				},
				{
					from: "bot",
					text: "Понял. Уточню параметры, город и availability. Потом попрошу фото и короткое видео.",
				},
				{ from: "user", text: "Рост 174, 21 год, могу лететь через месяц." },
				{
					from: "bot",
					text: "Подходит для первичного review. Пришлите full-body фото и видео-интро, директор посмотрит карточку.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Want castings in Dubai, have photos, limited experience.",
				},
				{
					from: "bot",
					text: "Got it. I will check measurements, city and availability, then ask for photos and short video.",
				},
				{
					from: "user",
					text: "Height 174, 21 years old, can travel next month.",
				},
				{
					from: "bot",
					text: "Good for first review. Send full-body photo and intro video, director will review the card.",
					cta: true,
				},
			],
		},
	},
	video: {
		label: { ru: "Video production", en: "Video production" },
		template: "video_v1",
		href: "/demo/verticals/video",
		tone: "red",
		title: {
			ru: "Видеопродакшн: бриф, смета, съёмка, монтаж и сдача",
			en: "Video production: brief, quote, shoot, editing and delivery",
		},
		sub: {
			ru: "AI превращает размытый запрос в production brief: формат, локация, сроки, референсы, бюджет, команда. Продюсер подключается на смету и календарь.",
			en: "AI turns a vague request into a production brief: format, location, deadline, references, budget, crew. Producer joins for quote and calendar.",
		},
		inbound: {
			ru: "«Нужно снять рекламу виллы и reels за неделю, есть референсы, бюджет до $3k»",
			en: "“Need villa ad and reels within a week, have references, budget up to $3k”",
		},
		kpis: [
			{ value: "$3k", label: { ru: "budget cap", en: "budget cap" } },
			{ value: "7д", label: { ru: "deadline", en: "deadline" } },
			{ value: "5", label: { ru: "brief blocks", en: "brief blocks" } },
		],
		fields: [
			"format",
			"location",
			"deadline",
			"references",
			"budget",
			"crew",
			"deliverables",
			"revision_policy",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Inquiry", en: "Inquiry" },
				desc: {
					ru: "Формат, срок, бюджет, цель ролика.",
					en: "Format, deadline, budget, goal.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Brief call", en: "Brief call" },
				desc: {
					ru: "Референсы, deliverables, команда.",
					en: "References, deliverables, crew.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Quote", en: "Quote" },
				desc: { ru: "Смета, календарь, scope.", en: "Quote, calendar, scope." },
				owner: "producer",
			},
			{
				phase: "fulfill",
				title: { ru: "Production", en: "Production" },
				desc: {
					ru: "Съёмка, монтаж, ревизии.",
					en: "Shoot, editing, revisions.",
				},
				owner: "team",
			},
			{
				phase: "won",
				title: { ru: "Delivery", en: "Delivery" },
				desc: {
					ru: "Файлы, invoice, follow-up.",
					en: "Files, invoice, follow-up.",
				},
				owner: "system",
			},
		],
		ops: [
			{
				title: { ru: "Brief status", en: "Brief status" },
				desc: {
					ru: "Формат и бюджет есть, не хватает референсов.",
					en: "Format and budget ready, references missing.",
				},
				status: { ru: "intake", en: "intake" },
			},
			{
				title: { ru: "Producer quote", en: "Producer quote" },
				desc: {
					ru: "Нужна ручная смета по команде и аренде.",
					en: "Manual quote needed for crew and rental.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
			{
				title: { ru: "Delivery plan", en: "Delivery plan" },
				desc: {
					ru: "Ad cut, 6 reels, 2 revision rounds.",
					en: "Ad cut, 6 reels, 2 revision rounds.",
				},
				status: { ru: "planned", en: "planned" },
			},
		],
		knowledge: [
			{
				title: { ru: "Production packages", en: "Production packages" },
				desc: {
					ru: "Пакеты, ставки команды, аренда техники, ревизии.",
					en: "Packages, crew rates, equipment rental, revisions.",
				},
			},
			{
				title: { ru: "Brief guardrails", en: "Brief guardrails" },
				desc: {
					ru: "AI не обещает съёмку без календаря и сметы.",
					en: "AI does not promise shoot without calendar and quote.",
				},
			},
			{
				title: { ru: "Delivery tracking", en: "Delivery tracking" },
				desc: {
					ru: "Сроки монтажа, approve/revise, invoice.",
					en: "Editing deadlines, approve/revise, invoice.",
				},
			},
		],
		handoff: {
			title: { ru: "Где нужен продюсер", en: "Where producer is needed" },
			desc: {
				ru: "AI собрал бриф и ограничения. Продюсер считает смету, календарь и решает, потянет ли команда deadline.",
				en: "AI collected brief and constraints. Producer prices scope, calendar and decides if team can hit deadline.",
			},
			decision: { ru: "quote approval", en: "quote approval" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Нужно снять рекламу виллы и reels за неделю, есть референсы, бюджет до $3k.",
				},
				{
					from: "bot",
					text: "Принял. Уточню формат: сколько reels, нужна ли модель/дрон/озвучка и где локация?",
				},
				{ from: "user", text: "6 reels, дрон нужен, вилла в Bang Tao." },
				{
					from: "bot",
					text: "Бриф собран. Продюсер проверит календарь и смету под deadline, затем пришлю оффер.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Need villa ad and reels within a week, have references, budget up to $3k.",
				},
				{
					from: "bot",
					text: "Captured. How many reels, do you need model/drone/voiceover and where is location?",
				},
				{ from: "user", text: "6 reels, drone needed, villa in Bang Tao." },
				{
					from: "bot",
					text: "Brief is ready. Producer will check calendar and quote for the deadline, then I will send offer.",
					cta: true,
				},
			],
		},
	},
	dental: {
		label: { ru: "Стоматология", en: "Dental clinic" },
		template: "dental_v1",
		href: "/demo/verticals/dental",
		tone: "cyan",
		title: {
			ru: "Стоматология: жалоба, страховка, запись на приём и напоминания",
			en: "Dental clinic: complaint, insurance, appointment and reminders",
		},
		sub: {
			ru: "AI собирает жалобу, срочность, страховку и удобное время, предлагает свободные слоты и подтверждает запись. Администратор получает заполненную карточку пациента, а не телефонную очередь.",
			en: "AI collects complaint, urgency, insurance and preferred time, offers free slots and confirms the visit. Front desk receives a complete patient card instead of a phone queue.",
		},
		inbound: {
			ru: "«Болит зуб справа внизу третий день, есть полис ДМС, можно сегодня вечером?»",
			en: "“Lower right tooth hurts for 3 days, have insurance, any slot tonight?”",
		},
		kpis: [
			{ value: "14", label: { ru: "записей сегодня", en: "bookings today" } },
			{ value: "92%", label: { ru: "доходимость", en: "show-up rate" } },
			{ value: "2", label: { ru: "срочных кейса", en: "urgent cases" } },
		],
		fields: [
			"complaint",
			"pain_level",
			"urgency",
			"insurance_provider",
			"policy_number",
			"preferred_time",
			"doctor",
			"last_visit",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Жалоба", en: "Complaint" },
				desc: {
					ru: "Симптом, локализация, давность, уровень боли.",
					en: "Symptom, location, duration, pain level.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Triage", en: "Triage" },
				desc: {
					ru: "Срочность, страховка, история визитов.",
					en: "Urgency, insurance, visit history.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Слоты", en: "Slots" },
				desc: {
					ru: "Врач, кабинет, свободное время из расписания.",
					en: "Doctor, room, free time from the schedule.",
				},
				owner: "system",
			},
			{
				phase: "clear",
				title: { ru: "Запись", en: "Booking" },
				desc: {
					ru: "Подтверждение, полис, предоплата если нужна.",
					en: "Confirmation, policy, prepayment if required.",
				},
				owner: "patient",
			},
			{
				phase: "fulfill",
				title: { ru: "Приём", en: "Visit" },
				desc: {
					ru: "Reminder за день и за 2 часа, перенос, no-show flow.",
					en: "Reminder one day and 2 hours before, reschedule, no-show flow.",
				},
				owner: "operator",
			},
		],
		ops: [
			{
				title: { ru: "Triage result", en: "Triage result" },
				desc: {
					ru: "Острая боль 3 дня, не экстренный, но слот нужен сегодня.",
					en: "Acute pain for 3 days, not emergency, but needs slot today.",
				},
				status: { ru: "urgent", en: "urgent" },
			},
			{
				title: { ru: "Insurance check", en: "Insurance check" },
				desc: {
					ru: "ДМС принят, нужен номер полиса до подтверждения.",
					en: "Insurance accepted, policy number needed before confirmation.",
				},
				status: { ru: "collecting", en: "collecting" },
			},
			{
				title: { ru: "Front desk handoff", en: "Front desk handoff" },
				desc: {
					ru: "Администратор подтверждает слот 19:30 и кабинет.",
					en: "Front desk confirms the 19:30 slot and room.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "Услуги и цены", en: "Services and prices" },
				desc: {
					ru: "AI отвечает по лечению, имплантации, гигиене и ценам из KB.",
					en: "AI answers treatment, implants, hygiene and prices from KB.",
				},
			},
			{
				title: { ru: "Insurance rules", en: "Insurance rules" },
				desc: {
					ru: "Какие полисы приняты, что покрыто, когда нужна доплата.",
					en: "Accepted policies, coverage, when co-payment applies.",
				},
			},
			{
				title: { ru: "Medical guardrails", en: "Medical guardrails" },
				desc: {
					ru: "AI не ставит диагноз: симптомы фиксирует, решение за врачом.",
					en: "AI never diagnoses: it records symptoms, doctor decides.",
				},
			},
		],
		handoff: {
			title: {
				ru: "Где нужен администратор",
				en: "Where front desk is needed",
			},
			desc: {
				ru: "AI собрал жалобу, страховку и выбранный слот. Администратор подтверждает запись, решает спорные случаи по полису и ведёт переносы.",
				en: "AI collected complaint, insurance and chosen slot. Front desk confirms the booking, resolves policy edge cases and handles reschedules.",
			},
			decision: { ru: "подтвердить запись", en: "confirm booking" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Болит зуб справа внизу третий день, есть полис ДМС, можно сегодня вечером?",
				},
				{
					from: "bot",
					text: "Зафиксировал: острая боль, нижняя правая сторона, 3 дня. Оцените боль от 1 до 10 и назовите страховую?",
				},
				{ from: "user", text: "Боль 7, страховая — Ингосстрах." },
				{
					from: "bot",
					text: "Полис принимаем. Свободны слоты у терапевта: сегодня 19:30 или завтра 10:00. Какой удобнее?",
				},
				{ from: "user", text: "Сегодня 19:30." },
				{
					from: "bot",
					text: "Записал на 19:30, кабинет 3. Пришлите номер полиса — администратор подтвердит запись и пришлёт напоминание за 2 часа.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Lower right tooth hurts for 3 days, have insurance, any slot tonight?",
				},
				{
					from: "bot",
					text: "Recorded: acute pain, lower right side, 3 days. Rate the pain 1-10 and name your insurance provider?",
				},
				{ from: "user", text: "Pain is 7, provider is Allianz." },
				{
					from: "bot",
					text: "Policy accepted. Free dentist slots: today 19:30 or tomorrow 10:00. Which works?",
				},
				{ from: "user", text: "Today 19:30." },
				{
					from: "bot",
					text: "Booked for 19:30, room 3. Send your policy number — front desk will confirm and you will get a reminder 2 hours before.",
					cta: true,
				},
			],
		},
	},
	"auto-service": {
		label: { ru: "Автосервис", en: "Auto service" },
		template: "auto_service_v1",
		href: "/demo/verticals/auto-service",
		tone: "amber",
		title: {
			ru: "Автосервис: машина, проблема, фото, оценка и запись в бокс",
			en: "Auto service: car, problem, photos, estimate and bay booking",
		},
		sub: {
			ru: "AI собирает марку, модель, год, пробег, описание проблемы и фото. Клиент получает предварительную вилку по цене и слот в бокс, мастер — готовую карточку вместо «алло, у меня что-то стучит».",
			en: "AI collects make, model, year, mileage, problem description and photos. Client gets a preliminary price range and a bay slot, mechanic gets a complete card instead of “hi, something is knocking”.",
		},
		inbound: {
			ru: "«Camry 2019, при торможении бьёт руль, пробег 95 тыс., когда можно заехать?»",
			en: "“Camry 2019, steering wheel shakes when braking, 95k km, when can I come?”",
		},
		kpis: [
			{ value: "27", label: { ru: "заявок сегодня", en: "requests today" } },
			{ value: "4", label: { ru: "бокса свободно", en: "bays free" } },
			{ value: "85%", label: { ru: "смета согласована", en: "estimates approved" } },
		],
		fields: [
			"make",
			"model",
			"year",
			"mileage",
			"problem_description",
			"photos",
			"preliminary_estimate",
			"bay_slot",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Заявка", en: "Inquiry" },
				desc: {
					ru: "Марка, модель, год, пробег, симптом.",
					en: "Make, model, year, mileage, symptom.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Диагностика по описанию", en: "Remote diagnosis" },
				desc: {
					ru: "Уточняющие вопросы, фото/видео проблемы.",
					en: "Clarifying questions, photos/video of the issue.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Предварительная оценка", en: "Preliminary estimate" },
				desc: {
					ru: "Вилка по работам и запчастям из прайса KB.",
					en: "Range for labor and parts from KB price list.",
				},
				owner: "AI",
			},
			{
				phase: "clear",
				title: { ru: "Запись в бокс", en: "Bay booking" },
				desc: {
					ru: "Слот, бокс, мастер, подтверждение клиента.",
					en: "Slot, bay, mechanic, client confirmation.",
				},
				owner: "client",
			},
			{
				phase: "fulfill",
				title: { ru: "Согласование работ", en: "Work approval" },
				desc: {
					ru: "Финальная смета после осмотра, approve в чате, статус ремонта.",
					en: "Final estimate after inspection, in-chat approval, repair status.",
				},
				owner: "operator",
			},
		],
		ops: [
			{
				title: { ru: "Symptom match", en: "Symptom match" },
				desc: {
					ru: "Биение при торможении: вероятно диски, нужна проходка подвески.",
					en: "Shaking under braking: likely rotors, suspension check needed.",
				},
				status: { ru: "qualified", en: "qualified" },
			},
			{
				title: { ru: "Estimate range", en: "Estimate range" },
				desc: {
					ru: "Замена дисков и колодок: 12–18 тыс. с работой по прайсу.",
					en: "Rotors and pads replacement: $150-220 with labor per price list.",
				},
				status: { ru: "sent", en: "sent" },
			},
			{
				title: { ru: "Master handoff", en: "Mechanic handoff" },
				desc: {
					ru: "После осмотра мастер шлёт финальную смету на согласование.",
					en: "After inspection mechanic sends final estimate for approval.",
				},
				status: { ru: "handoff", en: "handoff" },
			},
		],
		knowledge: [
			{
				title: { ru: "Прайс работ", en: "Labor price list" },
				desc: {
					ru: "Нормо-часы, типовые работы, запчасти, сроки поставки.",
					en: "Labor hours, common jobs, parts, delivery timelines.",
				},
			},
			{
				title: { ru: "Estimate guardrails", en: "Estimate guardrails" },
				desc: {
					ru: "AI даёт только вилку: финальная цена после осмотра в боксе.",
					en: "AI gives only a range: final price comes after bay inspection.",
				},
			},
			{
				title: { ru: "Approval flow", en: "Approval flow" },
				desc: {
					ru: "Доп. работы не начинаются без согласия клиента в чате.",
					en: "Extra work never starts without client approval in chat.",
				},
			},
		],
		handoff: {
			title: { ru: "Где нужен мастер", en: "Where mechanic is needed" },
			desc: {
				ru: "AI собрал машину, симптом, фото и записал в бокс. Мастер осматривает, выставляет финальную смету и согласует доп. работы через ту же карточку.",
				en: "AI collected the car, symptom, photos and booked the bay. Mechanic inspects, issues the final estimate and approves extra work through the same card.",
			},
			decision: { ru: "финальная смета", en: "final estimate" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Camry 2019, при торможении бьёт руль, пробег 95 тыс. Когда можно заехать?",
				},
				{
					from: "bot",
					text: "Принял: Camry 2019, 95 тыс., биение при торможении. Вибрация на любой скорости или только на высокой? Фото дисков, если есть.",
				},
				{ from: "user", text: "Сильнее после 80 км/ч. Фото скину вечером." },
				{
					from: "bot",
					text: "Похоже на передние диски. Предварительно: диски + колодки 12–18 тыс. с работой. Точно скажем после осмотра.",
				},
				{ from: "user", text: "Ок, давайте завтра утром." },
				{
					from: "bot",
					text: "Записал: завтра 9:00, бокс 2, мастер Сергей. После осмотра пришлём финальную смету на согласование прямо сюда.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Camry 2019, steering wheel shakes when braking, 95k km. When can I come?",
				},
				{
					from: "bot",
					text: "Captured: Camry 2019, 95k km, shaking under braking. Does it vibrate at any speed or only at higher speed? Send rotor photos if you have them.",
				},
				{ from: "user", text: "Worse above 80 km/h. Photos tonight." },
				{
					from: "bot",
					text: "Sounds like front rotors. Preliminary range: rotors + pads $150-220 with labor. Exact price after inspection.",
				},
				{ from: "user", text: "Ok, tomorrow morning works." },
				{
					from: "bot",
					text: "Booked: tomorrow 9:00, bay 2, mechanic Sergey. After inspection we will send the final estimate for approval right here.",
					cta: true,
				},
			],
		},
	},
	"online-school": {
		label: { ru: "Онлайн-школа", en: "Online school" },
		template: "online_school_v1",
		href: "/demo/verticals/online-school",
		tone: "violet",
		title: {
			ru: "Онлайн-школа: курс, уровень, цель, оплата и follow-up неактивных",
			en: "Online school: course, level, goal, payment and inactive follow-up",
		},
		sub: {
			ru: "AI подбирает курс под уровень и цель, отвечает по программе из базы знаний, выставляет счёт и выдаёт доступ. Дальше воронка не заканчивается: система возвращает тех, кто перестал учиться.",
			en: "AI matches a course to level and goal, answers program questions from KB, issues an invoice and grants access. The funnel does not stop there: the system re-engages students who went inactive.",
		},
		inbound: {
			ru: "«Хочу выучить английский до B2 за полгода для работы, занимался давно, сколько стоит?»",
			en: "“Want English up to B2 in six months for work, studied long ago, how much?”",
		},
		kpis: [
			{ value: "38", label: { ru: "лидов за день", en: "leads today" } },
			{ value: "64%", label: { ru: "оплата после теста", en: "pay after test" } },
			{ value: "9", label: { ru: "возвращено follow-up", en: "won back by follow-up" } },
		],
		fields: [
			"course",
			"current_level",
			"goal",
			"deadline",
			"schedule_preference",
			"payment_plan",
			"access_status",
			"last_activity",
		],
		stages: [
			{
				phase: "capture",
				title: { ru: "Запрос", en: "Inquiry" },
				desc: {
					ru: "Курс, цель, дедлайн, прошлый опыт.",
					en: "Course, goal, deadline, past experience.",
				},
				owner: "AI",
			},
			{
				phase: "qualify",
				title: { ru: "Уровень", en: "Level check" },
				desc: {
					ru: "Placement-тест и рекомендация группы.",
					en: "Placement test and group recommendation.",
				},
				owner: "AI",
			},
			{
				phase: "offer",
				title: { ru: "Подбор курса", en: "Course match" },
				desc: {
					ru: "Программа, тариф, расписание из KB.",
					en: "Program, plan, schedule from KB.",
				},
				owner: "AI",
			},
			{
				phase: "clear",
				title: { ru: "Оплата", en: "Payment" },
				desc: {
					ru: "Счёт, рассрочка, подтверждение оплаты.",
					en: "Invoice, installments, payment confirmation.",
				},
				owner: "client",
			},
			{
				phase: "fulfill",
				title: { ru: "Доступ + retention", en: "Access + retention" },
				desc: {
					ru: "Выдача материалов, прогресс, follow-up неактивных.",
					en: "Materials access, progress, inactive follow-up.",
				},
				owner: "system",
			},
		],
		ops: [
			{
				title: { ru: "Placement result", en: "Placement result" },
				desc: {
					ru: "Уровень A2+, цель B2 за 6 месяцев — реалистично в интенсиве.",
					en: "Level A2+, B2 goal in 6 months is realistic on intensive track.",
				},
				status: { ru: "qualified", en: "qualified" },
			},
			{
				title: { ru: "Payment pending", en: "Payment pending" },
				desc: {
					ru: "Счёт отправлен, рассрочка 3 платежа, ждём оплату.",
					en: "Invoice sent, 3-installment plan, awaiting payment.",
				},
				status: { ru: "invoice", en: "invoice" },
			},
			{
				title: { ru: "Inactive follow-up", en: "Inactive follow-up" },
				desc: {
					ru: "Нет активности 7 дней: серия возврата, потом куратор.",
					en: "No activity for 7 days: win-back sequence, then curator.",
				},
				status: { ru: "re-engage", en: "re-engage" },
			},
		],
		knowledge: [
			{
				title: { ru: "Программы курсов", en: "Course programs" },
				desc: {
					ru: "Уровни, модули, расписание, тарифы и рассрочка из KB.",
					en: "Levels, modules, schedule, plans and installments from KB.",
				},
			},
			{
				title: { ru: "Honest promises", en: "Honest promises" },
				desc: {
					ru: "AI не обещает «B2 за месяц»: сроки только из методологии.",
					en: "AI never promises “B2 in a month”: timelines come from methodology.",
				},
			},
			{
				title: { ru: "Retention rules", en: "Retention rules" },
				desc: {
					ru: "Триггеры неактивности, серия сообщений, эскалация куратору.",
					en: "Inactivity triggers, message sequence, curator escalation.",
				},
			},
		],
		handoff: {
			title: { ru: "Где нужен куратор", en: "Where curator is needed" },
			desc: {
				ru: "AI довёл до оплаты и выдал доступ. Куратор подключается на спорные возвраты, смену тарифа и студентов, которых не вернула автоматическая серия.",
				en: "AI closed the payment and granted access. Curator steps in for disputed refunds, plan changes and students the automated sequence could not win back.",
			},
			decision: { ru: "звонок куратора", en: "curator call" },
		},
		messages: {
			ru: [
				{
					from: "user",
					text: "Хочу выучить английский до B2 за полгода для работы, занимался давно. Сколько стоит?",
				},
				{
					from: "bot",
					text: "Цель понял: B2 за 6 месяцев для работы. Чтобы подобрать группу, пройдите короткий тест на уровень — 10 минут.",
				},
				{ from: "user", text: "Прошёл, получилось A2+." },
				{
					from: "bot",
					text: "С A2+ до B2 за 6 месяцев — интенсив, 3 занятия в неделю. Тариф 24 000 ₽/мес или рассрочка на 3 платежа. Утро или вечер?",
				},
				{ from: "user", text: "Вечер, и давайте рассрочку." },
				{
					from: "bot",
					text: "Отправил счёт на первый платёж. После оплаты открою доступ к платформе и поставлю в вечернюю группу со вторника.",
					cta: true,
				},
			],
			en: [
				{
					from: "user",
					text: "Want English up to B2 in six months for work, studied long ago. How much?",
				},
				{
					from: "bot",
					text: "Goal captured: B2 in 6 months for work. To match a group, take a short placement test — 10 minutes.",
				},
				{ from: "user", text: "Done, got A2+." },
				{
					from: "bot",
					text: "A2+ to B2 in 6 months means the intensive track, 3 lessons a week. $240/month or a 3-installment plan. Morning or evening group?",
				},
				{ from: "user", text: "Evening, and the installment plan please." },
				{
					from: "bot",
					text: "Invoice for the first installment sent. After payment I will open platform access and place you in the evening group starting Tuesday.",
					cta: true,
				},
			],
		},
	},
};

export default function DemoVerticals({
	verticalKey,
}: {
	verticalKey?: VerticalKey;
}) {
	const [lang, setLang] = useState<Lang>("ru");
	const c = COPY[lang];

	if (!verticalKey) {
		return <VerticalOverview c={c} lang={lang} setLang={setLang} />;
	}

	const vertical = VERTICALS[verticalKey];

	return (
		<>
			<Nav cta={c.ctaPrimary} lang={lang} setLang={setLang} />

			<div className="demo-banner">
				<div className="container demo-banner-inner">
					<span className="demo-banner-tag">{vertical.template}</span>
					<span>{t(vertical.inbound, lang)}</span>
				</div>
			</div>

			<section className={`hero vertical-demo-hero tone-${vertical.tone}`}>
				<div className="container">
					<div className="vertical-demo-grid">
						<div>
							<div className="hero-badge">vertical pack · workflow engine</div>
							<h1 className="hero-headline" style={{ maxWidth: 850 }}>
								{t(vertical.title, lang)}
							</h1>
							<p className="hero-sub">{t(vertical.sub, lang)}</p>
							<div className="hero-actions">
								<a href={SIGNUP_URL} className="btn btn-primary btn-lg">
									{c.ctaPrimary}
								</a>
								<a href={DEMO_URL} className="btn btn-secondary btn-lg">
									{c.ctaSecondary}
								</a>
							</div>
							<div className="exchange-proof-strip">
								<a href="/demo/verticals">{c.tagOverview}</a>
								{VERTICAL_ORDER.filter((key) => key !== verticalKey)
									.slice(0, 4)
									.map((key) => (
										<a key={key} href={VERTICALS[key].href}>
											{t(VERTICALS[key].label, lang)}
										</a>
									))}
								<a href="/demo/workflows/exchange">exchange</a>
								<a href="/demo/services">services</a>
							</div>
						</div>

						<div className="vertical-control-panel">
							<div className="vertical-panel-head">
								<span>{c.boardLabel}</span>
								<strong>{t(vertical.label, lang)}</strong>
							</div>
							<div className="service-kpis">
								{vertical.kpis.map((kpi) => (
									<div key={`${kpi.value}-${kpi.label.en}`}>
										<strong>{kpi.value}</strong>
										<span>{t(kpi.label, lang)}</span>
									</div>
								))}
							</div>
							<div className="service-inbound">
								<span>{c.inputLabel}</span>
								<strong>{t(vertical.inbound, lang)}</strong>
							</div>
							<div className="service-field-cloud">
								{vertical.fields.map((field) => (
									<span key={field}>{field}</span>
								))}
							</div>
						</div>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.backboneLabel}</div>
					<h2 className="section-title">{c.backboneTitle}</h2>
					<div className="vertical-stage-row">
						{vertical.stages.map((stage, index) => (
							<div
								key={`${stage.phase}-${stage.title.en}`}
								className="vertical-stage-card"
							>
								<span>{stage.phase}</span>
								<strong>{t(stage.title, lang)}</strong>
								<p>{t(stage.desc, lang)}</p>
								<em>{stage.owner}</em>
								<b>{String(index + 1).padStart(2, "0")}</b>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.opsLabel}</div>
					<h2 className="section-title">{c.opsTitle}</h2>
					<div className="vertical-execution-grid">
						<div className="vertical-ops-board">
							{vertical.ops.map((item) => (
								<div key={item.title.en} className="vertical-ops-row">
									<div>
										<strong>{t(item.title, lang)}</strong>
										<p>{t(item.desc, lang)}</p>
									</div>
									<span>{t(item.status, lang)}</span>
								</div>
							))}
						</div>
						<div className="vertical-handoff-card">
							<span>{t(vertical.handoff.decision, lang)}</span>
							<strong>{t(vertical.handoff.title, lang)}</strong>
							<p>{t(vertical.handoff.desc, lang)}</p>
						</div>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.knowledgeLabel}</div>
					<h2 className="section-title">{c.knowledgeTitle}</h2>
					<div className="vertical-knowledge-grid">
						{vertical.knowledge.map((item) => (
							<div key={item.title.en} className="vertical-knowledge-card">
								<span>{vertical.template}</span>
								<strong>{t(item.title, lang)}</strong>
								<p>{t(item.desc, lang)}</p>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="hero-inner">
						<div>
							<div className="section-label">{c.telegramLabel}</div>
							<h2 className="section-title" style={{ textAlign: "left" }}>
								{c.telegramTitle}
							</h2>
							<p className="section-sub">{t(vertical.sub, lang)}</p>
						</div>
						<TelegramMockup
							botName="Lead Engine Ops"
							ctaLabel="Open request card ->"
							messages={vertical.messages[lang]}
							notify={`handoff: ${t(vertical.handoff.decision, lang)}`}
						/>
					</div>
				</div>
			</section>

			<Footer {...c.footer} />
		</>
	);
}

function VerticalOverview({
	c,
	lang,
	setLang,
}: {
	c: (typeof COPY)[Lang];
	lang: Lang;
	setLang: (lang: Lang) => void;
}) {
	return (
		<>
			<Nav cta={c.ctaPrimary} lang={lang} setLang={setLang} />

			<div className="demo-banner">
				<div className="container demo-banner-inner">
					<span className="demo-banner-tag">{c.overviewBadge}</span>
					<span>{c.overviewSub}</span>
				</div>
			</div>

			<section className="hero verticals-overview-hero">
				<div className="container">
					<div className="vertical-demo-grid">
						<div>
							<div className="hero-badge">{c.overviewBadge}</div>
							<h1 className="hero-headline" style={{ maxWidth: 900 }}>
								{c.overviewTitle[0]}
								<span>{c.overviewTitle[1]}</span>
							</h1>
							<p className="hero-sub">{c.overviewSub}</p>
							<div className="hero-actions">
								<a href={SIGNUP_URL} className="btn btn-primary btn-lg">
									{c.ctaPrimary}
								</a>
								<a href={DEMO_URL} className="btn btn-secondary btn-lg">
									{c.ctaSecondary}
								</a>
							</div>
						</div>

						<div className="vertical-overview-board">
							<div className="vertical-panel-head">
								<span>{c.overviewBoard}</span>
								<strong>
									{"capture -> qualify -> offer -> handoff -> won"}
								</strong>
							</div>
							<div className="vertical-overview-stack">
								{VERTICAL_ORDER.map((key, index) => {
									const vertical = VERTICALS[key];
									return (
										<a
											key={key}
											href={vertical.href}
											className={`vertical-stack-row tone-${vertical.tone}`}
										>
											<span>{String(index + 1).padStart(2, "0")}</span>
											<strong>{t(vertical.label, lang)}</strong>
											<em>{vertical.template}</em>
										</a>
									);
								})}
							</div>
							<p>{c.overviewBoardSub}</p>
						</div>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.implemented}</div>
					<h2 className="section-title">{c.implementedSub}</h2>
					<div className="vertical-card-grid">
						{VERTICAL_ORDER.map((key) => {
							const vertical = VERTICALS[key];
							return (
								<a
									key={key}
									href={vertical.href}
									className={`vertical-demo-card tone-${vertical.tone}`}
								>
									<span>{vertical.template}</span>
									<strong>{t(vertical.label, lang)}</strong>
									<p>{t(vertical.sub, lang)}</p>
									<em>{c.openDemo}</em>
								</a>
							);
						})}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.liveSpecials}</div>
					<div className="vertical-special-grid">
						{SPECIAL_DEMOS.map((demo) => (
							<a
								key={demo.href}
								href={demo.href}
								className="vertical-special-card"
							>
								<strong>{t(demo, lang)}</strong>
								<p>{t(demo.note, lang)}</p>
							</a>
						))}
					</div>
				</div>
			</section>

			<Footer {...c.footer} />
		</>
	);
}
