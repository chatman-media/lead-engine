import { useState } from "react";
import {
  DEMO_URL,
  FaqAccordion,
  Footer,
  Nav,
  PLANS_EN,
  PLANS_RU,
  PricingSection,
  SIGNUP_URL,
  TelegramMockup,
  type Lang,
} from "./shared.tsx";

const CONTENT = {
  ru: {
    nav: { cta: "Попробовать бесплатно" },
    hero: {
      badge: "Недвижимость · RU/CIS/UAE",
      headline: ["AI-ассистент для ", "агентства недвижимости", ", который не теряет покупателей"],
      sub: "Отвечает на входящие заявки в Telegram за 30 секунд. Уточняет бюджет, район и тип жилья. Записывает на просмотр — и передаёт агенту только квалифицированных покупателей.",
      ctaPrimary: "Попробовать бесплатно",
      ctaSecondary: "Смотреть демо (15 мин)",
      trust: "Работает с Telegram, WhatsApp и Web-виджетом",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "Интересует квартира в Москве, бюджет 10–15 млн" },
        { from: "bot" as const, text: "Отлично! Какой район предпочитаете — центр, ЗАО, или рассматриваете любой?" },
        { from: "user" as const, text: "Ближе к центру, 2-3 комнаты" },
        { from: "bot" as const, text: "У нас есть 3 варианта под ваш запрос. Когда удобно посмотреть — в будни или выходные?" },
        { from: "user" as const, text: "В субботу после 13:00" },
        { from: "bot" as const, text: "Записал на субботу, 14:00. Агент подтвердит детали 👇", cta: true },
      ],
      notify: "🔔 Горячий покупатель передан агенту с полным брифом",
      ctaLabel: "📋 Подтвердить просмотр →",
    },
    howLabel: "Как это работает",
    howTitle: "Запустить за 15 минут — без разработчика",
    steps: [
      {
        title: "Клиент пишет в Telegram или WhatsApp",
        desc: "Бот мгновенно квалифицирует: бюджет, район, тип жилья, срочность. Пока агент занят другими показами.",
      },
      {
        title: "AI подбирает варианты и записывает на просмотр",
        desc: "Бот отвечает по вашей базе объектов, предлагает ближайшее время — и записывает клиента в слот агента.",
      },
      {
        title: "Агент получает горячего клиента с брифом",
        desc: "Только квалифицированные покупатели: бюджет подтверждён, район определён, время выбрано. Никакого cold outreach.",
      },
    ],
    whyLabel: "Почему Lead Engine",
    whyTitle: "Не FAQ-бот. Sales-engine для недвижимости.",
    moats: [
      {
        icon: "🏠",
        title: "Vertical pack для недвижимости",
        desc: "Готовая воронка: первый запрос → квалификация → просмотр → оффер. Поля: бюджет, район, тип, срочность, ипотека.",
      },
      {
        icon: "🧠",
        title: "SPIN/NEPQ квалификация",
        desc: "Не просто FAQ. Бот задаёт правильные вопросы, выявляет мотивацию и срочность — передаёт агенту только горячих.",
      },
      {
        icon: "📅",
        title: "Запись на просмотр 24/7",
        desc: "Agentic booking: бот предлагает слоты агента и записывает клиента без участия человека. Calendly / Cal.com из коробки.",
      },
      {
        icon: "💬",
        title: "Telegram + WhatsApp + Web",
        desc: "Клиенты пишут где удобно — бот ведёт воронку на всех каналах одновременно.",
      },
      {
        icon: "👤",
        title: "Operator handoff первого класса",
        desc: "Встроенный inbox. Агент видит всю историю и перехватывает разговор одним кликом когда нужно.",
      },
    ],
    pricingLabel: "Тарифы",
    pricingTitle: "Прозрачные цены без скрытых платежей",
    pricingNote: "Все тарифы включают: BYOK · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "Частые вопросы",
    faqTitle: "Ответы на главные вопросы",
    faq: [
      {
        q: "Работает с базой объектов?",
        a: "Да. Загрузите описания объектов в базу знаний — бот будет отвечать точно по ним: площадь, цена, этаж, инфраструктура.",
      },
      {
        q: "Можно записывать на просмотры автоматически?",
        a: "Да. Настройте Calendly или Cal.com URL в панели — бот отдаёт ссылку когда клиент готов к просмотру.",
      },
      {
        q: "Работает с ипотечными вопросами?",
        a: "Бот отвечает по вашим документам о партнёрских банках и условиях ипотеки. Для сложных расчётов эскалирует на ипотечного брокера.",
      },
      {
        q: "Нужен разработчик для настройки?",
        a: "Нет. Регистрация → подключение бота → загрузка базы объектов. 15 минут без кода.",
      },
      {
        q: "Можно посмотреть демо?",
        a: "Да, запишитесь на 15-минутное демо — покажем полный флоу от первого запроса до передачи агенту.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Записаться на демо →",
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 Lead Engine" },
  },
  en: {
    nav: { cta: "Try Free" },
    hero: {
      badge: "Real Estate · RU/CIS/UAE",
      headline: ["AI Assistant for ", "Real Estate Agencies", " That Never Loses a Buyer"],
      sub: "Responds to Telegram inquiries in 30 seconds. Qualifies budget, area, and property type. Books viewings — and hands warm buyers to your agent with full context.",
      ctaPrimary: "Try Free",
      ctaSecondary: "Watch Demo (15 min)",
      trust: "Works with Telegram, WhatsApp and Web widget",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "Looking for an apartment in Dubai, budget $300–400K" },
        { from: "bot" as const, text: "Great! Which area? Downtown, Marina, JBR, or open to any?" },
        { from: "user" as const, text: "Marina, 2 bedrooms" },
        { from: "bot" as const, text: "We have 4 listings matching your request. When's a good time to view — weekday or weekend?" },
        { from: "user" as const, text: "Saturday afternoon" },
        { from: "bot" as const, text: "Booked for Saturday at 2 PM. Agent will confirm details 👇", cta: true },
      ],
      notify: "🔔 Warm buyer handed to agent with full brief",
      ctaLabel: "📋 Confirm viewing →",
    },
    howLabel: "How It Works",
    howTitle: "Live in 15 minutes — no developer needed",
    steps: [
      {
        title: "Client messages on Telegram or WhatsApp",
        desc: "Bot instantly qualifies: budget, area, property type, urgency. While your agent is busy with other showings.",
      },
      {
        title: "AI matches listings and books a viewing",
        desc: "Bot answers based on your property database, suggests the nearest available slot — and books the client.",
      },
      {
        title: "Agent receives a warm buyer with full brief",
        desc: "Only qualified buyers: budget confirmed, area defined, time chosen. No cold outreach.",
      },
    ],
    whyLabel: "Why Lead Engine",
    whyTitle: "Not an FAQ bot. A sales engine for real estate.",
    moats: [
      {
        icon: "🏠",
        title: "Real Estate Vertical Pack",
        desc: "Ready-made funnel: first inquiry → qualification → viewing → offer. Fields: budget, area, type, urgency, mortgage.",
      },
      {
        icon: "🧠",
        title: "SPIN/NEPQ Qualification",
        desc: "Not just FAQ. Bot asks the right questions, uncovers motivation and urgency — passes only hot leads to the agent.",
      },
      {
        icon: "📅",
        title: "Viewing Booking 24/7",
        desc: "Agentic booking: bot offers agent's slots and books the client without human involvement. Calendly / Cal.com built-in.",
      },
      {
        icon: "💬",
        title: "Telegram + WhatsApp + Web",
        desc: "Clients reach out wherever they are — bot runs the funnel across all channels simultaneously.",
      },
      {
        icon: "👤",
        title: "First-Class Operator Handoff",
        desc: "Built-in inbox. Agent sees full history and takes over the conversation in one click when needed.",
      },
    ],
    pricingLabel: "Pricing",
    pricingTitle: "Transparent pricing, no hidden fees",
    pricingNote: "All plans include: BYOK · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "FAQ",
    faqTitle: "Common questions, straight answers",
    faq: [
      {
        q: "Does it work with a property database?",
        a: "Yes. Upload property descriptions to the knowledge base — the bot will answer precisely: area, price, floor, amenities.",
      },
      {
        q: "Can it book viewings automatically?",
        a: "Yes. Configure a Calendly or Cal.com URL in the panel — the bot sends the link when the client is ready to view.",
      },
      {
        q: "Does it handle mortgage questions?",
        a: "The bot answers based on your partner bank documents and mortgage terms. For complex calculations it escalates to a mortgage broker.",
      },
      {
        q: "Do I need a developer?",
        a: "No. Sign up → connect bot → upload property database. 15 minutes, zero code.",
      },
      {
        q: "Can I see a demo?",
        a: "Yes, book a 15-minute demo — we'll show the full flow from first inquiry to agent handoff.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Book a demo →",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 Lead Engine" },
  },
};

export default function LandingRealEstate() {
  const [lang, setLang] = useState<Lang>("ru");
  const c = CONTENT[lang];
  const plans = lang === "ru" ? PLANS_RU : PLANS_EN;

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
                <a href={DEMO_URL} className="btn btn-secondary btn-lg">{c.hero.ctaSecondary}</a>
              </div>
              <div className="hero-trust">{c.hero.trust}</div>
            </div>
            <TelegramMockup
              messages={c.tg.messages}
              notify={c.tg.notify}
              botName="RealtyBot"
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

      <PricingSection
        label={c.pricingLabel}
        title={c.pricingTitle}
        plans={plans}
        note={c.pricingNote}
      />

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
