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
const t = (value: L, lang: Lang) => value[lang];

const COPY = {
	ru: {
		bannerTag: "Exchange workflow demo",
		banner:
			"Отдельная демо-страница по exchange_v1: котировка, KYC/risk, TTL-реквизиты, proof и payout.",
		title: [
			"Exchange desk, где деньги проходят через ",
			"workflow, а не переписку",
		],
		sub: "Клиент пишет как в обычный Telegram: рубли, USDT, наличные, банкомат, курьер, срочно, две операции подряд. Lead Engine превращает это в денежную заявку с quote snapshot, статусами, инструментами и handoff оператору только там, где нужен человек.",
		ctaPrimary: "Собрать exchange workflow",
		ctaSecondary: "Обсудить в Telegram",
		kpiLabel: "Live money desk",
		opsTitle: "Операционный слой обменника",
		opsSub:
			"В демо видно два слоя сразу: бизнес-воронка клиента и технический статус exchange order. Это не чат с курсом, а контроль денег от первого сообщения до выдачи.",
		casesLabel: "Сценарии из workflow-документов",
		casesTitle: "Реальные exchange-ветки, которые ломают обычного бота",
		casesSub:
			"Сценарии взяты из описанных exchange workflows: RUB/QR/KYC, USDT TRC20, cardless ATM, курьер, частичная выдача и две операции подряд.",
		stageLabel: "Stage machine",
		stageTitle: "Воронка не прячет деньги внутри диалога",
		stageSub:
			"Каждый шаг имеет поля, action/tool и понятный статус для менеджера. LLM ведёт разговор, но курс, реквизиты, проверка и payout живут в deterministic tools.",
		toolsLabel: "Money tools",
		toolsTitle: "Модель не считает деньги и не выдумывает реквизиты",
		toolsSub:
			"Все критичные действия идут через сервисный слой: quote, order, requisites, payment verification, payout. Оператор видит, что было показано клиенту, когда истекает TTL и где нужен ручной контроль.",
		handoffLabel: "Human-in-the-loop",
		handoffTitle: "Оператор получает исключение, а не всю кашу из чата",
		handoffSub:
			"Крупная сумма, KYC, mismatch в чеке, риск, QR/код банкомата или частичная выдача попадают в короткую handoff-карточку. После решения AI продолжает сделку.",
		dialogLabel: "Telegram side",
		dialogTitle: "Клиенту это выглядит как нормальный диалог",
		dialogSub:
			"Внутри уже созданы order, quote snapshot, TTL-реквизиты и задачи оператору. Клиент не видит сложность системы.",
		ctaTitle: "Такой exchange demo продаёт продукт, а не идею бота",
		ctaSub:
			"Покажи владельцу обменника: где деньги, где риск, кто держит следующий шаг, какой курс был зафиксирован и почему менеджер больше не теряет заявки в переписках.",
		notify: "Operator handoff: KYC approved, issue payout code",
		ctaBubble: "Открыть exchange order →",
		footer: {
			privacy: "Политика конфиденциальности",
			terms: "Условия использования",
			copy: "© 2026 Lead Engine",
		},
	},
	en: {
		bannerTag: "Exchange workflow demo",
		banner:
			"A dedicated exchange_v1 demo: quote, KYC/risk, TTL requisites, proof and payout.",
		title: [
			"An exchange desk where money moves through ",
			"workflow, not chat",
		],
		sub: "The client writes naturally in Telegram: RUB, USDT, cash, ATM, courier, urgent, two operations in a row. Lead Engine turns it into a money order with a quote snapshot, statuses, tools and operator handoff only where judgment is needed.",
		ctaPrimary: "Build exchange workflow",
		ctaSecondary: "Discuss in Telegram",
		kpiLabel: "Live money desk",
		opsTitle: "Exchange operations layer",
		opsSub:
			"The demo shows two layers at once: the customer funnel and the technical exchange order status. It is not a rate chatbot; it controls money from first message to payout.",
		casesLabel: "Workflow document scenarios",
		casesTitle: "Real exchange branches that break a regular bot",
		casesSub:
			"Scenarios are based on the exchange workflows: RUB/QR/KYC, USDT TRC20, cardless ATM, courier, partial payout and two operations in a row.",
		stageLabel: "Stage machine",
		stageTitle: "The funnel does not hide money inside the conversation",
		stageSub:
			"Every step has fields, an action/tool and a clear manager status. The LLM drives the conversation, but rate, requisites, verification and payout live in deterministic tools.",
		toolsLabel: "Money tools",
		toolsTitle: "The model does not calculate money or invent requisites",
		toolsSub:
			"Critical actions go through a service layer: quote, order, requisites, payment verification, payout. The operator sees what was shown to the client, when TTL expires and where manual control is required.",
		handoffLabel: "Human-in-the-loop",
		handoffTitle: "The operator receives an exception, not the whole chat",
		handoffSub:
			"Large amount, KYC, receipt mismatch, risk, ATM QR/code or partial payout become a compact handoff card. After the decision, AI continues the order.",
		dialogLabel: "Telegram side",
		dialogTitle: "For the client it still feels like a normal dialog",
		dialogSub:
			"Inside, the system already created the order, quote snapshot, TTL requisites and operator tasks. The client does not see the system complexity.",
		ctaTitle: "This exchange demo sells the product, not a chatbot idea",
		ctaSub:
			"Show an exchange owner where the money is, where risk sits, who owns the next step, which rate was locked and why managers stop losing requests in chats.",
		notify: "Operator handoff: KYC approved, issue payout code",
		ctaBubble: "Open exchange order →",
		footer: {
			privacy: "Privacy Policy",
			terms: "Terms of Use",
			copy: "© 2026 Lead Engine",
		},
	},
};

