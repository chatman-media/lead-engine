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
      badge: "Production · Дубай / Стамбул / Европа",
      headline: ["AI-скаут для ", "модельного агентства", ", который работает 24/7"],
      sub: "Первый контакт в Telegram — за 30 секунд. Собирает анкету, фото и видео кандидата. Передаёт кастинг-директору только тех, кто прошёл отбор.",
      ctaPrimary: "Попробовать бесплатно",
      ctaSecondary: "Смотреть демо (15 мин)",
      trust: "Работает с модельными агентствами в Дубае, Стамбуле и Европе",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "Хочу попробовать себя в модельном бизнесе" },
        { from: "bot" as const, text: "Привет! Рада слышать 🌟 Расскажи немного — сколько лет, рост и откуда ты?" },
        { from: "user" as const, text: "19 лет, 174 см, Москва" },
        { from: "bot" as const, text: "Отлично! Работаем с рынками Дубая и Стамбула. Пришли анкету и 3–5 фото 👇", cta: true },
      ],
      notify: "🔔 Новый кандидат передан кастинг-директору",
      botName: "ModelingAgency Bot",
      ctaLabel: "📸 Отправить анкету и фото →",
    },
    howLabel: "Как это работает",
    howTitle: "Запустить за 15 минут — без разработчика",
    steps: [
      {
        title: "Подключи Telegram-бот за 60 секунд",
        desc: "Введи токен бота — webhook настроится автоматически. Никаких серверов и кода.",
      },
      {
        title: "AI-скаут ведёт диалог",
        desc: "Тёплый SPIN/NEPQ-сценарий, сбор анкеты (имя/возраст/рост/город), фото и видео кандидата.",
      },
      {
        title: "Кастинг-директор получает готовые карточки",
        desc: "Только квалифицированные кандидаты с заполненным профилем — без ручной обработки входящих.",
      },
    ],
    whyLabel: "Почему Lead Engine",
    whyTitle: "Не FAQ-бот. Умный скаут для вашего агентства.",
    moats: [
      {
        icon: "🎭",
        title: "Modeling vertical pack",
        desc: "Готовая воронка: intake → портфолио → кастинг → оффер → контракт. Сбор фото и видео, валидация данных кандидата.",
      },
      {
        icon: "🧠",
        title: "3 персоны скаута",
        desc: "Тёплый скаут (SPIN), кастинг-директор (PAS) или подруга-рекрутер (NEPQ) — выбери стиль под свою аудиторию.",
      },
      {
        icon: "💬",
        title: "Telegram-first",
        desc: "Прямая интеграция. Ваши кандидаты уже в Telegram — бот отвечает им там же.",
      },
      {
        icon: "🔑",
        title: "BYOK — ваш OpenAI ключ",
        desc: "Данные кандидатов не проходят через наши серверы. Row-level security на каждой таблице.",
      },
      {
        icon: "👤",
        title: "Operator handoff первого класса",
        desc: "Кастинг-директор подключается к чату в один клик. AI запомнит контекст и продолжит в нужном тоне.",
      },
    ],
    pricingLabel: "Тарифы",
    pricingTitle: "Прозрачные цены без скрытых платежей",
    pricingNote: "Все тарифы включают: BYOK · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "Частые вопросы",
    faqTitle: "Ответы на главные вопросы",
    faq: [
      {
        q: "Бот умеет принимать фото и видео?",
        a: "Да. Кандидат присылает фото (лицо + полный рост) и видео-представление прямо в Telegram. Бот принимает медиа и передаёт в карточку лида.",
      },
      {
        q: "Работает только с Telegram?",
        a: "Telegram, WhatsApp и Web-чат. Все три канала — на любом тарифе от Starter.",
      },
      {
        q: "Нужен технарь для настройки?",
        a: "Нет. Регистрация → подключение бота → выбор шаблона воронки. 15 минут без кода.",
      },
      {
        q: "Как бот ведёт себя с несовершеннолетними?",
        a: "При возрасте до 16 лет бот вежливо объясняет требования и не запрашивает фото. Эскалация на оператора при необходимости.",
      },
      {
        q: "Можно посмотреть демо?",
        a: "Да, запишитесь на 15-минутное демо — покажем signup → бот → AI в действии → handoff.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Записаться на демо →",
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 Lead Engine" },
  },
  en: {
    nav: { cta: "Try Free" },
    hero: {
      badge: "Production · Dubai / Istanbul / Europe",
      headline: ["AI Scout for Your ", "Modeling Agency", " That Works 24/7"],
      sub: "First Telegram contact in 30 seconds. Collects intake form, photos and video from candidates. Delivers only qualified profiles to your casting director.",
      ctaPrimary: "Try Free",
      ctaSecondary: "Watch Demo (15 min)",
      trust: "Used by modeling agencies in Dubai, Istanbul and Europe",
    },
    tg: {
      messages: [
        { from: "user" as const, text: "I want to try modeling" },
        { from: "bot" as const, text: "Hi! Great to hear 🌟 Tell me — how old are you, your height, and where are you from?" },
        { from: "user" as const, text: "19, 174 cm, Moscow" },
        { from: "bot" as const, text: "Perfect! We work with Dubai and Istanbul markets. Please send the intake form and 3–5 photos 👇", cta: true },
      ],
      notify: "🔔 New candidate passed to casting director",
      botName: "ModelingAgency Bot",
      ctaLabel: "📸 Send intake form & photos →",
    },
    howLabel: "How It Works",
    howTitle: "Live in 15 minutes — no developer needed",
    steps: [
      {
        title: "Connect Telegram bot in 60 seconds",
        desc: "Enter your bot token — webhook setup is automatic. No servers, no code.",
      },
      {
        title: "AI scout runs the conversation",
        desc: "Warm SPIN/NEPQ scenario, intake form collection (name/age/height/city), plus photo and video from the candidate.",
      },
      {
        title: "Casting director gets ready-to-review cards",
        desc: "Only qualified candidates with completed profiles — no manual processing of incoming messages.",
      },
    ],
    whyLabel: "Why Lead Engine",
    whyTitle: "Not an FAQ bot. A smart scout for your agency.",
    moats: [
      {
        icon: "🎭",
        title: "Modeling Vertical Pack",
        desc: "Ready-made funnel: intake → portfolio → casting → offer → contract. Photo and video collection, candidate data validation.",
      },
      {
        icon: "🧠",
        title: "3 Scout Personas",
        desc: "Warm scout (SPIN), casting director (PAS) or friend recruiter (NEPQ) — choose the style that fits your audience.",
      },
      {
        icon: "💬",
        title: "Telegram-First",
        desc: "Direct integration. Your candidates are already in Telegram — the bot meets them there.",
      },
      {
        icon: "🔑",
        title: "BYOK — Your OpenAI Key",
        desc: "Candidate data never passes through our servers. Row-level security on every table.",
      },
      {
        icon: "👤",
        title: "First-Class Operator Handoff",
        desc: "Casting director joins the chat in one click. AI remembers the full context and continues in the right tone.",
      },
    ],
    pricingLabel: "Pricing",
    pricingTitle: "Transparent pricing, no hidden fees",
    pricingNote: "All plans include: BYOK · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "FAQ",
    faqTitle: "Common questions, straight answers",
    faq: [
      {
        q: "Can the bot receive photos and videos?",
        a: "Yes. Candidates send photos (face + full body) and a short intro video directly in Telegram. The bot receives media and passes it to the lead card.",
      },
      {
        q: "Does it only work with Telegram?",
        a: "Telegram, WhatsApp and Web chat. All three channels on any plan from Starter.",
      },
      {
        q: "Do I need a developer?",
        a: "No. Registration → connect bot → choose funnel template. 15 minutes, zero code.",
      },
      {
        q: "How does the bot handle minors?",
        a: "If age is under 16, the bot politely explains requirements and skips photo requests. Escalates to the operator when needed.",
      },
      {
        q: "Can I see a demo?",
        a: "Yes, book a 15-minute demo — we'll show signup → bot → AI in action → handoff.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Book a demo →",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 Lead Engine" },
  },
};

export default function LandingModeling() {
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
