import { useState } from "react";

export const SIGNUP_URL =
  (import.meta.env.VITE_APP_URL ?? "https://app.leadengine.pro") + "/signup";
export const DEMO_URL =
  (import.meta.env.VITE_DEMO_URL as string | undefined) ??
  "https://calendly.com/leadengine/demo";

export interface TgMessage {
  from: "user" | "bot";
  text: string;
  cta?: boolean;
}

export function TelegramMockup({
  messages,
  notify,
  botName = "Lead Engine",
  ctaLabel = "📋 Заполнить анкету →",
}: {
  messages: TgMessage[];
  notify: string;
  botName?: string;
  ctaLabel?: string;
}) {
  return (
    <div className="tg-mockup">
      <div className="tg-header">
        <div className="tg-avatar">🤖</div>
        <div>
          <div className="tg-name">{botName}</div>
          <div className="tg-status">online</div>
        </div>
      </div>
      <div className="tg-body">
        {messages.map((msg, i) => (
          <div key={i} className={`tg-msg from-${msg.from}`}>
            <div className="tg-bubble">{msg.text}</div>
            {msg.cta && <div className="tg-cta-bubble">{ctaLabel}</div>}
            <div className="tg-time">{String(10 + i).padStart(2, "0")}:4{i}</div>
          </div>
        ))}
        <div className="tg-notify">{notify}</div>
      </div>
    </div>
  );
}

export interface FaqItem {
  q: string;
  a: string;
  hasDemo?: boolean;
}

export function FaqAccordion({ items, demoBtn }: { items: FaqItem[]; demoBtn: string }) {
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

export type Lang = "ru" | "en";

export function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
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
  );
}

export function Nav({
  lang,
  setLang,
  cta,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
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

export interface Plan {
  name: string;
  price: string;
  priceUnit?: string;
  isCustom?: boolean;
  features: string[];
  cta: string;
  popular?: boolean;
}

export function PricingSection({
  label,
  title,
  plans,
  note,
}: {
  label: string;
  title: string;
  plans: Plan[];
  note: string;
}) {
  return (
    <section className="section section-alt" id="pricing">
      <div className="container">
        <div className="section-label">{label}</div>
        <h2 className="section-title">{title}</h2>
        <div className="plans">
          {plans.map((plan, i) => (
            <div key={i} className={`plan${plan.popular ? " popular" : ""}`}>
              {plan.popular && <div className="plan-badge">★ Popular</div>}
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
          <strong>{note}</strong>
        </p>
      </div>
    </section>
  );
}

export function Footer({
  privacy,
  terms,
  copy,
}: {
  privacy: string;
  terms: string;
  copy: string;
}) {
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

export const PLANS_RU: Plan[] = [
  {
    name: "Free",
    price: "$0",
    priceUnit: "/мес",
    features: ["100 LLM ответов в месяц", "1 канал (Telegram)", "1 база знаний", "Базовая аналитика"],
    cta: "Начать бесплатно",
  },
  {
    name: "Starter",
    price: "$99",
    priceUnit: "/мес",
    features: ["2 000 LLM ответов в месяц", "3 канала (TG + WA + Web)", "5 баз знаний", "Аналитика + история"],
    cta: "Выбрать Starter",
  },
  {
    name: "Pro",
    price: "$199",
    priceUnit: "/мес",
    features: ["Безлимит LLM ответов", "Все каналы", "Безлимит баз знаний", "A/B стили · Приоритетная поддержка"],
    cta: "Выбрать Pro",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "По запросу",
    isCustom: true,
    features: ["Безлимит всего", "SLA соглашение", "Dedicated onboarding", "Custom integrations"],
    cta: "Написать нам",
  },
];

export const PLANS_EN: Plan[] = [
  {
    name: "Free",
    price: "$0",
    priceUnit: "/mo",
    features: ["100 LLM responses/month", "1 channel (Telegram)", "1 knowledge base", "Basic analytics"],
    cta: "Start Free",
  },
  {
    name: "Starter",
    price: "$99",
    priceUnit: "/mo",
    features: ["2,000 LLM responses/month", "3 channels (TG + WA + Web)", "5 knowledge bases", "Analytics + history"],
    cta: "Choose Starter",
  },
  {
    name: "Pro",
    price: "$199",
    priceUnit: "/mo",
    features: ["Unlimited LLM responses", "All channels", "Unlimited knowledge bases", "A/B styles · Priority support"],
    cta: "Choose Pro",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    isCustom: true,
    features: ["Everything unlimited", "SLA agreement", "Dedicated onboarding", "Custom integrations"],
    cta: "Contact Us",
  },
];
