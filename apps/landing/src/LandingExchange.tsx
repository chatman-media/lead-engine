import { useState } from "react";
import {
  DEMO_URL,
  FaqAccordion,
  Footer,
  Nav,
  SIGNUP_URL,
  TelegramMockup,
  type Lang,
} from "./shared.tsx";

const CONTENT = {
  ru: {
    nav: { cta: "Попробовать бесплатно" },
    hero: {
      badge: "Telegram · крипто / рубли / наличные → PHP / THB",
      headline: ["AI-ассистент для ", "обменного пункта", ", который не теряет клиентов"],
      sub: "Отвечает на запросы в Telegram за 30 секунд. Уточняет актив, сеть и сумму. Подтверждает курс — и ведёт клиента до выдачи наличных THB через банкомат.",
      ctaPrimary: "Попробовать бесплатно",
      ctaSecondary: "Смотреть демо",
      trust: "Работает 24/7. Поддерживает USDT TRC20/ERC20/BEP20, BTC, ETH и рублёвые переводы.",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "Хочу обменять 500 USDT на THB" },
        { from: "bot" as const, text: "Отлично! Какая сеть? TRC20, ERC20 или BEP20?" },
        { from: "user" as const, text: "TRC20" },
        {
          from: "bot" as const,
          text: "Курс сегодня: 1 USDT = 33.2 THB. Итого 16 600 THB. Подтверждаете?",
        },
        { from: "user" as const, text: "Да, подтверждаю" },
        {
          from: "bot" as const,
          text: "Переводите 500 USDT на адрес: TXxxxxx...xxxx 👇",
          cta: true,
        },
      ],
      notify: "🔔 Оплата подтверждена — оператор отправляет QR для ATM",
      ctaLabel: "📋 Реквизиты для перевода →",
    },
    howLabel: "Как это работает",
    howTitle: "Клиент получает THB наличными за 15 минут",
    steps: [
      {
        title: "Клиент пишет в Telegram",
        desc: "AI мгновенно уточняет: что меняет, сеть (для USDT), сумму. Без ожидания оператора.",
      },
      {
        title: "Фиксируем курс и реквизиты",
        desc: "Бот показывает текущий курс и итоговую сумму THB. Даёт адрес кошелька или карту Сбер/Тинькофф — по выбранному способу.",
      },
      {
        title: "Оператор подтверждает и выдаёт QR",
        desc: "Клиент присылает пруф (tx hash или скрин перевода). Оператор генерирует cardless-withdrawal QR и отправляет клиенту через admin-панель — без перехвата чата.",
      },
    ],
    workflowLabel: "Воркфлоу",
    workflowTitle: "Как бот ведёт сделку — от «привет» до выдачи",
    workflowSub:
      "Полный регламент обменника, зашитый в воронки. Каждый шаг виден оператору в CRM, рискованные точки — только через человека.",
    workflowPhases: [
      {
        title: "Понимание",
        accent: "#6366f1",
        steps: [
          {
            title: "Telegram с менеджер-аккаунта",
            desc: "Бот отвечает клиентам от лица менеджера — мгновенно, 24/7.",
          },
          {
            title: "Распознаёт запрос",
            desc: "Обмен, вопрос про курс, трансфер или зелёный коридор — каждый интент уходит в свою воронку.",
          },
          {
            title: "Направление и сумма",
            desc: "Уточняет актив, сеть (TRC20/ERC20) и сумму обмена по одному вопросу.",
          },
        ],
      },
      {
        title: "Курс и проверка",
        accent: "#f59e0b",
        steps: [
          {
            title: "Курс по вашей формуле",
            desc: "Считает от базового рыночного курса с вашими девиациями по диапазонам сумм — и показывает итог к получению.",
          },
          {
            title: "Верификация",
            desc: "Проверяет KYC-статус; новых клиентов отправляет на быструю верификацию и возвращает к обмену.",
          },
          {
            title: "Риск-чек",
            desc: "Перед созданием заявки оценивает риск; сомнительное — оператору.",
          },
        ],
      },
      {
        title: "Сделка",
        accent: "#10b981",
        steps: [
          {
            title: "Заявка с фиксацией курса",
            desc: "Создаёт заявку, фиксирует котировку с ограниченным сроком действия.",
          },
          {
            title: "Реквизиты по API",
            desc: "Получает реквизиты от партнёров по API и отправляет клиенту с TTL.",
          },
          {
            title: "Квитанция и банк",
            desc: "Просит чек, проверяет его и автоопределяет банк-отправитель.",
          },
          {
            title: "Выдача",
            desc: "После подтверждения оплаты — наличные в офисе, банкомат без карты или перевод на местный банк.",
          },
        ],
      },
      {
        title: "Контроль и рост",
        accent: "#06b6d4",
        steps: [
          {
            title: "CRM оборотов",
            desc: "Сколько всего поменяно — по дням, направлениям и клиентам.",
          },
          {
            title: "CRM каждого обмена",
            desc: "Кто менял, Telegram ID, ID верификации, время, сумма, направление, данные квитанции.",
          },
          {
            title: "Напоминания",
            desc: "Начал обмен и пропал — бот напомнит сам, до автозакрытия заявки.",
          },
          {
            title: "Кросс-сейл по прилёту",
            desc: "«Прилетаю 15-го» — бот предложит трансфер и зелёный коридор.",
          },
        ],
      },
    ],
    servicesLabel: "Три сервиса",
    servicesTitle: "Обмен, трансфер и зелёный коридор — в одном боте",
    services: [
      {
        icon: "💱",
        title: "Обмен валют",
        desc: "Крипта и рубли → наличные песо или баты: курс по формуле, KYC, риск-чек, реквизиты и выдача.",
        ctaLabel: "Живое демо обмена →",
        ctaHref: "/demo/workflows/exchange",
      },
      {
        icon: "🚐",
        title: "Трансфер из аэропорта",
        desc: "Рейс, терминал, машина: бот собирает заявку, оператор подтверждает цену, водитель встречает с табличкой.",
        ctaLabel: "Живое демо трансфера →",
        ctaHref: "/demo/workflows/transfer",
      },
      {
        icon: "🛂",
        title: "Зелёный коридор",
        desc: "VIP-встреча у выхода с рейса, fast-track паспортного контроля и сопровождение — бот ведёт заявку от рейса до встречи.",
        ctaLabel: "Записаться на демо →",
        ctaHref: DEMO_URL,
      },
    ],
    whyLabel: "Почему exchanges·agency",
    whyTitle: "Не просто чат-бот — полный цикл обмена.",
    moats: [
      {
        icon: "₿",
        title: "Крипто + рубли + наличные",
        desc: "USDT (TRC20/ERC20/BEP20), BTC, ETH и рублёвые переводы на Сбер/Тинькофф. Бот уточняет сеть и даёт правильный адрес.",
      },
      {
        icon: "📊",
        title: "Фиксация курса и KYC",
        desc: "Бот показывает курс и итоговую сумму THB. Для крупных сумм собирает имя и фото паспорта через vision-OCR.",
      },
      {
        icon: "📷",
        title: "QR для ATM из admin-панели",
        desc: "Оператор генерирует cardless-withdrawal QR в банковском приложении и отправляет клиенту одной кнопкой. Клиент снимает THB в банкомате.",
      },
      {
        icon: "💬",
        title: "Telegram-first",
        desc: "Туристы и экспаты уже пишут в Telegram. Бот отвечает мгновенно — даже когда оператор спит.",
      },
      {
        icon: "🔑",
        title: "BYOK — ваш API-ключ",
        desc: "Используете собственный OpenAI / Anthropic ключ. Данные клиентов хранятся в вашей изолированной базе.",
      },
    ],
    pricingLabel: "Цена",
    pricingTitle: "Цена — по запросу",
    pricingSub:
      "Стоимость зависит от объёма сделок и подключённых каналов. Напишите нам — подберём под ваш обменник и покажем живое демо.",
    pricingPrimary: "Смотреть демо",
    pricingSecondary: "Написать нам",
    pricingNote: "Включено: BYOK · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "Частые вопросы",
    faqTitle: "Ответы на главные вопросы",
    faq: [
      {
        q: "Поддерживает рублёвые переводы?",
        a: "Да. Бот принимает запросы на перевод рублей на карту Сбер или Тинькофф и выдаёт соответствующие реквизиты. Оператор настраивает реквизиты в панели.",
      },
      {
        q: "Как бот узнаёт текущий курс?",
        a: "Оператор задаёт курс в настройках тенанта или обновляет его вручную. Бот никогда не придумывает курс сам — только транслирует то, что задано оператором.",
      },
      {
        q: "Как работает KYC?",
        a: "Для сумм выше настраиваемого порога бот запрашивает имя и фото паспорта. Vision-OCR извлекает данные из MRZ автоматически.",
      },
      {
        q: "Как оператор отправляет QR?",
        a: "Оператор генерирует cardless-withdrawal QR в приложении KBank / BBL, затем загружает фото в admin-панель — бот автоматически пересылает его клиенту в Telegram.",
      },
      {
        q: "Можно посмотреть демо?",
        a: "Да, запишитесь на 15-минутное демо — покажем полный флоу от первого сообщения до выдачи QR.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Записаться на демо →",
    footer: {
      privacy: "Политика конфиденциальности",
      terms: "Условия использования",
      copy: "© 2026 exchanges·agency",
    },
  },
  en: {
    nav: { cta: "Try Free" },
    hero: {
      badge: "Telegram · crypto / rubles / cash → PHP / THB",
      headline: ["AI Assistant for ", "Currency Exchange", " That Never Misses a Client"],
      sub: "Responds to Telegram inquiries in 30 seconds. Confirms asset, network, and amount. Locks in the rate — and guides the client to THB cash via ATM cardless withdrawal.",
      ctaPrimary: "Try Free",
      ctaSecondary: "See live demo",
      trust: "Runs 24/7. Supports USDT TRC20/ERC20/BEP20, BTC, ETH and ruble bank transfers.",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "I want to exchange 500 USDT to THB" },
        { from: "bot" as const, text: "Great! Which network? TRC20, ERC20 or BEP20?" },
        { from: "user" as const, text: "TRC20" },
        {
          from: "bot" as const,
          text: "Today's rate: 1 USDT = 33.2 THB. Total: 16,600 THB. Confirm?",
        },
        { from: "user" as const, text: "Yes, confirmed" },
        { from: "bot" as const, text: "Send 500 USDT to address: TXxxxxx...xxxx 👇", cta: true },
      ],
      notify: "🔔 Payment confirmed — operator sending ATM withdrawal QR",
      ctaLabel: "📋 Payment details →",
    },
    howLabel: "How It Works",
    howTitle: "Client gets THB cash in 15 minutes",
    steps: [
      {
        title: "Client messages on Telegram",
        desc: "AI instantly asks: asset, network (for USDT), amount. No waiting for an operator.",
      },
      {
        title: "Lock rate and share payment details",
        desc: "Bot shows current rate and THB amount. Sends crypto wallet address or ruble card number — based on chosen payment method.",
      },
      {
        title: "Operator confirms and sends QR",
        desc: "Client sends proof (tx hash or transfer screenshot). Operator generates cardless-withdrawal QR and sends it via the admin panel — without taking over the chat.",
      },
    ],
    workflowLabel: "Workflow",
    workflowTitle: "How the bot runs a deal — from “hi” to payout",
    workflowSub:
      "Your full exchange playbook, encoded into funnels. Every step is visible to the operator in the CRM; risky moments always go through a human.",
    workflowPhases: [
      {
        title: "Understanding",
        accent: "#6366f1",
        steps: [
          {
            title: "Telegram manager account",
            desc: "The bot replies on behalf of your manager — instantly, 24/7.",
          },
          {
            title: "Detects the intent",
            desc: "Exchange, rate question, airport transfer or green corridor — each intent lands in its own funnel.",
          },
          {
            title: "Direction & amount",
            desc: "Clarifies asset, network (TRC20/ERC20) and amount, one question at a time.",
          },
        ],
      },
      {
        title: "Quote & checks",
        accent: "#f59e0b",
        steps: [
          {
            title: "Rate by your formula",
            desc: "Computed from the live market base rate with your tiered deviations — final payout shown to the client.",
          },
          {
            title: "Verification",
            desc: "Checks KYC status; first-timers are routed through quick verification and back to the exchange.",
          },
          {
            title: "Risk screening",
            desc: "Every order is risk-checked before creation; anything suspicious goes to the operator.",
          },
        ],
      },
      {
        title: "The deal",
        accent: "#10b981",
        steps: [
          {
            title: "Order with locked rate",
            desc: "Creates the order and locks the quote with a TTL.",
          },
          {
            title: "Requisites via API",
            desc: "Fetches payment details from partners via API and sends them with an expiry.",
          },
          {
            title: "Receipt & bank",
            desc: "Asks for the receipt, verifies it and auto-detects the sending bank.",
          },
          {
            title: "Payout",
            desc: "After payment confirmation — office cash, cardless ATM or local bank transfer.",
          },
        ],
      },
      {
        title: "Control & growth",
        accent: "#06b6d4",
        steps: [
          { title: "Turnover CRM", desc: "Total exchanged — by day, direction and client." },
          {
            title: "Per-deal CRM",
            desc: "Who exchanged, Telegram ID, verification ID, time, amount, direction, receipt data.",
          },
          {
            title: "Reminders",
            desc: "Started an exchange and went quiet? The bot follows up before the order auto-closes.",
          },
          {
            title: "Arrival cross-sell",
            desc: "“Landing on the 15th” — the bot offers a transfer and the green corridor.",
          },
        ],
      },
    ],
    servicesLabel: "Three services",
    servicesTitle: "Exchange, transfer and green corridor — one bot",
    services: [
      {
        icon: "💱",
        title: "Currency exchange",
        desc: "Crypto and rubles → pesos or baht in cash: formula-based rate, KYC, risk check, requisites and payout.",
        ctaLabel: "Live exchange demo →",
        ctaHref: "/demo/workflows/exchange",
      },
      {
        icon: "🚐",
        title: "Airport transfer",
        desc: "Flight, terminal, vehicle: the bot collects the request, the operator confirms the price, the driver meets with a name sign.",
        ctaLabel: "Live transfer demo →",
        ctaHref: "/demo/workflows/transfer",
      },
      {
        icon: "🛂",
        title: "Green corridor",
        desc: "VIP meet at the gate, fast-track passport control and escort — the bot runs the request from flight number to the meeting.",
        ctaLabel: "Book a demo →",
        ctaHref: DEMO_URL,
      },
    ],
    whyLabel: "Why exchanges·agency",
    whyTitle: "Not just a chatbot — a full exchange workflow.",
    moats: [
      {
        icon: "₿",
        title: "Crypto + Rubles + Cash",
        desc: "USDT (TRC20/ERC20/BEP20), BTC, ETH and ruble transfers to Sber/Tinkoff. Bot clarifies the network and sends the right wallet address.",
      },
      {
        icon: "📊",
        title: "Rate Lock & KYC",
        desc: "Bot shows rate and final THB amount. For large amounts, collects name and passport photo with vision OCR.",
      },
      {
        icon: "📷",
        title: "ATM QR from Admin Panel",
        desc: "Operator generates cardless-withdrawal QR in KBank / BBL app and sends it with one click. Client withdraws THB at any ATM.",
      },
      {
        icon: "💬",
        title: "Telegram-First",
        desc: "Tourists and expats already use Telegram. Bot responds instantly — even while operators sleep.",
      },
      {
        icon: "🔑",
        title: "BYOK — Your API Key",
        desc: "Use your own OpenAI / Anthropic key. Client data stays in your isolated database.",
      },
    ],
    pricingLabel: "Pricing",
    pricingTitle: "Pricing — on request",
    pricingSub:
      "Pricing depends on deal volume and connected channels. Contact us — we'll tailor it to your exchange and show a live demo.",
    pricingPrimary: "See live demo",
    pricingSecondary: "Contact us",
    pricingNote: "Included: BYOK · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "FAQ",
    faqTitle: "Common questions, straight answers",
    faq: [
      {
        q: "Does it support ruble transfers?",
        a: "Yes. The bot accepts ruble transfer requests and provides Sber or Tinkoff card details. Operators configure payment details in the panel.",
      },
      {
        q: "How does the bot know the current rate?",
        a: "The operator sets the rate in tenant settings or updates it manually. The bot never invents a rate — it only shows what the operator has configured.",
      },
      {
        q: "How does KYC work?",
        a: "For amounts above a configurable threshold, the bot requests a name and passport photo. Vision OCR extracts MRZ data automatically.",
      },
      {
        q: "How does the operator send the QR?",
        a: "The operator generates a cardless-withdrawal QR in KBank / BBL, uploads the photo to the admin panel — the bot automatically forwards it to the client in Telegram.",
      },
      {
        q: "Can I see a demo?",
        a: "Yes, book a 15-minute demo — we'll show the full flow from first message to QR delivery.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Book a demo →",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 exchanges·agency" },
  },
};

