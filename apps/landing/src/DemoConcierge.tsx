import { useState } from "react";
import { DEMO_URL, Footer, Nav, SIGNUP_URL, TelegramMockup, type Lang } from "./shared.tsx";

// Демо-витрина консьерж-сервиса виллы: один гость держит несколько запросов
// (обмен / трансфер / еда / уборка / экскурсия), каждый — свой воркфлоу.
// Все данные статические, без логина и БД.

type L = { ru: string; en: string };
const t = (v: L, lang: Lang) => v[lang];

const COPY = {
  ru: {
    bannerTag: "Демо",
    banner: "Интерактивная витрина админки консьержа на демо-данных — без регистрации.",
    title: ["Один бот — ", "все запросы гостя"],
    sub: "Гость пишет что угодно: поменять валюту, заказать трансфер, ужин или уборку. Бот определяет тип запроса и ведёт каждый отдельным воркфлоу. Ниже — реальный интерфейс на демо-данных виллы.",
    ctaPrimary: "Попробовать бесплатно",
    ctaSecondary: "Написать нам",
    kpiTitle: "Сводка за сегодня",
    boardLabel: "Запросы",
    boardTitle: "Доска запросов по фазам",
    boardSub: "Каждый запрос гостя — отдельная карточка со своим типом. Бот уточняет детали и предлагает условия, оператор подключается на исполнении.",
    dialogLabel: "Диалог",
    dialogTitle: "Бот разбирает любой запрос",
    dialogSub: "Понимает, что нужно гостю, уточняет детали и передаёт оператору условия. Несколько запросов от одного гостя ведутся параллельно.",
    svcLabel: "Услуги",
    svcTitle: "Каталог услуг и веток",
    svcSub: "Каждый тип запроса — короткий воркфлоу поверх единой воронки. Цены и сроки бот берёт из настроек или от оператора, никогда не выдумывает.",
    svcType: "Услуга",
    svcFlow: "Воркфлоу",
    svcOwner: "Кто исполняет",
    ctaTitle: "Хотите такого консьерж-бота для своей виллы или сервиса?",
    ctaSub: "Цена — по запросу. Напишите нам — настроим ветки под ваши услуги и подключим за пару дней.",
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 exchanges·agency" },
  },
  en: {
    bannerTag: "Demo",
    banner: "An interactive showcase of the concierge admin panel on demo data — no signup.",
    title: ["One bot — ", "every guest request"],
    sub: "A guest asks for anything: exchange currency, book a transfer, order dinner or cleaning. The bot detects the request type and runs each as its own workflow. Below is the real interface on demo villa data.",
    ctaPrimary: "Try Free",
    ctaSecondary: "Contact us",
    kpiTitle: "Today at a glance",
    boardLabel: "Requests",
    boardTitle: "Request board by phase",
    boardSub: "Every guest request is its own card with its type. The bot clarifies details and proposes terms; the operator steps in to fulfill.",
    dialogLabel: "Dialog",
    dialogTitle: "The bot handles any request",
    dialogSub: "Understands what the guest needs, clarifies details and hands the operator the terms. Multiple requests from one guest run in parallel.",
    svcLabel: "Services",
    svcTitle: "Service catalog & branches",
    svcSub: "Each request type is a short workflow on a single funnel. Prices and timing come from settings or the operator — never invented.",
    svcType: "Service",
    svcFlow: "Workflow",
    svcOwner: "Fulfilled by",
    ctaTitle: "Want a concierge bot like this for your villa or service?",
    ctaSub: "Pricing on request. Contact us — we'll set up branches for your services and connect it in a couple of days.",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 exchanges·agency" },
  },
};

const KPIS: { value: string; label: L; trend?: string }[] = [
  { value: "31", label: { ru: "Запросов сегодня", en: "Requests today" }, trend: "+9%" },
  { value: "12", label: { ru: "В работе", en: "In progress" } },
  { value: "5", label: { ru: "Гостей онлайн", en: "Guests online" } },
  { value: "71%", label: { ru: "Исполнено", en: "Fulfilled" }, trend: "+6pp" },
  { value: "22 сек", label: { ru: "Ср. ответ", en: "Avg. response" } },
];

const PHASES: { key: string; title: L; accent: string }[] = [
  { key: "capture", title: { ru: "Приём", en: "Intake" }, accent: "#6aa6ff" },
  { key: "qualify", title: { ru: "Детали", en: "Details" }, accent: "#95c1ff" },
  { key: "offer", title: { ru: "Условия", en: "Offer" }, accent: "#c4b5fd" },
  { key: "fulfill", title: { ru: "Исполнение", en: "Fulfill" }, accent: "#fbbf77" },
  { key: "done", title: { ru: "Готово", en: "Done" }, accent: "#5fd0c8" },
];

