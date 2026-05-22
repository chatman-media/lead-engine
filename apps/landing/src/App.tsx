import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────
type Lang = "ru" | "en";

interface Step {
  title: string;
  desc: string;
}
interface Moat {
  icon: string;
  title: string;
  desc: string;
}
interface Plan {
  name: string;
  price: string;
  priceUnit?: string;
  isCustom?: boolean;
  features: string[];
  cta: string;
  popular?: boolean;
}
interface FaqItem {
  q: string;
  a: string;
  hasDemo?: boolean;
}

// ─── Copy ─────────────────────────────────────────────────────────
const CONTENT: Record<
  Lang,
  {
    nav: { cta: string };
    hero: {
      badge: string;
      headline: [string, string, string]; // parts for color split
      sub: string;
      ctaPrimary: string;
      ctaSecondary: string;
      trust: string;
    };
    tg: { messages: { from: "user" | "bot"; text: string; cta?: boolean }[]; notify: string };
    howTitle: string;
    howLabel: string;
    steps: Step[];
    whyTitle: string;
    whyLabel: string;
    moats: Moat[];
    pricingTitle: string;
    pricingLabel: string;
    plans: Plan[];
    pricingNote: string;
    faqTitle: string;
    faqLabel: string;
    faq: FaqItem[];
    faqDemoBtn: string;
    footer: { privacy: string; terms: string; copy: string };
  }
