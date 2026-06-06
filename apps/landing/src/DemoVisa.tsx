import { useState } from "react";
import { DEMO_URL, Footer, Nav, SIGNUP_URL, TelegramMockup, type Lang } from "./shared.tsx";

// Демо-витрина визового агентства: бот ведёт заявителя от квалификации до
// получения визы — собирает документы, проверяет финансы, сопровождает подачу.
// Все данные статические, без логина и БД.

type L = { ru: string; en: string };
const t = (v: L, lang: Lang) => v[lang];

const COPY = {
  ru: {
    bannerTag: "Демо",
    banner: "Интерактивная витрина админки визового агентства на демо-данных — без регистрации.",
    title: ["Бот ведёт заявителя ", "до визы"],
    sub: "Квалификация, чек-лист документов, проверка финансов, сопровождение подачи — бот собирает всё сам и держит заявителя в курсе сроков. Ниже — реальный интерфейс на демо-данных.",
    ctaPrimary: "Попробовать бесплатно",
    ctaSecondary: "Написать нам",
    kpiTitle: "Сводка за сегодня",
    boardLabel: "Заявки",
    boardTitle: "Доска заявок по этапам",
    boardSub: "Каждый заявитель проходит путь от квалификации до решения консульства. Бот собирает документы, оператор проверяет и подаёт.",
    dialogLabel: "Диалог",
    dialogTitle: "Бот собирает документы сам",
    dialogSub: "Даёт точный чек-лист, проверяет полноту, напоминает о недостающем. Не даёт обещаний об одобрении — только факты и сроки.",
    docLabel: "Документы",
    docTitle: "Чек-лист пакета документов",
    docSub: "Настраивается под тип визы. Бот запрашивает, проверяет читаемость и собирает всё в одном месте.",
    docName: "Документ",
    docReq: "Обязателен",
    docStatus: "Статус",
    ctaTitle: "Хотите такого визового бота для своего агентства?",
    ctaSub: "Цена — по запросу. Напишите нам — настроим чек-листы под ваши типы виз и подключим за пару дней.",
    yes: "Да",
    no: "Опц.",
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 exchanges·agency" },
  },
  en: {
    bannerTag: "Demo",
    banner: "An interactive showcase of the visa-agency admin panel on demo data — no signup.",
    title: ["The bot guides applicants ", "to a visa"],
    sub: "Qualification, a document checklist, financial verification, submission support — the bot collects everything itself and keeps applicants informed on timelines. Below is the real interface on demo data.",
    ctaPrimary: "Try Free",
    ctaSecondary: "Contact us",
    kpiTitle: "Today at a glance",
    boardLabel: "Applications",
    boardTitle: "Application board by stage",
    boardSub: "Every applicant moves from qualification to the consulate's decision. The bot collects documents; the operator reviews and files.",
    dialogLabel: "Dialog",
    dialogTitle: "The bot collects documents itself",
    dialogSub: "Gives an exact checklist, checks completeness, reminds about what's missing. Makes no approval promises — only facts and timelines.",
    docLabel: "Documents",
    docTitle: "Document package checklist",
    docSub: "Configured per visa type. The bot requests each item, checks legibility and gathers everything in one place.",
    docName: "Document",
    docReq: "Required",
    docStatus: "Status",
    ctaTitle: "Want a visa bot like this for your agency?",
    ctaSub: "Pricing on request. Contact us — we'll set up checklists for your visa types and connect it in a couple of days.",
    yes: "Yes",
    no: "Opt.",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 exchanges·agency" },
  },
};

const KPIS: { value: string; label: L; trend?: string }[] = [
  { value: "24", label: { ru: "Заявок сегодня", en: "Applications today" }, trend: "+7%" },
  { value: "11", label: { ru: "В работе", en: "In progress" } },
  { value: "6", label: { ru: "Ждут консульства", en: "Awaiting consulate" } },
  { value: "82%", label: { ru: "Одобрено", en: "Approved" }, trend: "+3pp" },
  { value: "31 сек", label: { ru: "Ср. ответ", en: "Avg. response" } },
];

const PHASES: { key: string; title: L; accent: string }[] = [
  { key: "qualify", title: { ru: "Квалификация", en: "Qualify" }, accent: "#6aa6ff" },
  { key: "docs", title: { ru: "Документы", en: "Documents" }, accent: "#95c1ff" },
  { key: "finance", title: { ru: "Финансы", en: "Finance" }, accent: "#c4b5fd" },
  { key: "submit", title: { ru: "Подача", en: "Submission" }, accent: "#fbbf77" },
  { key: "review", title: { ru: "Рассмотрение", en: "Processing" }, accent: "#f6c177" },
  { key: "issued", title: { ru: "Виза выдана", en: "Issued" }, accent: "#91d990" },
];

