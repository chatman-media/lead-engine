import { type FormEvent, useState } from "react";
import { DEMO_URL, Footer, type Lang, Nav } from "./shared.tsx";

const API_BASE = (
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.DEV ? "http://127.0.0.1:3000" : "")
).replace(/\/$/, "");
const TELEGRAM_URL = "https://t.me/alexanderkireev";

const COPY = {
  ru: {
    navCta: "Ранний доступ",
    bannerTag: "Alpha",
    banner:
      "Lead Engine открыт вручную: мы подключаем ограниченное число бизнесов и собираем workflow вместе с владельцем.",
    badge: "Private alpha · ручной onboarding",
    title: ["Ранний доступ к ", "AI Front Office", " для входящих заявок"],
    sub: "Это не публичная регистрация. Оставь email и коротко опиши бизнес: обменник, недвижимость, сервис-деск, рекрутинг, визы, аренда, продакшн или свой workflow. Мы разберём входящий поток, соберём стадии, поля, базу знаний и operator handoff.",
    primary: "Запросить alpha-доступ",
    secondary: "Написать в Telegram",
    email: "Рабочий email",
    name: "Имя",
    company: "Бизнес / проект",
    useCase: "Что нужно автоматизировать",
    useCasePlaceholder:
      "Например: заявки на обмен, трансфер, уборку и бронь жилья из Telegram/WhatsApp",
    submit: "Отправить заявку",
    submitting: "Отправляю...",
    successTitle: "Заявка записана",
    success:
      "Email сохранён в alpha waitlist. Следующий шаг — коротко обсудить workflow и понять, что подключать первым.",
    error: "Не удалось отправить. Напиши в Telegram, чтобы не ждать.",
    proofTitle: "Что входит в alpha",
    footer: {
      privacy: "Политика конфиденциальности",
      terms: "Условия использования",
      copy: "© 2026 Lead Engine",
    },
    cards: [
      {
        k: "01",
        t: "Workflow builder",
        d: "Стадии, поля, условия переходов и поведение AI под твой входящий поток.",
      },
      {
        k: "02",
        t: "Operator handoff",
        d: "Менеджер получает не весь чат, а точку решения: цена, документы, слот, подтверждение.",
      },
      {
        k: "03",
        t: "Knowledge base",
        d: "AI отвечает по твоим правилам, прайсам, объектам, требованиям и ограничениям.",
      },
      {
        k: "04",
        t: "Vertical demo fit",
        d: "Проверяем, какой pack ближе: exchange, real estate, concierge, visa, scooter, recruitment.",
      },
    ],
    ops: [
      { value: "manual", label: "onboarding" },
      { value: "alpha", label: "limited access" },
      { value: "workflow", label: "not chatbot" },
    ],
  },
  en: {
    navCta: "Early access",
    bannerTag: "Alpha",
    banner:
      "Lead Engine is opened manually: we onboard a limited number of businesses and build the workflow with the owner.",
    badge: "Private alpha · guided onboarding",
    title: ["Early access to ", "AI Front Office", " for inbound requests"],
    sub: "This is not public signup. Leave your email and describe the business: exchange, real estate, service desk, recruitment, visa, rental, production or your own workflow. We map the inbound flow, stages, fields, knowledge base and operator handoff.",
    primary: "Request alpha access",
    secondary: "Message on Telegram",
    email: "Work email",
    name: "Name",
    company: "Business / project",
    useCase: "What should be automated",
    useCasePlaceholder:
      "Example: exchange, transfer, cleaning and housing requests from Telegram/WhatsApp",
    submit: "Submit request",
    submitting: "Sending...",
    successTitle: "Request saved",
    success:
      "Email is saved in the alpha waitlist. Next step: discuss the workflow and decide what to connect first.",
    error: "Could not submit. Message on Telegram so you do not wait.",
    proofTitle: "What alpha includes",
    footer: {
      privacy: "Privacy Policy",
      terms: "Terms of Use",
      copy: "© 2026 Lead Engine",
    },
    cards: [
      {
        k: "01",
        t: "Workflow builder",
        d: "Stages, fields, transition rules and AI behavior for your inbound flow.",
      },
      {
        k: "02",
        t: "Operator handoff",
        d: "Manager gets the decision point, not the whole chat: price, docs, slot, confirmation.",
      },
      {
        k: "03",
        t: "Knowledge base",
        d: "AI answers from your rules, prices, listings, requirements and constraints.",
      },
      {
        k: "04",
        t: "Vertical demo fit",
        d: "We check which pack fits: exchange, real estate, concierge, visa, scooter, recruitment.",
      },
    ],
    ops: [
      { value: "manual", label: "onboarding" },
      { value: "alpha", label: "limited access" },
      { value: "workflow", label: "not chatbot" },
    ],
  },
};