> = {
  ru: {
    nav: { cta: "Попробовать бесплатно" },
    hero: {
      badge: "Production · UAE / Москва / Алматы",
      headline: ["AI-ассистент для ", "рекрутингового агентства", ", который не теряет лидов"],
      sub: "Отвечает на входящие в Telegram за 30 секунд. Ведёт кандидата от «хочу узнать» до сданной анкеты. Передаёт горячих лидов рекрутеру — с полным контекстом.",
      ctaPrimary: "Попробовать бесплатно",
      ctaSecondary: "Смотреть демо (15 мин)",
      trust: "Используется рекрутинговыми агентствами в UAE, Москве и Алматы",
    },
    tg: {
      messages: [
        { from: "user", text: "Здравствуйте, интересует работа в Дубае" },
        { from: "bot", text: "Привет! Расскажите — какую специальность рассматриваете?" },
        { from: "user", text: "Строитель, есть 5 лет опыта" },
        { from: "bot", text: "Отлично! Зарплата от $1 200/мес. Готовы к переезду в течение 2 месяцев?" },
        { from: "user", text: "Да, готов" },
        { from: "bot", text: "Заполните анкету — займёт 5 минут 👇", cta: true },
      ],
      notify: "🔔 Горячий лид передан рекрутеру",
    },
    howLabel: "Как это работает",
    howTitle: "Запустить за 15 минут — без разработчика",
    steps: [
      {
        title: "Подключи Telegram-бот за 60 секунд",
        desc: "Автоматическая настройка webhook. Введи токен бота — и всё. Никаких серверов, никакого кода.",
      },
      {
        title: "Загрузи документы о вакансиях",
        desc: "PDF, Word, текст — AI изучит условия, зарплаты, требования и будет отвечать точно по ним.",
      },
      {
        title: "AI квалифицирует кандидатов 24/7",
        desc: "SPIN/NEPQ вопросы, сбор 15-полевой анкеты, эскалация горячих лидов на оператора.",
      },
    ],
    whyLabel: "Почему CloserBot",
    whyTitle: "Не FAQ-бот. Sales-engine для рекрутинга.",
    moats: [
      {
        icon: "🎯",
        title: "Рекрутинговый vertical pack",
        desc: "Готовый 12-шаговый funnel: от первого сообщения до документов на визу. Intake-форма, паспорт-OCR, фото-валидация.",
      },
      {
        icon: "🧠",
        title: "Sales-engine, не FAQ-бот",
        desc: "SPIN, NEPQ, AIDA, Cialdini. Бот продаёт — задаёт правильные вопросы, работает с возражениями, закрывает на следующий шаг.",
      },
      {
        icon: "💬",
        title: "Telegram-first",
        desc: "Прямая интеграция. Автоматический webhook за 60 секунд. Ваши кандидаты уже там.",
      },
      {
        icon: "🔑",
        title: "BYOK — ваш OpenAI ключ",
        desc: "Используете собственный API-ключ. Данные кандидатов не проходят через наши серверы.",
      },
      {
        icon: "👤",
        title: "Operator handoff первого класса",
        desc: "Встроенный inbox. Переключитесь на живое общение в один клик. AI запомнит контекст.",
      },
    ],
    pricingLabel: "Тарифы",
    pricingTitle: "Прозрачные цены без скрытых платежей",
    plans: [
      {
        name: "Free",
        price: "$0",
        priceUnit: "/мес",
        features: [
          "100 LLM ответов в месяц",
          "1 канал (Telegram)",
          "1 база знаний",
          "Базовая аналитика",
        ],
        cta: "Начать бесплатно",
      },
      {
        name: "Starter",
        price: "$99",
        priceUnit: "/мес",
        features: [
          "2 000 LLM ответов в месяц",
          "3 канала (TG + WA + Web)",
          "5 баз знаний",
          "Аналитика + история",
        ],
        cta: "Выбрать Starter",
      },
      {
        name: "Pro",
        price: "$199",
        priceUnit: "/мес",
        features: [
          "Безлимит LLM ответов",
          "Все каналы",
          "Безлимит баз знаний",
          "A/B стили · Приоритетная поддержка",
        ],
        cta: "Выбрать Pro",
        popular: true,
      },
      {
        name: "Enterprise",
        price: "По запросу",
        isCustom: true,
        features: [
          "Безлимит всего",
          "SLA соглашение",
          "Dedicated onboarding",
          "Custom integrations (AmoCRM, Bitrix24)",
        ],
        cta: "Написать нам",
      },
    ],
    pricingNote:
      "Все тарифы включают: BYOK (ваш OpenAI ключ) · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "Частые вопросы",
    faqTitle: "Ответы на главные вопросы",
    faq: [
      {
        q: "Мои данные в безопасности?",
        a: "Мы используем BYOK — вы передаёте свой OpenAI ключ. Данные кандидатов хранятся в вашей изолированной базе. Row-level security на каждой таблице.",
      },
      {
        q: "Работает только с Telegram?",
        a: "Telegram, WhatsApp и Web-чат. Все три канала — на любом тарифе от Starter.",
      },
      {
        q: "Нужен технарь для настройки?",
        a: "Нет. Регистрация → подключение бота → загрузка документов. 15 минут без кода.",
      },
      {
        q: "Что если AI не справится?",
        a: "Встроенный operator inbox. Любое сообщение можно перехватить и ответить вручную — бот запомнит и продолжит в нужном тоне.",
      },
      {
        q: "Можно посмотреть демо?",
        a: "Да, запишитесь на 15-минутное демо — покажем signup → бот → AI в действии → handoff.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Записаться на демо →",
    footer: {
      privacy: "Политика конфиденциальности",
      terms: "Условия использования",
      copy: "© 2026 CloserBot",
    },
  },

  en: {
    nav: { cta: "Try Free" },
    hero: {
      badge: "Production · UAE / Moscow / Almaty",
      headline: ["AI Sales Assistant for ", "Recruitment Agencies", " That Never Misses a Lead"],
      sub: "Responds to Telegram inquiries in 30 seconds. Guides candidates from first message to completed intake form. Hands off hot leads to your recruiter — with full conversation context.",
      ctaPrimary: "Try Free",
      ctaSecondary: "Watch Demo (15 min)",
      trust: "Used by recruitment agencies in UAE, Moscow and Almaty",
    },
    tg: {
      messages: [
        { from: "user", text: "Hi, I'm interested in work in Dubai" },
        { from: "bot", text: "Hello! What position are you considering?" },
        { from: "user", text: "Construction worker, 5 years experience" },
        { from: "bot", text: "Great! Salary from $1,200/mo. Can you relocate within 2 months?" },
        { from: "user", text: "Yes, I can" },
        { from: "bot", text: "Fill in the intake form — takes 5 minutes 👇", cta: true },
      ],
      notify: "🔔 Hot lead handed off to recruiter",
    },
    howLabel: "How It Works",
    howTitle: "Live in 15 minutes — no developer needed",
    steps: [
      {
        title: "Connect Telegram bot in 60 seconds",
        desc: "Automatic webhook setup. Enter your bot token — done. No servers, no code.",
      },
      {
        title: "Upload job vacancy documents",
        desc: "PDF, Word, plain text — AI learns conditions, salaries, and requirements, then answers precisely.",
      },
      {
        title: "AI qualifies candidates 24/7",
        desc: "SPIN/NEPQ questions, 15-field intake collection, hot lead escalation to your operator.",
      },
    ],
    whyLabel: "Why CloserBot",
    whyTitle: "Not an FAQ bot. A sales engine for recruitment.",
    moats: [
      {
        icon: "🎯",
        title: "Recruitment Vertical Pack",
        desc: "Ready-made 12-stage funnel: from first message to visa documents. Intake form, passport OCR, photo validation.",
      },
      {
        icon: "🧠",
        title: "Sales Engine, Not FAQ Bot",
        desc: "SPIN, NEPQ, AIDA, Cialdini frameworks. The bot sells — asks the right questions, handles objections, closes to the next step.",
      },
      {
        icon: "💬",
        title: "Telegram-First",
        desc: "Direct integration. Automatic webhook in 60 seconds. Your candidates are already there.",
      },
      {
        icon: "🔑",
        title: "BYOK — Your OpenAI Key",
        desc: "Use your own API key. Candidate data doesn't pass through our servers.",
      },
      {
        icon: "👤",
        title: "First-Class Operator Handoff",
        desc: "Built-in inbox. Switch to live chat in one click. AI remembers the full context.",
      },
    ],
    pricingLabel: "Pricing",
    pricingTitle: "Transparent pricing, no hidden fees",
    plans: [
      {
        name: "Free",
        price: "$0",
        priceUnit: "/mo",
        features: [
          "100 LLM responses/month",
          "1 channel (Telegram)",
          "1 knowledge base",
          "Basic analytics",
        ],
        cta: "Start Free",
      },
      {
        name: "Starter",
        price: "$99",
        priceUnit: "/mo",
        features: [
          "2,000 LLM responses/month",
          "3 channels (TG + WA + Web)",
          "5 knowledge bases",
          "Analytics + history",
        ],
        cta: "Choose Starter",
      },
      {
        name: "Pro",
        price: "$199",
        priceUnit: "/mo",
        features: [
          "Unlimited LLM responses",
          "All channels",
          "Unlimited knowledge bases",
          "A/B styles · Priority support",
        ],
        cta: "Choose Pro",
        popular: true,
      },
      {
        name: "Enterprise",
        price: "Custom",
        isCustom: true,
        features: [
          "Everything unlimited",
          "SLA agreement",
          "Dedicated onboarding",
          "Custom integrations (AmoCRM, Bitrix24)",
        ],
        cta: "Contact Us",
      },
    ],
    pricingNote:
      "All plans include: BYOK (your OpenAI key) · Operator handoff · Telegram + WhatsApp + Web chat",
    faqLabel: "FAQ",
    faqTitle: "Common questions, straight answers",
    faq: [
      {
        q: "Is my data safe?",
        a: "We use BYOK — you provide your own OpenAI key. Candidate data is stored in your isolated database with row-level security on every table.",
      },
      {
        q: "Does it only work with Telegram?",
        a: "Telegram, WhatsApp and Web chat. All three channels available from the Starter plan.",
      },
      {
        q: "Do I need a developer?",
        a: "No. Registration → connect bot → upload documents. 15 minutes, zero code.",
      },
      {
        q: "What if the AI can't handle it?",
        a: "Built-in operator inbox. Intercept any message and reply manually — the bot will remember and continue in the right tone.",
      },
      {
        q: "Can I see a demo?",
        a: "Yes, book a 15-minute demo — we'll show signup → bot → AI in action → handoff.",
        hasDemo: true,
      },
    ],
    faqDemoBtn: "Book a demo →",
    footer: {
      privacy: "Privacy Policy",
      terms: "Terms of Use",
      copy: "© 2026 CloserBot",
    },
  },
};

// ─── Signup URL ───────────────────────────────────────────────────
const SIGNUP_URL = "https://app.TODO_DOMAIN.com/signup";
const DEMO_URL = "#demo";

// ─── Components ───────────────────────────────────────────────────

function TelegramMockup({ data }: { data: (typeof CONTENT)["ru"]["tg"] }) {
  return (
    <div className="tg-mockup">
      <div className="tg-header">
        <div className="tg-avatar">🤖</div>
        <div>
          <div className="tg-name">CloserBot</div>
          <div className="tg-status">online</div>
        </div>
      </div>
      <div className="tg-body">
        {data.messages.map((msg, i) => (
          <div key={i} className={`tg-msg from-${msg.from}`}>
            <div className="tg-bubble">{msg.text}</div>
            {msg.cta && (
              <div className="tg-cta-bubble">📋 Заполнить анкету →</div>
            )}
            <div className="tg-time">
              {String(10 + i).padStart(2, "0")}:4{i}
            </div>
          </div>
        ))}
        <div className="tg-notify">{data.notify}</div>
      </div>
    </div>
  );
}

function FaqAccordion({ items, demoBtn }: { items: FaqItem[]; demoBtn: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="faq-list">
      {items.map((item, i) => (
        <div key={i} className={`faq-item${open === i ? " open" : ""}`}>
          <button className="faq-q" onClick={() => setOpen(open === i ? null : i)}>
            {item.q}
            <span className="faq-chevron">⌄</span>
          </button>
          <div className="faq-a">
            <p>{item.a}</p>
            {item.hasDemo && (
              <a href={DEMO_URL} className="btn btn-outline">
                {demoBtn}
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────

export default function App() {
  const [lang, setLang] = useState<Lang>("ru");
  const c = CONTENT[lang];

  return (
    <>
      {/* ── Nav ── */}
      <nav className="nav">
        <div className="container">
          <div className="nav-inner">
            <a href="/" className="nav-logo">
              Closer<span>Bot</span>
            </a>
            <div className="nav-right">
              <div className="lang-toggle">
                <button
                  className={`lang-btn${lang === "ru" ? " active" : ""}`}
                  onClick={() => setLang("ru")}
                >
                  RU
                </button>
                <button
                  className={`lang-btn${lang === "en" ? " active" : ""}`}
                  onClick={() => setLang("en")}
                >
                  EN
                </button>
              </div>
              <a href={SIGNUP_URL} className="btn btn-primary">
                {c.nav.cta}
              </a>
            </div>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
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
                <a href={DEMO_URL} className="btn btn-secondary btn-lg">
                  {c.hero.ctaSecondary}
                </a>
              </div>
              <div className="hero-trust">{c.hero.trust}</div>
            </div>
            <TelegramMockup data={c.tg} />
          </div>
        </div>
      </section>

      {/* ── How It Works ── */}
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

      {/* ── Why Us ── */}
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

      {/* ── Pricing ── */}
      <section className="section section-alt" id="pricing">
        <div className="container">
          <div className="section-label">{c.pricingLabel}</div>
          <h2 className="section-title">{c.pricingTitle}</h2>
          <div className="plans">
            {c.plans.map((plan, i) => (
              <div key={i} className={`plan${plan.popular ? " popular" : ""}`}>
                {plan.popular && (
                  <div className="plan-badge">★ Popular</div>
                )}
                <div className="plan-name">{plan.name}</div>
                {plan.isCustom ? (
                  <div className="plan-price-custom">{plan.price}</div>
                ) : (
                  <div className="plan-price">
                    {plan.price}
                    {plan.priceUnit && <span>{plan.priceUnit}</span>}
                  </div>
                )}
                <ul className="plan-features">
                  {plan.features.map((f, j) => (
                    <li key={j}>{f}</li>
                  ))}
                </ul>
                <a
                  href={plan.isCustom ? DEMO_URL : SIGNUP_URL}
                  className={`btn ${plan.popular ? "btn-primary" : "btn-secondary"}`}
                  style={{ textAlign: "center", justifyContent: "center" }}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>
          <p className="plan-note">
            <strong>{c.pricingNote}</strong>
          </p>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="section" id="faq">
        <div className="container">
          <div className="section-label">{c.faqLabel}</div>
          <h2 className="section-title">{c.faqTitle}</h2>
          <FaqAccordion items={c.faq} demoBtn={c.faqDemoBtn} />
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="footer">
        <div className="container">
          <div className="footer-inner">
            <div className="footer-logo">
              Closer<span>Bot</span>
            </div>
            <div className="footer-links">
              <a href="/privacy">{c.footer.privacy}</a>
              <a href="/terms">{c.footer.terms}</a>
            </div>
            <div className="footer-copy">{c.footer.copy}</div>
          </div>
        </div>
      </footer>
    </>
  );
}
