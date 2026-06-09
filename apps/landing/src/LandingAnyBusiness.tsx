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
      badge: "Работает с любым бизнесом · Telegram / WhatsApp / Web",
      headline: ["AI-ассистент для ", "любого бизнеса", " — без кода и разработчика"],
      sub: "Опиши свой бизнес — AI сам соберёт воронку продаж за 30 секунд. Квалифицирует лидов, собирает заявки, передаёт горячих клиентов менеджеру.",
      ctaPrimary: "Собрать воронку бесплатно",
      ctaSecondary: "Смотреть демо (15 мин)",
      trust: "Используется агентствами, студиями, клиниками и малым бизнесом",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "Хочу записаться на курс по Python" },
        { from: "bot" as const, text: "Отлично! У нас есть курсы с нуля и уровень middle. Какой опыт в программировании?" },
        { from: "user" as const, text: "Полный ноль, но очень хочу" },
        { from: "bot" as const, text: "Идеально для нашего курса «Python с нуля»! Старт 15 июня, стоимость 12 000 ₽. Записать?" },
        { from: "user" as const, text: "Да!" },
        { from: "bot" as const, text: "Оставьте email — пришлём программу и доступ к первому уроку 👇", cta: true },
      ],
      notify: "🔔 Горячий лид передан менеджеру",
      botName: "YourBusiness Bot",
      ctaLabel: "✅ Зарегистрироваться →",
    },
    howLabel: "Как это работает",
    howTitle: "От описания бизнеса — до работающего бота за 15 минут",
    steps: [
      {
        title: "Опиши свой бизнес за 2 минуты",
        desc: "AI-конструктор сам соберёт воронку: этапы, вопросы для квалификации, поля анкеты — специально под вашу нишу.",
      },
      {
        title: "Подключи бот и загрузи материалы",
        desc: "Telegram, WhatsApp или web-чат. Загрузи прайс-лист, FAQ или каталог — AI будет отвечать точно по ним.",
      },
      {
        title: "Получай горячих лидов с контекстом",
        desc: "Только квалифицированные клиенты с заполненной анкетой. AI передаёт менеджеру полный контекст диалога.",
      },
    ],
    whyLabel: "Почему Lead Engine",
    whyTitle: "Больше, чем чат-бот. Полный AI sales engine.",
    moats: [
      {
        icon: "🤖",
        title: "AI-конструктор воронки",
        desc: "Опиши бизнес в свободной форме — AI создаст структуру воронки, этапы, вопросы и поля без единой строки кода.",
      },
      {
        icon: "🧠",
        title: "Sales-frameworks, не FAQ",
        desc: "SPIN, NEPQ, AIDA, PAS. Бот квалифицирует, работает с возражениями и закрывает на следующий шаг — не просто отвечает на вопросы.",
      },
      {
        icon: "💬",
        title: "Омниканальность",
        desc: "Telegram, WhatsApp, web-виджет. Все каналы в одном inbox. Ответы оператора синхронизируются со всеми.",
      },
      {
        icon: "📊",
        title: "CRM прямо внутри",
        desc: "Воронка, карточки лидов, статистика по фазам — не нужен отдельный CRM для малого бизнеса.",
      },
      {
        icon: "🔑",
        title: "BYOK — ваш OpenAI ключ",
        desc: "Данные клиентов не проходят через наши серверы. Используете собственный API-ключ.",
      },
      {
        icon: "👤",
        title: "Operator handoff первого класса",
        desc: "Менеджер подключается к любому чату в один клик. AI запомнит контекст и продолжит работу.",
      },
    ],
    usecasesLabel: "Подходит для любой ниши",
    usecasesTitle: "Уже работает в десятках ниш",
    usecasesCta: "Смотреть живые демо вертикалей →",
    usecases: [
      { icon: "🏠", title: "Недвижимость", desc: "Квалификация покупателей, запись на просмотр, сбор документов" },
      { icon: "🩺", title: "Медицина / стоматология", desc: "Запись на приём, сбор жалоб, предварительная анкета" },
      { icon: "📚", title: "Онлайн-образование", desc: "Квалификация студентов, регистрация на курс, follow-up" },
      { icon: "💅", title: "Beauty / услуги", desc: "Запись онлайн, подбор услуги, напоминания о визите" },
      { icon: "🏋️", title: "Фитнес / спорт", desc: "Выбор программы тренировок, продажа абонемента" },
      { icon: "🎯", title: "Рекрутинг", desc: "Сбор анкет кандидатов, квалификация, handoff рекрутёру" },
    ],
    pricingLabel: "Тарифы",
    pricingTitle: "Прозрачные цены без скрытых платежей",
    pricingNote: "Все тарифы включают: AI-конструктор воронки · BYOK · Operator handoff · 3 канала",
    faqLabel: "Частые вопросы",
    faqTitle: "Ответы на главные вопросы",
    faq: [
      {
        q: "Мой бизнес сложный — AI разберётся?",
        a: "AI-конструктор работает по описанию бизнеса в свободной форме. Если воронка получилась неточной — вы можете отредактировать любой этап прямо в интерфейсе.",
      },
      {
        q: "Нужен технарь для настройки?",
        a: "Нет. Регистрация → описание бизнеса → подключение бота → загрузка материалов. 15 минут без кода.",
      },
      {
        q: "Работает только с Telegram?",
        a: "Telegram, WhatsApp и Web-чат. Все три канала на любом тарифе от Starter.",
      },
      {
        q: "Мои данные в безопасности?",
        a: "BYOK — вы передаёте свой OpenAI ключ. Данные клиентов хранятся в вашей изолированной базе с row-level security.",
      },
      {
        q: "Можно посмотреть демо?",
        a: "Да, запишитесь на 15-минутное демо — покажем signup → описание бизнеса → готовый бот за 30 секунд.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Записаться на демо →",
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 Lead Engine" },
  },
  en: {
    nav: { cta: "Try Free" },
    hero: {
      badge: "Works With Any Business · Telegram / WhatsApp / Web",
      headline: ["AI Sales Assistant for ", "Any Business", " — No Code, No Developer"],
      sub: "Describe your business — AI builds a sales funnel in 30 seconds. Qualifies leads, collects applications, and hands off hot prospects to your manager.",
      ctaPrimary: "Build Your Funnel Free",
      ctaSecondary: "Watch Demo (15 min)",
      trust: "Used by agencies, studios, clinics and small businesses",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "I want to join your Python course" },
        { from: "bot" as const, text: "Great! We have beginner and middle-level tracks. What's your coding experience?" },
        { from: "user" as const, text: "Complete beginner, but very motivated" },
        { from: "bot" as const, text: "Perfect for our 'Python from Scratch' course! Starts June 15, $149. Shall I register you?" },
        { from: "user" as const, text: "Yes!" },
        { from: "bot" as const, text: "Drop your email — we'll send the syllabus and first lesson access 👇", cta: true },
      ],
      notify: "🔔 Hot lead handed off to manager",
      botName: "YourBusiness Bot",
      ctaLabel: "✅ Register →",
    },
    howLabel: "How It Works",
    howTitle: "From business description to a working bot in 15 minutes",
    steps: [
      {
        title: "Describe your business in 2 minutes",
        desc: "The AI builder creates the funnel: stages, qualification questions, intake fields — tailored to your niche.",
      },
      {
        title: "Connect bot and upload materials",
        desc: "Telegram, WhatsApp or web chat. Upload a price list, FAQ or catalog — AI will answer accurately from them.",
      },
      {
        title: "Receive hot leads with full context",
        desc: "Only qualified clients with completed intake forms. AI hands your manager the full conversation context.",
      },
    ],
    whyLabel: "Why Lead Engine",
    whyTitle: "More than a chatbot. A complete AI sales engine.",
    moats: [
      {
        icon: "🤖",
        title: "AI Funnel Builder",
        desc: "Describe your business in plain language — AI builds the funnel structure, stages, questions and fields with zero code.",
      },
      {
        icon: "🧠",
        title: "Sales Frameworks, Not FAQ",
        desc: "SPIN, NEPQ, AIDA, PAS. The bot qualifies, handles objections and closes to the next step — not just answers questions.",
      },
      {
        icon: "💬",
        title: "Omnichannel",
        desc: "Telegram, WhatsApp, web widget. All channels in one inbox. Operator replies sync across all of them.",
      },
      {
        icon: "📊",
        title: "Built-In CRM",
        desc: "Funnel, lead cards, phase stats — no separate CRM needed for small business.",
      },
      {
        icon: "🔑",
        title: "BYOK — Your OpenAI Key",
        desc: "Customer data never passes through our servers. Use your own API key.",
      },
      {
        icon: "👤",
        title: "First-Class Operator Handoff",
        desc: "Manager joins any chat in one click. AI remembers context and continues seamlessly.",
      },
    ],
    usecasesLabel: "Works for Any Niche",
    usecasesTitle: "Already running in dozens of verticals",
    usecasesCta: "See live vertical demos →",
    usecases: [
      { icon: "🏠", title: "Real Estate", desc: "Buyer qualification, viewing bookings, document collection" },
      { icon: "🩺", title: "Healthcare / Dentistry", desc: "Appointment booking, symptom collection, pre-intake" },
      { icon: "📚", title: "Online Education", desc: "Student qualification, course registration, follow-up" },
      { icon: "💅", title: "Beauty / Services", desc: "Online booking, service matching, visit reminders" },
      { icon: "🏋️", title: "Fitness / Sports", desc: "Training plan selection, membership sales" },
      { icon: "🎯", title: "Recruitment", desc: "Candidate intake, qualification, handoff to recruiter" },
    ],
    pricingLabel: "Pricing",
    pricingTitle: "Transparent pricing, no hidden fees",
    pricingNote: "All plans include: AI funnel builder · BYOK · Operator handoff · 3 channels",
    faqLabel: "FAQ",
    faqTitle: "Common questions, straight answers",
    faq: [
      {
        q: "My business is complex — will the AI handle it?",
        a: "The AI builder works from a free-form business description. If the funnel isn't quite right, you can edit any stage directly in the interface.",
      },
      {
        q: "Do I need a developer?",
        a: "No. Registration → describe business → connect bot → upload materials. 15 minutes, zero code.",
      },
      {
        q: "Does it only work with Telegram?",
        a: "Telegram, WhatsApp and Web chat. All three channels on any plan from Starter.",
      },
      {
        q: "Is my data safe?",
        a: "BYOK — you provide your own OpenAI key. Customer data is stored in your isolated database with row-level security.",
      },
      {
        q: "Can I see a demo?",
        a: "Yes, book a 15-minute demo — we'll show signup → describe business → working bot in 30 seconds.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Book a demo →",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 Lead Engine" },
  },
};

export default function LandingAnyBusiness() {
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
              botName={c.tg.botName}
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

      <section className="section" id="usecases">
        <div className="container">
          <div className="section-label">{c.usecasesLabel}</div>
          <h2 className="section-title">{c.usecasesTitle}</h2>
          <div className="moats">
            {c.usecases.map((u, i) => (
              <div key={i} className="moat">
                <div className="moat-icon">{u.icon}</div>
                <div className="moat-title">{u.title}</div>
                <p className="moat-desc">{u.desc}</p>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "2rem", textAlign: "center" }}>
            <a href="/demo/verticals" className="btn btn-secondary">{c.usecasesCta}</a>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="why">
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
