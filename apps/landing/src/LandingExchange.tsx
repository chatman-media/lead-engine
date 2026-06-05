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
      badge: "Пхукет · крипто / рубли / наличные → THB",
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
        { from: "bot" as const, text: "Курс сегодня: 1 USDT = 33.2 THB. Итого 16 600 THB. Подтверждаете?" },
        { from: "user" as const, text: "Да, подтверждаю" },
        { from: "bot" as const, text: "Переводите 500 USDT на адрес: TXxxxxx...xxxx 👇", cta: true },
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
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 exchanges·agency" },
  },
  en: {
    nav: { cta: "Try Free" },
    hero: {
      badge: "Phuket · crypto / rubles / cash → THB",
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
        { from: "bot" as const, text: "Today's rate: 1 USDT = 33.2 THB. Total: 16,600 THB. Confirm?" },
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
                <a href={SIGNUP_URL} className="btn btn-primary btn-lg">{c.hero.ctaPrimary}</a>
                <a href="/demo" className="btn btn-secondary btn-lg">{c.hero.ctaSecondary}</a>
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