type Lead = { phase: string; who: string; dir: string; amt: string; note: L; time: string; tag?: L };
const LEADS: Lead[] = [
  { phase: "capture", who: "@villa_guest_7", dir: "Обмен валюты", amt: "—", note: { ru: "«Где поменять доллары?»", en: "“Where can I change USD?”" }, time: "2м", tag: { ru: "Обмен", en: "Exchange" } },
  { phase: "capture", who: "@anna_pkt", dir: "Трансфер", amt: "—", note: { ru: "«Нужна машина в аэропорт»", en: "“Need a car to the airport”" }, time: "6м", tag: { ru: "Трансфер", en: "Transfer" } },
  { phase: "qualify", who: "@mark_villa", dir: "Ужин на вилле", amt: "—", note: { ru: "Уточняем меню и время", en: "Clarifying menu & time" }, time: "9м", tag: { ru: "Еда", en: "Food" } },
  { phase: "qualify", who: "@anna_pkt", dir: "Трансфер · 2 пакс", amt: "—", note: { ru: "Завтра 09:40, рейс SU271", en: "Tomorrow 09:40, flight SU271" }, time: "12м", tag: { ru: "Трансфер", en: "Transfer" } },
  { phase: "offer", who: "@villa_guest_7", dir: "USDT → THB · ฿16 600", amt: "฿16 600", note: { ru: "Курс подтверждён гостем", en: "Rate confirmed by guest" }, time: "4м", tag: { ru: "Обмен", en: "Exchange" } },
  { phase: "offer", who: "@lena_s", dir: "Экскурсия Пхи-Пхи", amt: "฿2 500", note: { ru: "Оператор прислал цену", en: "Operator sent price" }, time: "18м", tag: { ru: "Тур", en: "Tour" } },
  { phase: "fulfill", who: "@mark_villa", dir: "Ужин · шеф на вилле", amt: "฿4 200", note: { ru: "Шеф подтверждён на 19:30", en: "Chef booked for 19:30" }, time: "сейчас", tag: { ru: "Еда", en: "Food" } },
  { phase: "fulfill", who: "@anna_pkt", dir: "Трансфер · минивэн", amt: "฿1 100", note: { ru: "Водитель назначен", en: "Driver assigned" }, time: "5м", tag: { ru: "Трансфер", en: "Transfer" } },
  { phase: "done", who: "@dmitry_k", dir: "Уборка студии", amt: "฿900", note: { ru: "Выполнено ✅", en: "Done ✅" }, time: "1ч", tag: { ru: "Уборка", en: "Cleaning" } },
  { phase: "done", who: "@villa_guest_7", dir: "USDT → THB", amt: "฿16 600", note: { ru: "Выдано наличными ✅", en: "Paid in cash ✅" }, time: "2ч", tag: { ru: "Обмен", en: "Exchange" } },
];

const SERVICES: { type: L; flow: L; owner: L }[] = [
  { type: { ru: "💱 Обмен валюты", en: "💱 Exchange" }, flow: { ru: "Сумма → курс → реквизиты → выдача", en: "Amount → rate → details → payout" }, owner: { ru: "Бот + оператор", en: "Bot + operator" } },
  { type: { ru: "🚐 Трансфер", en: "🚐 Transfer" }, flow: { ru: "Маршрут → цена → водитель", en: "Route → price → driver" }, owner: { ru: "Оператор", en: "Operator" } },
  { type: { ru: "🍽 Еда", en: "🍽 Food" }, flow: { ru: "Заказ → сумма → доставка/шеф", en: "Order → total → delivery/chef" }, owner: { ru: "Оператор", en: "Operator" } },
  { type: { ru: "🧹 Уборка", en: "🧹 Cleaning" }, flow: { ru: "Услуга → время → выполнение", en: "Service → time → done" }, owner: { ru: "Оператор", en: "Operator" } },
  { type: { ru: "🏝 Экскурсия", en: "🏝 Tour" }, flow: { ru: "Направление → цена → бронь", en: "Destination → price → booking" }, owner: { ru: "Оператор", en: "Operator" } },
];