const KPIS: { value: string; label: L; tone: "blue" | "green" | "amber" }[] = [
	{
		value: "38",
		label: { ru: "exchange orders today", en: "exchange orders today" },
		tone: "blue",
	},
	{
		value: "฿2.8M",
		label: { ru: "THB payout pipeline", en: "THB payout pipeline" },
		tone: "green",
	},
	{
		value: "9",
		label: { ru: "ждут proof / KYC", en: "awaiting proof / KYC" },
		tone: "amber",
	},
	{
		value: "14 мин",
		label: { ru: "средний TTL quote", en: "average quote TTL" },
		tone: "blue",
	},
];

const OPS_COLUMNS: {
	key: string;
	title: L;
	accent: string;
	cards: { who: string; amount: string; dir: string; note: L; tag: string }[];
}[] = [
	{
		key: "quote",
		title: { ru: "Quote", en: "Quote" },
		accent: "#6aa6ff",
		cards: [
			{
				who: "@rub_qr",
				amount: "฿35 000",
				dir: "RUB QR -> THB",
				note: {
					ru: "compute_quote, TTL 14:32",
					en: "compute_quote, TTL 14:32",
				},
				tag: "quote",
			},
			{
				who: "@wallet_500",
				amount: "500 USDT",
				dir: "USDT TRC20 -> THB",
				note: { ru: "network collected", en: "network collected" },
				tag: "fields",
			},
		],
	},
	{
		key: "clear",
		title: { ru: "KYC / risk", en: "KYC / risk" },
		accent: "#fbbf77",
		cards: [
			{
				who: "@pattaya_kyc",
				amount: "฿87 400",
				dir: "RUB split -> ATM",
				note: { ru: "video note + card check", en: "video note + card check" },
				tag: "operator",
			},
			{
				who: "@third_party",
				amount: "฿45 000",
				dir: "RUB -> Bangkok Bank",
				note: { ru: "third-party payer flag", en: "third-party payer flag" },
				tag: "risk",
			},
		],
	},
	{
		key: "payment",
		title: { ru: "Payment proof", en: "Payment proof" },
		accent: "#c4b5fd",
		cards: [
			{
				who: "@trust_fast",
				amount: "1 558 USDT",
				dir: "Trust -> THB cash",
				note: {
					ru: "tx hash seen, verify_payment",
					en: "tx hash seen, verify_payment",
				},
				tag: "proof",
			},
			{
				who: "@sber_atm",
				amount: "฿10 000",
				dir: "Sber QR -> cardless",
				note: {
					ru: "receipt OCR mismatch check",
					en: "receipt OCR mismatch check",
				},
				tag: "receipt",
			},
		],
	},
	{
		key: "payout",
		title: { ru: "Payout", en: "Payout" },
		accent: "#91d990",
		cards: [
			{
				who: "@atm_blue",
				amount: "฿25 000 + ฿25 000",
				dir: "partial ATM payout",
				note: {
					ru: "issue_payout, code expires",
					en: "issue_payout, code expires",
				},
				tag: "payout",
			},
			{
				who: "@courier",
				amount: "฿60 000",
				dir: "USDT -> courier cash",
				note: { ru: "courier ETA confirmed", en: "courier ETA confirmed" },
				tag: "won",
			},
		],
	},
];