type Lead = { phase: string; who: string; dir: string; amt: string; note: L; time: string; tag?: L };
const LEADS: Lead[] = [
  { phase: "qualify", who: "@sergey_m", dir: "Рабочая · 🇦🇪 ОАЭ", amt: "—", note: { ru: "Уточняем гражданство и тип", en: "Clarifying citizenship & type" }, time: "3м" },
  { phase: "qualify", who: "@daria_k", dir: "Студенческая · 🇩🇪 Германия", amt: "—", note: { ru: "«Какие документы нужны?»", en: "“What documents do I need?”" }, time: "8м" },
  { phase: "docs", who: "@pavel_v", dir: "Туристическая · 🇬🇧 UK", amt: "—", note: { ru: "Загрузил паспорт, ждём выписку", en: "Passport uploaded, awaiting statement" }, time: "12м", tag: { ru: "Чек-лист", en: "Checklist" } },
  { phase: "docs", who: "@olga_t", dir: "Рабочая · 🇦🇪 ОАЭ", amt: "—", note: { ru: "Не хватает диплома", en: "Diploma missing" }, time: "20м", tag: { ru: "Напоминание", en: "Reminder" } },
  { phase: "finance", who: "@ivan_z", dir: "Туристическая · 🇺🇸 USA", amt: "$12 000", note: { ru: "Выписка подтверждена", en: "Statement verified" }, time: "6м" },
  { phase: "submit", who: "@maria_s", dir: "Студенческая · 🇫🇷 Франция", amt: "€80", note: { ru: "Оператор подал заявку", en: "Operator filed application" }, time: "сейчас", tag: { ru: "Подано", en: "Filed" } },
  { phase: "review", who: "@nikolay_p", dir: "Рабочая · 🇦🇪 ОАЭ", amt: "—", note: { ru: "Решение ожидается ~5 дней", en: "Decision expected ~5 days" }, time: "1д" },
  { phase: "review", who: "@elena_g", dir: "Туристическая · 🇬🇧 UK", amt: "—", note: { ru: "На рассмотрении консульства", en: "Under consular review" }, time: "2д" },
  { phase: "issued", who: "@dmitry_a", dir: "Студенческая · 🇩🇪 Германия", amt: "—", note: { ru: "Виза выдана ✅", en: "Visa issued ✅" }, time: "3ч", tag: { ru: "Выдано", en: "Issued" } },
  { phase: "issued", who: "@anna_l", dir: "Рабочая · 🇦🇪 ОАЭ", amt: "—", note: { ru: "Готово, паспорт на выдаче ✅", en: "Done, passport ready ✅" }, time: "5ч", tag: { ru: "Выдано", en: "Issued" } },
];

const DOCS: { name: L; req: boolean; status: L; ok: boolean }[] = [
  { name: { ru: "Загранпаспорт (разворот)", en: "Passport (bio page)" }, req: true, status: { ru: "Получен", en: "Received" }, ok: true },
  { name: { ru: "Фото на визу", en: "Visa photo" }, req: true, status: { ru: "Получено", en: "Received" }, ok: true },
  { name: { ru: "Банковская выписка", en: "Bank statement" }, req: true, status: { ru: "На проверке", en: "Under review" }, ok: false },
  { name: { ru: "Справка с работы", en: "Employment letter" }, req: true, status: { ru: "Ожидается", en: "Pending" }, ok: false },
  { name: { ru: "Диплом / сертификат", en: "Diploma / certificate" }, req: false, status: { ru: "Опционально", en: "Optional" }, ok: true },
  { name: { ru: "Бронь жилья", en: "Accommodation booking" }, req: false, status: { ru: "Получена", en: "Received" }, ok: true },
];

const TG_MESSAGES = [
  { from: "user" as const, text: "Здравствуйте, хочу рабочую визу в ОАЭ" },
  { from: "bot" as const, text: "Здравствуйте! Помогу оформить. Уточните гражданство и есть ли действующий загранпаспорт (срок 6+ мес)?" },
  { from: "user" as const, text: "Россия, паспорт есть до 2029" },
  { from: "bot" as const, text: "Отлично. Для рабочей визы понадобятся: разворот паспорта, фото, банковская выписка и справка с работы. Пришлите для начала фото первого разворота паспорта." },
  { from: "user" as const, text: "*отправил фото паспорта*" },
  { from: "bot" as const, text: "Принято, читается хорошо ✅ Теперь банковская выписка за 3 месяца — загрузите файлом 👇", cta: true },
];

export default function DemoVisa() {
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
              notify="🔔 Документ получен — бот запросил банковскую выписку"
              botName="VisaBot"
              ctaLabel="📎 Загрузить выписку →"
            />
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-label">{c.docLabel}</div>
          <h2 className="section-title">{c.docTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>{c.docSub}</p>
          <div className="demo-rate" style={{ maxWidth: 760, margin: "0 auto" }}>
            <table className="demo-rate-table">
              <thead>
                <tr>
                  <th>{c.docName}</th>
                  <th>{c.docReq}</th>
                  <th>{c.docStatus}</th>
                </tr>
              </thead>
              <tbody>
                {DOCS.map((d, i) => (
                  <tr key={i}>
                    <td>{t(d.name, lang)}</td>
                    <td>{d.req ? c.yes : c.no}</td>
                    <td className="demo-rate-dev">
                      {d.ok ? "✅ " : "⏳ "}
                      {t(d.status, lang)}
                    </td>
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