const TG_MESSAGES = [
  { from: "user" as const, text: "Привет! Нужна машина в аэропорт завтра и поменять 500 USDT" },
  { from: "bot" as const, text: "Здравствуйте! Помогу с обоими. Сначала трансфер: во сколько вылет и сколько вас человек?" },
  { from: "user" as const, text: "Вылет 09:40, нас двое" },
  { from: "bot" as const, text: "Принято — подам минивэн к 07:30. Теперь обмен: USDT в какой сети? TRC20, ERC20 или BEP20?" },
  { from: "user" as const, text: "TRC20" },
  { from: "bot" as const, text: "Курс 33.2 THB за USDT, итого 16 600 THB. Подтверждаете? Реквизиты пришлю сразу 👇", cta: true },
];

export default function DemoConcierge() {
  const [lang, setLang] = useState<Lang>("ru");
  const c = COPY[lang];

  return (
    <>
      <Nav lang={lang} setLang={setLang} cta={c.ctaPrimary} />

      <div className="demo-banner">
        <div className="container demo-banner-inner">
          <span className="demo-banner-tag">{c.bannerTag}</span>
          <span>{c.banner}</span>
        </div>
      </div>

      <section className="hero">
        <div className="container">
          <h1 className="hero-headline" style={{ maxWidth: 760 }}>
            {c.title[0]}
            <em>{c.title[1]}</em>
          </h1>
          <p className="hero-sub" style={{ maxWidth: 680 }}>{c.sub}</p>
          <div className="hero-actions">
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg">{c.ctaPrimary}</a>
            <a href={DEMO_URL} className="btn btn-secondary btn-lg">{c.ctaSecondary}</a>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="section-label">{c.kpiTitle}</div>
          <div className="demo-kpis">
            {KPIS.map((k, i) => (
              <div key={i} className="demo-kpi">
                <div className="demo-kpi-value">{k.value}</div>
                <div className="demo-kpi-label">{t(k.label, lang)}</div>
                {k.trend && <div className="demo-kpi-trend">↑ {k.trend}</div>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-label">{c.boardLabel}</div>
          <h2 className="section-title">{c.boardTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>{c.boardSub}</p>
          <div className="demo-board">
            {PHASES.map((ph) => {
              const cards = LEADS.filter((l) => l.phase === ph.key);
              return (
                <div key={ph.key} className="demo-col">
                  <div className="demo-col-head">
                    <span className="demo-col-dot" style={{ background: ph.accent }} />
                    {t(ph.title, lang)}
                    <span className="demo-col-count">{cards.length}</span>
                  </div>
                  {cards.map((l, i) => (
                    <div key={i} className="demo-card" style={{ borderLeftColor: ph.accent }}>
                      <div className="demo-card-top">
                        <span className="demo-card-who">{l.who}</span>
                        {l.tag && <span className="demo-badge">{t(l.tag, lang)}</span>}
                      </div>
                      <div className="demo-card-dir">{l.dir}</div>
                      <div className="demo-card-amt">{l.amt}</div>
                      <div className="demo-card-meta">
                        <span>{t(l.note, lang)}</span>
                        <span className="demo-card-time">{l.time}</span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="hero-inner">
            <div>
              <div className="section-label">{c.dialogLabel}</div>
              <h2 className="section-title" style={{ textAlign: "left" }}>{c.dialogTitle}</h2>
              <p className="section-sub">{c.dialogSub}</p>
            </div>
            <TelegramMockup
              messages={TG_MESSAGES}
              notify="🔔 Два запроса гостя в работе — трансфер и обмен"
              botName="ConciergeBot"
              ctaLabel="📋 Реквизиты для обмена →"
            />
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-label">{c.svcLabel}</div>
          <h2 className="section-title">{c.svcTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>{c.svcSub}</p>
          <div className="demo-rate" style={{ maxWidth: 820, margin: "0 auto" }}>
            <table className="demo-rate-table">
              <thead>
                <tr>
                  <th>{c.svcType}</th>
                  <th>{c.svcFlow}</th>
                  <th>{c.svcOwner}</th>
                </tr>
              </thead>
              <tbody>
                {SERVICES.map((s, i) => (
                  <tr key={i}>
                    <td>{t(s.type, lang)}</td>
                    <td>{t(s.flow, lang)}</td>
                    <td className="demo-rate-dev">{t(s.owner, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container demo-cta">
          <h2 className="section-title">{c.ctaTitle}</h2>
          <p className="section-sub" style={{ margin: "0 auto 28px", textAlign: "center" }}>{c.ctaSub}</p>
          <div className="hero-actions" style={{ justifyContent: "center" }}>
            <a href={SIGNUP_URL} className="btn btn-primary btn-lg">{c.ctaPrimary}</a>
            <a href={DEMO_URL} className="btn btn-secondary btn-lg">{c.ctaSecondary}</a>
          </div>
        </div>
      </section>

      <Footer {...c.footer} />
    </>
  );
}