const ACTIVE_ORDER = [
	{ label: { ru: "order", en: "order" }, value: "EX-2408" },
	{ label: { ru: "direction", en: "direction" }, value: "USDT TRC20 -> THB" },
	{ label: { ru: "quote", en: "quote" }, value: "31.55 / ฿49 000" },
	{ label: { ru: "status", en: "status" }, value: "payment_verified" },
	{ label: { ru: "next", en: "next" }, value: "issue_payout" },
];

const TOOL_EVENTS: { tool: string; status: string; desc: L }[] = [
	{
		tool: "compute_quote",
		status: "ok",
		desc: {
			ru: "rate + fee + amount_to + expires_at",
			en: "rate + fee + amount_to + expires_at",
		},
	},
	{
		tool: "check_verification",
		status: "needs KYC",
		desc: {
			ru: "threshold triggered, video-note required",
			en: "threshold triggered, video-note required",
		},
	},
	{
		tool: "fetch_requisites",
		status: "TTL 15m",
		desc: {
			ru: "wallet / QR / card details by route",
			en: "wallet / QR / card details by route",
		},
	},
	{
		tool: "verify_payment",
		status: "matched",
		desc: {
			ru: "tx hash or receipt matched to order",
			en: "tx hash or receipt matched to order",
		},
	},
];

const CASES: {
	title: L;
	input: L;
	path: string[];
	result: L;
	tone: "blue" | "green" | "amber";
}[] = [
	{
		title: {
			ru: "RUB -> THB, QR, KYC, курьер",
			en: "RUB -> THB, QR, KYC, courier",
		},
		input: {
			ru: "«Тинькофф, хочу 10 000 бат, доставка в отель в Паттайе»",
			en: "“Tinkoff, need 10,000 baht, delivery to a hotel in Pattaya”",
		},
		path: [
			"asset_from=RUB",
			"amount_to=THB",
			"compute_quote",
			"KYC required",
			"courier handoff",
			"requisites_sent",
			"completed",
		],
		result: {
			ru: "AI не теряет адрес, сумму, KYC и courier ETA в переписке.",
			en: "AI keeps address, amount, KYC and courier ETA out of chat chaos.",
		},
		tone: "amber",
	},
	{
		title: {
			ru: "USDT TRC20 -> THB, кошелёк, доставка / ATM",
			en: "USDT TRC20 -> THB, wallet, delivery / ATM",
		},
		input: {
			ru: "«2000 USDT, кошелёк, хочу наличные, не хочу играть с банкоматами»",
			en: "“2,000 USDT, wallet, need cash, do not want ATM uncertainty”",
		},
		path: [
			"network=TRC20",
			"quote snapshot",
			"wallet requisites",
			"delivery method",
			"verify tx",
			"cash payout",
		],
		result: {
			ru: "Система заранее спрашивает payout_method и не выдаёт реквизиты вслепую.",
			en: "The system asks payout_method first and does not issue details blindly.",
		},
		tone: "blue",
	},
	{
		title: {
			ru: "Две операции подряд + частичная выдача",
			en: "Two operations in a row + partial payout",
		},
		input: {
			ru: "«Сначала 87 400 бат по QR, потом ещё 1101 USDT, срочно, можно частями?»",
			en: "“First 87,400 baht by QR, then 1,101 USDT, urgent, can payout partially?”",
		},
		path: [
			"order #1",
			"split payment",
			"ATM payout",
			"order #2",
			"partial payout",
			"operator exception",
		],
		result: {
			ru: "Lead Engine держит две money-сделки отдельно, но в одном клиентском контексте.",
			en: "Lead Engine keeps two money orders separate, but in one customer context.",
		},
		tone: "green",
	},
];