export default function LandingExchange() {
  const [lang, setLang] = useState<Lang>("ru");
  const c = CONTENT[lang];

  return (
    <>
      <Nav lang={lang} setLang={setLang} cta={c.nav.cta} />

      <section className="hero">
        <div className="container">
          <div className="hero-inner">
            <div>
              <div className="hero-badge">{c.hero.badge}</div>
              <h1 className="hero-headline">
                {c.hero.headline[0]}
                <em>{c.hero.headline[1]}</em>
                {c.hero.headline[2]}
              </h1>
              <p className="hero-sub">{c.hero.sub}</p>
              <div className="hero-actions">
                <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                  {c.hero.ctaPrimary}
                </a>
                <a href="/demo" className="btn btn-secondary btn-lg">
                  {c.hero.ctaSecondary}
                </a>
              </div>
              <div className="hero-trust">{c.hero.trust}</div>
            </div>
            <TelegramMockup
              messages={c.tg.messages}
              notify={c.tg.notify}
              botName="ExchangeBot"
              ctaLabel={c.tg.ctaLabel}
            />
          </div>
        </div>
      </section>

      <section className="section section-alt" id="how">
        <div className="container">
          <div className="section-label">{c.howLabel}</div>
          <h2 className="section-title">{c.howTitle}</h2>
          <div className="steps">
            {c.steps.map((step, i) => (
              <div key={i} className="step">
                <div className="step-num">{i + 1}</div>
                <div className="step-title">{step.title}</div>
                <p className="step-desc">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="workflow">
        <div className="container">
          <div className="section-label">{c.workflowLabel}</div>
          <h2 className="section-title">{c.workflowTitle}</h2>
          <p className="section-sub" style={{ margin: "0 auto 28px", textAlign: "center" }}>
            {c.workflowSub}
          </p>
          <div className="demo-board">
            {c.workflowPhases.map((phase, pIdx) => (
              <div key={phase.title} className="demo-col">
                <div className="demo-col-head">
                  <span className="demo-col-dot" style={{ background: phase.accent }} />
                  {phase.title}
                  <span className="demo-col-count">{phase.steps.length}</span>
                </div>
                {phase.steps.map((step, sIdx) => (
                  <div
                    key={step.title}
                    className="demo-card"
                    style={{ borderLeftColor: phase.accent }}
                  >
                    <div className="demo-card-top">
                      <span className="demo-card-who">
                        {c.workflowPhases.slice(0, pIdx).reduce((n, p) => n + p.steps.length, 0) +
                          sIdx +
                          1}
                        . {step.title}
                      </span>
                    </div>
                    <div className="demo-card-meta">{step.desc}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" id="services">
        <div className="container">
          <div className="section-label">{c.servicesLabel}</div>
          <h2 className="section-title">{c.servicesTitle}</h2>
          <div className="moats">
            {c.services.map((s) => (
              <div key={s.title} className="moat">
                <div className="moat-icon">{s.icon}</div>
                <div className="moat-title">{s.title}</div>
                <p className="moat-desc">{s.desc}</p>
                <a href={s.ctaHref} className="btn btn-secondary" style={{ marginTop: 12 }}>
                  {s.ctaLabel}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="why">
        <div className="container">
          <div className="section-label">{c.whyLabel}</div>
          <h2 className="section-title">{c.whyTitle}</h2>
          <div className="moats">
            {c.moats.map((m, i) => (
              <div key={i} className="moat">
                <div className="moat-icon">{m.icon}</div>
                <div className="moat-title">{m.title}</div>
                <p className="moat-desc">{m.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" id="pricing">
        <div className="container">
          <div className="section-label">{c.pricingLabel}</div>
          <h2 className="section-title">{c.pricingTitle}</h2>
          <p className="section-sub" style={{ margin: "0 auto 28px", textAlign: "center" }}>
            {c.pricingSub}
          </p>
          <div className="hero-actions" style={{ justifyContent: "center" }}>
            <a href="/demo" className="btn btn-primary btn-lg">
              {c.pricingPrimary}
            </a>
            <a href={DEMO_URL} className="btn btn-secondary btn-lg">
              {c.pricingSecondary}
            </a>
          </div>
          <p className="plan-note" style={{ marginTop: 24 }}>
            <strong>{c.pricingNote}</strong>
          </p>
        </div>
      </section>

      <section className="section" id="faq">
        <div className="container">
          <div className="section-label">{c.faqLabel}</div>
          <h2 className="section-title">{c.faqTitle}</h2>
          <FaqAccordion items={c.faq} demoBtn={c.faqDemoBtn} />
        </div>
      </section>

      <Footer {...c.footer} />
    </>
  );
}