export default function EarlyAccess() {
  const [lang, setLang] = useState<Lang>("ru");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [useCase, setUseCase] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const c = COPY[lang];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    try {
      const res = await fetch(`${API_BASE}/api/public/early-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          company,
          useCase,
          source: "landing_alpha",
          locale: lang,
          website,
        }),
      });
      if (!res.ok) throw new Error(`early_access_${res.status}`);
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  return (
    <>
      <Nav cta={c.navCta} lang={lang} setLang={setLang} />

      <div className="demo-banner">
        <div className="container demo-banner-inner">
          <span className="demo-banner-tag">{c.bannerTag}</span>
          <span>{c.banner}</span>
        </div>
      </div>

      <section className="hero early-access-hero">
        <div className="container">
          <div className="early-access-grid">
            <div>
              <div className="hero-badge">{c.badge}</div>
              <h1 className="hero-headline">
                {c.title[0]}
                <span>{c.title[1]}</span>
                {c.title[2]}
              </h1>
              <p className="hero-sub">{c.sub}</p>
              <div className="hero-actions">
                <a href="#alpha-form" className="btn btn-primary btn-lg">
                  {c.primary}
                </a>
                <a href={TELEGRAM_URL} className="btn btn-secondary btn-lg">
                  {c.secondary}
                </a>
              </div>
              <div className="early-access-kpis">
                {c.ops.map((item) => (
                  <div key={item.label}>
                    <strong>{item.value}</strong>
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <form id="alpha-form" className="early-access-form" onSubmit={onSubmit}>
              <div className="section-label">{c.bannerTag}</div>
              <label>
                <span>{c.email}</span>
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="founder@company.com"
                />
              </label>
              <label>
                <span>{c.name}</span>
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Alexander"
                />
              </label>
              <label>
                <span>{c.company}</span>
                <input
                  autoComplete="organization"
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                  placeholder="Island Ops"
                />
              </label>
              <label>
                <span>{c.useCase}</span>
                <textarea
                  value={useCase}
                  onChange={(event) => setUseCase(event.target.value)}
                  placeholder={c.useCasePlaceholder}
                />
              </label>
              <input
                className="early-access-hp"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                aria-hidden="true"
              />
              <button
                type="submit"
                className="btn btn-primary btn-lg"
                disabled={status === "submitting"}
              >
                {status === "submitting" ? c.submitting : c.submit}
              </button>
              {status === "success" && (
                <div className="early-access-status ok">
                  <strong>{c.successTitle}</strong>
                  <span>{c.success}</span>
                </div>
              )}
              {status === "error" && (
                <div className="early-access-status error">
                  <strong>{c.error}</strong>
                  <a href={TELEGRAM_URL}>{c.secondary}</a>
                </div>
              )}
            </form>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-label">Alpha scope</div>
          <h2 className="section-title">{c.proofTitle}</h2>
          <div className="early-access-card-grid">
            {c.cards.map((card) => (
              <div key={card.k} className="early-access-card">
                <span>{card.k}</span>
                <strong>{card.t}</strong>
                <p>{card.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container demo-cta">
          <div className="section-label">Live demos</div>
          <h2 className="section-title">Workflow before account</h2>
          <p className="section-sub">
            {lang === "ru"
              ? "Перед доступом к кабинету можно посмотреть реальные demo-пульты и выбрать, какой workflow собирать первым."
              : "Before account access, review real demo control rooms and choose which workflow to build first."}
          </p>
          <div className="hero-actions" style={{ justifyContent: "center" }}>
            <a href="/demo/verticals" className="btn btn-secondary btn-lg">
              Vertical demos
            </a>
            <a href="/demo/services" className="btn btn-secondary btn-lg">
              Service workflows
            </a>
            <a href={DEMO_URL} className="btn btn-outline btn-lg">
              {c.secondary}
            </a>
          </div>
        </div>
      </section>

      <Footer {...c.footer} />
    </>
  );
}