const STAGES: {
	slug: string;
	title: L;
	phase: L;
	fields: string;
	action: string;
}[] = [
	{
		slug: "exchange_request",
		title: { ru: "Параметры обмена", en: "Exchange parameters" },
		phase: { ru: "qualify", en: "qualify" },
		fields: "asset_from, network, amount_from, payout_method",
		action: "validate direction",
	},
	{
		slug: "quote_calculated",
		title: { ru: "Курс рассчитан", en: "Quote calculated" },
		phase: { ru: "offer", en: "offer" },
		fields: "quote_id, final_rate, fee, amount_to, expires_at",
		action: "compute_quote",
	},
	{
		slug: "verification_check",
		title: { ru: "Проверка верификации", en: "Verification check" },
		phase: { ru: "clear", en: "clear" },
		fields: "verification_status, provider, verified_at",
		action: "check_verification",
	},
	{
		slug: "risk_review",
		title: { ru: "Проверка риска", en: "Risk review" },
		phase: { ru: "clear", en: "clear" },
		fields: "risk_score, risk_flags, risk_decision",
		action: "screen_risk",
	},
	{
		slug: "order_created",
		title: { ru: "Заявка создана", en: "Order created" },
		phase: { ru: "offer", en: "offer" },
		fields: "exchange_order_id, quote_snapshot",
		action: "create_order",
	},
	{
		slug: "requisites_sent",
		title: { ru: "Реквизиты отправлены", en: "Requisites sent" },
		phase: { ru: "clear", en: "clear" },
		fields: "provider, requisites_ref, requisites_expires_at",
		action: "fetch_requisites",
	},
	{
		slug: "payment_proof_waiting",
		title: { ru: "Ожидание оплаты", en: "Awaiting payment" },
		phase: { ru: "clear", en: "clear" },
		fields: "receipt_file, tx_hash, sender, amount, time",
		action: "reminder / OCR assist",
	},
	{
		slug: "payment_verified",
		title: { ru: "Оплата подтверждена", en: "Payment verified" },
		phase: { ru: "fulfill", en: "fulfill" },
		fields: "payment_status, matched_amount, verified_by",
		action: "verify_payment",
	},
	{
		slug: "payout_or_completion",
		title: { ru: "Выдача / завершено", en: "Payout / completed" },
		phase: { ru: "won", en: "won" },
		fields: "payout_method, code_ref, issued_by, completed_at",
		action: "issue_payout",
	},
];

const TOOLS: {
	name: string;
	desc: L;
	output: string;
	tone: "blue" | "green" | "amber";
}[] = [
	{
		name: "compute_quote",
		desc: {
			ru: "Считает курс, комиссию, сумму к получению и TTL. LLM не делает арифметику.",
			en: "Calculates rate, fee, payout amount and TTL. The LLM does not do arithmetic.",
		},
		output: "quote_snapshot",
		tone: "blue",
	},
	{
		name: "create_order",
		desc: {
			ru: "Создаёт exchange order, привязанный к lead, conversation и contact.",
			en: "Creates an exchange order linked to lead, conversation and contact.",
		},
		output: "exchange_order_id",
		tone: "green",
	},
	{
		name: "fetch_requisites",
		desc: {
			ru: "Выдаёт только разрешённые реквизиты: wallet, QR, карта, провайдер. Всё с TTL.",
			en: "Returns only allowed requisites: wallet, QR, card, provider. Everything has TTL.",
		},
		output: "requisites_ref",
		tone: "amber",
	},
	{
		name: "verify_payment",
		desc: {
			ru: "Проверяет tx hash / receipt match. Фото чека только помогает, но не решает само.",
			en: "Verifies tx hash / receipt match. Receipt image assists, but does not decide alone.",
		},
		output: "payment_status",
		tone: "blue",
	},
	{
		name: "issue_payout",
		desc: {
			ru: "Выдаёт payout code, QR или операторский action. Код не появляется из текста модели.",
			en: "Issues payout code, QR or operator action. The code never comes from model text.",
		},
		output: "payout_code_ref",
		tone: "green",
	},
];

const HANDOFFS: { title: L; meta: string; desc: L }[] = [
	{
		title: { ru: "KYC / повторная проверка", en: "KYC / repeat verification" },
		meta: "verification_check",
		desc: {
			ru: "Сумма или метод оплаты требует документов. Оператор видит, что уже собрано, и подтверждает policy.",
			en: "Amount or payment method requires documents. The operator sees collected fields and confirms policy.",
		},
	},
	{
		title: { ru: "Mismatch в чеке", en: "Receipt mismatch" },
		meta: "payment_proof_waiting",
		desc: {
			ru: "Сумма, отправитель, банк или время не сошлись. AI не закрывает сделку, а отдаёт decision card.",
			en: "Amount, sender, bank or time does not match. AI does not close the order; it sends a decision card.",
		},
	},
	{
		title: { ru: "Payout / partial cash", en: "Payout / partial cash" },
		meta: "payout_or_completion",
		desc: {
			ru: "Банкомат недоступен, нужен другой банк или выдача частями. Оператор выбирает код/провайдера.",
			en: "ATM unavailable, another bank is needed or payout is partial. Operator chooses code/provider.",
		},
	},
];

const TG_MESSAGES: Record<Lang, TgMessage[]> = {
	ru: [
		{
			from: "user",
			text: "Здравствуйте. Нужно 49 000 бат, переведу USDT TRC20. Снять хочу в банкомате, срочно.",
		},
		{
			from: "bot",
			text: "Принял. Сеть TRC20, сумма к получению 49 000 THB. Считаю котировку и проверю, нужна ли верификация.",
		},
		{
			from: "bot",
			text: "Курс зафиксирован: 31.55. К переводу 1 558 USDT, quote действует 15 минут. Подтверждаете?",
		},
		{ from: "user", text: "Да. Я с Trust, могу сразу отправить." },
		{
			from: "bot",
			text: "Отправляйте только TRC20 на реквизиты из заявки. После перевода пришлите tx hash или скрин.",
			cta: true,
		},
		{
			from: "bot",
			text: "Оплата подтверждена. Оператор выдаёт ATM-код, я пришлю инструкцию следующим сообщением.",
		},
	],
	en: [
		{
			from: "user",
			text: "Hi. Need 49,000 baht, I will send USDT TRC20. Want to withdraw at an ATM, urgent.",
		},
		{
			from: "bot",
			text: "Got it. Network TRC20, target payout 49,000 THB. I will calculate the quote and check verification rules.",
		},
		{
			from: "bot",
			text: "Rate locked: 31.55. Send 1,558 USDT, quote valid for 15 minutes. Confirm?",
		},
		{ from: "user", text: "Yes. I use Trust and can send now." },
		{
			from: "bot",
			text: "Send only TRC20 to the requisites in this order. After payment, send tx hash or screenshot.",
			cta: true,
		},
		{
			from: "bot",
			text: "Payment verified. Operator is issuing the ATM code; I will send instructions next.",
		},
	],
};

function ExchangeOpsConsole({ lang }: { lang: Lang }) {
	return (
		<div className="exchange-console">
			<div className="exchange-console-head">
				<div>
					<div className="exchange-console-kicker">EXCHANGE OPS</div>
					<strong>Exchange Deal Desk</strong>
				</div>
				<span>live</span>
			</div>
			<div className="exchange-kpis">
				{KPIS.map((kpi) => (
					<div key={kpi.value} className={`exchange-kpi tone-${kpi.tone}`}>
						<strong>{kpi.value}</strong>
						<span>{t(kpi.label, lang)}</span>
					</div>
				))}
			</div>
			<div className="exchange-console-grid">
				<div className="exchange-mini-board">
					{OPS_COLUMNS.map((column) => (
						<div key={column.key} className="exchange-mini-col">
							<div className="exchange-mini-col-head">
								<span style={{ background: column.accent }} />
								{t(column.title, lang)}
							</div>
							{column.cards.map((card) => (
								<div
									key={`${column.key}-${card.who}-${card.tag}`}
									className="exchange-mini-card"
									style={{ borderLeftColor: column.accent }}
								>
									<div>
										<strong>{card.who}</strong>
										<em>{card.tag}</em>
									</div>
									<p>{card.dir}</p>
									<b>{card.amount}</b>
									<span>{t(card.note, lang)}</span>
								</div>
							))}
						</div>
					))}
				</div>
				<div className="exchange-order-panel">
					<div className="exchange-order-title">Active order</div>
					{ACTIVE_ORDER.map((row) => (
						<div key={row.value} className="exchange-order-row">
							<span>{t(row.label, lang)}</span>
							<strong>{row.value}</strong>
						</div>
					))}
					<div className="exchange-tool-feed">
						{TOOL_EVENTS.map((event) => (
							<div key={event.tool} className="exchange-tool-event">
								<div>
									<strong>{event.tool}</strong>
									<span>{t(event.desc, lang)}</span>
								</div>
								<em>{event.status}</em>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

export default function DemoExchangeWorkflow() {
	const [lang, setLang] = useState<Lang>("ru");
	const c = COPY[lang];

	return (
		<>
			<Nav cta={c.ctaPrimary} lang={lang} setLang={setLang} />

			<div className="demo-banner">
				<div className="container demo-banner-inner">
					<span className="demo-banner-tag">{c.bannerTag}</span>
					<span>{c.banner}</span>
				</div>
			</div>

			<section className="hero exchange-workflow-hero">
				<div className="container">
					<div className="exchange-hero-grid">
						<div>
							<div className="hero-badge">exchange_v1 · live workflow</div>
							<h1 className="hero-headline">
								{c.title[0]}
								<em>{c.title[1]}</em>
							</h1>
							<p className="hero-sub">{c.sub}</p>
							<div className="hero-actions">
								<a href={SIGNUP_URL} className="btn btn-primary btn-lg">
									{c.ctaPrimary}
								</a>
								<a href={DEMO_URL} className="btn btn-secondary btn-lg">
									{c.ctaSecondary}
								</a>
							</div>
							<div className="exchange-proof-strip">
								<a href="/demo/services">service workflows</a>
								<a href="/demo/workflows/transfer">transfer</a>
								<a href="/demo/workflows/cleaning">cleaning</a>
								<a href="/demo/workflows/exchange">exchange</a>
							</div>
						</div>
						<ExchangeOpsConsole lang={lang} />
					</div>
				</div>
			</section>

			<section className="section" style={{ paddingTop: 0 }}>
				<div className="container">
					<div className="section-label">{c.kpiLabel}</div>
					<h2 className="section-title">{c.opsTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.opsSub}
					</p>
					<div className="exchange-money-layers">
						<div className="exchange-layer">
							<span>Business funnel</span>
							<strong>
								{
									"exchange_request -> quote_calculated -> verification_check -> risk_review -> payout_or_completion"
								}
							</strong>
						</div>
						<div className="exchange-layer">
							<span>Exchange order status</span>
							<strong>
								{
									"quote -> awaiting_payment -> paid -> payout -> completed / expired"
								}
							</strong>
						</div>
						<div className="exchange-layer">
							<span>Operator work</span>
							<strong>
								KYC approval, risk decision, receipt mismatch, ATM code, partial
								payout
							</strong>
						</div>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.casesLabel}</div>
					<h2 className="section-title">{c.casesTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.casesSub}
					</p>
					<div className="exchange-case-grid">
						{CASES.map((item) => (
							<div
								key={item.title.en}
								className={`exchange-case tone-${item.tone}`}
							>
								<div className="exchange-case-top">
									<span>{item.tone}</span>
									<strong>{t(item.title, lang)}</strong>
								</div>
								<p>{t(item.input, lang)}</p>
								<div className="exchange-case-path">
									{item.path.map((step) => (
										<span key={step}>{step}</span>
									))}
								</div>
								<em>{t(item.result, lang)}</em>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section">
				<div className="container">
					<div className="section-label">{c.stageLabel}</div>
					<h2 className="section-title">{c.stageTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.stageSub}
					</p>
					<div className="exchange-stage-table">
						<table className="demo-rate-table">
							<thead>
								<tr>
									<th>Stage</th>
									<th>Phase</th>
									<th>Fields</th>
									<th>Action</th>
								</tr>
							</thead>
							<tbody>
								{STAGES.map((stage) => (
									<tr key={stage.slug}>
										<td>
											<strong>{stage.slug}</strong>
											<span>{t(stage.title, lang)}</span>
										</td>
										<td>{t(stage.phase, lang)}</td>
										<td>{stage.fields}</td>
										<td className="demo-rate-dev">{stage.action}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</section>

			<section className="section section-alt">
				<div className="container">
					<div className="section-label">{c.toolsLabel}</div>
					<h2 className="section-title">{c.toolsTitle}</h2>
					<p className="section-sub" style={{ marginBottom: 28 }}>
						{c.toolsSub}
					</p>
					<div className="exchange-tool-grid">
						{TOOLS.map((tool) => (
							<div
								key={tool.name}
								className={`exchange-tool-card tone-${tool.tone}`}
							>
								<div>
									<span>{tool.output}</span>
									<strong>{tool.name}</strong>
								</div>
								<p>{t(tool.desc, lang)}</p>
							</div>
						))}
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
					<div className="exchange-handoff-grid">
						{HANDOFFS.map((item) => (
							<div key={item.meta} className="exchange-handoff">
								<span>{item.meta}</span>
								<strong>{t(item.title, lang)}</strong>
								<p>{t(item.desc, lang)}</p>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="section section-alt">
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
							botName="Lead Engine Exchange"
							ctaLabel={c.ctaBubble}
							messages={TG_MESSAGES[lang]}
							notify={c.notify}
						/>
					</div>
				</div>
			</section>

			<section className="section">
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
