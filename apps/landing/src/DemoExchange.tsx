import { useState } from "react";
import { DEMO_URL, Footer, Nav, SIGNUP_URL, TelegramMockup, type Lang } from "./shared.tsx";

// Демо-витрина: показывает, что обменник получает в admin-панели — на моках,
// без логина и БД. Все данные ниже статические («много сидов» для наглядности).

type L = { ru: string; en: string };
const t = (v: L, lang: Lang) => v[lang];

const COPY = {
  ru: {
    bannerTag: "Демо",
    banner: "Это интерактивная витрина админки на демо-данных — без регистрации.",
    title: ["Вот что вы получите в ", "admin-панели"],
    sub: "Доска лидов по фазам сделки, живой диалог бота, тир-курс-карта и реквизиты — всё в одном месте. Ниже — реальный интерфейс на демо-данных обменника в Пхукете.",
    ctaPrimary: "Попробовать бесплатно",
    ctaSecondary: "Написать нам",
    kpiTitle: "Сводка за сегодня",
    boardLabel: "Лиды",
    boardTitle: "Доска сделок по фазам",
    boardSub: "Каждый клиент проходит путь от первого сообщения до выдачи THB. Бот ведёт, оператор подключается на выдаче.",
    dialogLabel: "Диалог",
    dialogTitle: "Бот ведёт клиента сам",
    dialogSub: "Уточняет актив и сеть, фиксирует курс, выдаёт реквизиты. Оператор подключается только на выдаче QR.",
    rateLabel: "Курсы",
    rateTitle: "Тир-курс-карта",
    rateSub: "Чем больше сумма — тем лучше курс. Бот всегда транслирует то, что задано здесь, и никогда не выдумывает курс.",
    rateAmt: "Сумма",
    rateRate: "Курс",
    rateDev: "К рынку",
    reqLabel: "Реквизиты",
    reqTitle: "Реквизиты приёма и выдачи",
    reqSub: "Настраиваются в панели. Бот выдаёт нужные реквизиты автоматически по выбранному способу.",
    ctaTitle: "Хотите такую же панель для своего обменника?",
    ctaSub: "Цена — по запросу. Напишите нам, подберём под ваш объём и подключим за пару дней.",
    footer: { privacy: "Политика конфиденциальности", terms: "Условия использования", copy: "© 2026 exchanges·agency" },
  },
  en: {
    bannerTag: "Demo",
    banner: "An interactive showcase of the admin panel on demo data — no signup.",
    title: ["Here's what you get in the ", "admin panel"],
    sub: "A deal board by funnel phase, a live bot dialog, a tiered rate card and payment details — all in one place. Below is the real interface on demo data from a Phuket exchange.",
    ctaPrimary: "Try Free",
    ctaSecondary: "Contact us",
    kpiTitle: "Today at a glance",
    boardLabel: "Leads",
    boardTitle: "Deal board by phase",
    boardSub: "Every client moves from first message to THB payout. The bot leads; the operator steps in at payout.",
    dialogLabel: "Dialog",
    dialogTitle: "The bot leads the client on its own",
    dialogSub: "Clarifies asset and network, locks the rate, shares payment details. The operator only joins for the QR payout.",
    rateLabel: "Rates",
    rateTitle: "Tiered rate card",
    rateSub: "The bigger the amount, the better the rate. The bot always shows what's set here — and never invents a rate.",
    rateAmt: "Amount",
    rateRate: "Rate",
    rateDev: "vs market",
    reqLabel: "Payment details",
    reqTitle: "Inbound & payout details",
    reqSub: "Configured in the panel. The bot serves the right details automatically based on the chosen method.",
    ctaTitle: "Want the same panel for your exchange?",
    ctaSub: "Pricing on request. Contact us — we'll tailor it to your volume and connect it in a couple of days.",
    footer: { privacy: "Privacy Policy", terms: "Terms of Use", copy: "© 2026 exchanges·agency" },
  },
};

const KPIS: { value: string; label: L; trend?: string }[] = [
  { value: "47", label: { ru: "Лидов сегодня", en: "Leads today" }, trend: "+12%" },
  { value: "9", label: { ru: "В работе", en: "In progress" } },
  { value: "฿1.84M", label: { ru: "Выдано за день", en: "Paid out today" }, trend: "+8%" },
  { value: "63%", label: { ru: "Конверсия", en: "Conversion" }, trend: "+4pp" },
  { value: "28 сек", label: { ru: "Ср. ответ", en: "Avg. response" } },
];

const PHASES: { key: string; title: L; accent: string }[] = [
  { key: "capture", title: { ru: "Захват", en: "Capture" }, accent: "#6aa6ff" },
  { key: "qualify", title: { ru: "Квалификация", en: "Qualify" }, accent: "#95c1ff" },
  { key: "offer", title: { ru: "Курс", en: "Rate" }, accent: "#c4b5fd" },
  { key: "pay", title: { ru: "Оплата", en: "Payment" }, accent: "#fbbf77" },
  { key: "payout", title: { ru: "Выдача", en: "Payout" }, accent: "#91d990" },
  { key: "done", title: { ru: "Готово", en: "Done" }, accent: "#5fd0c8" },
];

type Lead = { phase: string; who: string; dir: string; amt: string; note: L; time: string; tag?: L };
const LEADS: Lead[] = [
  { phase: "capture", who: "@nomad_max", dir: "USDT TRC20 → THB", amt: "฿16 600", note: { ru: "Спросил курс на 500 USDT", en: "Asked rate for 500 USDT" }, time: "2м" },
  { phase: "capture", who: "@katya_pkt", dir: "RUB Сбер → THB", amt: "—", note: { ru: "«Здравствуйте, меняете рубли?»", en: "“Hi, do you exchange rubles?”" }, time: "5м" },
  { phase: "capture", who: "@dmitry_k", dir: "BTC → THB", amt: "—", note: { ru: "«Привет, какой курс BTC?»", en: "“Hey, what's the BTC rate?”" }, time: "11м" },
  { phase: "qualify", who: "@ivan_trv", dir: "USDT BEP20 → THB", amt: "฿33 100", note: { ru: "Уточняем сеть и сумму", en: "Clarifying network & amount" }, time: "8м" },
  { phase: "qualify", who: "@olga_v", dir: "RUB Тинькофф → THB", amt: "฿28 400", note: { ru: "Запрошен паспорт", en: "Passport requested" }, time: "14м", tag: { ru: "KYC", en: "KYC" } },
  { phase: "offer", who: "@sergey_b", dir: "USDT TRC20 → THB", amt: "฿49 800", note: { ru: "Курс 33.2 подтверждён", en: "Rate 33.2 confirmed" }, time: "3м", tag: { ru: "Курс", en: "Rate" } },
  { phase: "offer", who: "@anna_smm", dir: "ETH → THB", amt: "฿72 500", note: { ru: "Ждём подтверждения курса", en: "Awaiting rate confirm" }, time: "20м" },
  { phase: "pay", who: "@pavel_qr", dir: "USDT TRC20 → THB", amt: "฿16 600", note: { ru: "Прислал tx hash, проверяем", en: "Sent tx hash, verifying" }, time: "1м", tag: { ru: "Пруф", en: "Proof" } },
  { phase: "pay", who: "@maria_l", dir: "RUB Сбер → THB", amt: "฿12 900", note: { ru: "Ожидаем перевод на карту", en: "Awaiting card transfer" }, time: "6м" },
  { phase: "payout", who: "@nikita_d", dir: "USDT TRC20 → THB", amt: "฿24 300", note: { ru: "Оператор отправил ATM QR", en: "Operator sent ATM QR" }, time: "сейчас", tag: { ru: "QR", en: "QR" } },
  { phase: "done", who: "@elena_p", dir: "USDT TRC20 → THB", amt: "฿16 600", note: { ru: "THB снят в банкомате ✅", en: "THB withdrawn at ATM ✅" }, time: "1ч", tag: { ru: "Готово", en: "Won" } },
  { phase: "done", who: "@artem_g", dir: "RUB Тинькофф → THB", amt: "฿41 000", note: { ru: "Сделка закрыта ✅", en: "Deal closed ✅" }, time: "2ч", tag: { ru: "Готово", en: "Won" } },
];

const RATE_RUB: { amt: string; rate: string; dev: string }[] = [
  { amt: "до ฿10 000", rate: "2.60", dev: "−2.1%" },
  { amt: "฿10–30k", rate: "2.52", dev: "−1.4%" },
  { amt: "฿30–50k", rate: "2.48", dev: "−0.9%" },
  { amt: "฿50–100k", rate: "2.45", dev: "−0.5%" },
  { amt: "฿100k+", rate: "2.43", dev: "рынок" },
];
const RATE_USDT: { amt: string; rate: string; dev: string }[] = [
  { amt: "до $500", rate: "31.4", dev: "−0.9%" },
  { amt: "$500–2 000", rate: "31.5", dev: "−0.6%" },
  { amt: "$2 000+", rate: "31.7", dev: "рынок" },
];

const REQS: { label: L; value: string; sub: L; mono?: boolean }[] = [
  { label: { ru: "USDT · TRC20", en: "USDT · TRC20" }, value: "TJ9k…q4Fq2Xb", sub: { ru: "Приём крипты", en: "Crypto inbound" }, mono: true },
  { label: { ru: "Сбербанк", en: "Sberbank" }, value: "2202 20•• •••• 7741", sub: { ru: "Иван И. · приём ₽", en: "Ivan I. · ₽ inbound" }, mono: true },
  { label: { ru: "Тинькофф", en: "Tinkoff" }, value: "5536 91•• •••• 0418", sub: { ru: "Иван И. · приём ₽", en: "Ivan I. · ₽ inbound" }, mono: true },
  { label: { ru: "Bangkok Bank", en: "Bangkok Bank" }, value: "Cardless QR", sub: { ru: "Выдача THB наличными", en: "THB cash payout" } },
];

const TG_MESSAGES = [
  { from: "user" as const, text: "Хочу обменять 500 USDT на THB" },
  { from: "bot" as const, text: "Отлично! Какая сеть? TRC20, ERC20 или BEP20?" },
  { from: "user" as const, text: "TRC20" },
  { from: "bot" as const, text: "Курс сегодня: 1 USDT = 33.2 THB. Итого 16 600 THB. Подтверждаете?" },
  { from: "user" as const, text: "Да, подтверждаю" },
  { from: "bot" as const, text: "Переводите 500 USDT на адрес: TJ9k…q4Fq2Xb 👇", cta: true },
];

export default function DemoExchange() {
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

      {/* KPIs */}
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

      {/* Lead board */}
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

      {/* Live dialog */}
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
              notify="🔔 Оплата подтверждена — оператор отправляет QR для ATM"
              botName="ExchangeBot"
              ctaLabel="📋 Реквизиты для перевода →"
            />
          </div>
        </div>
      </section>

      {/* Rate card */}
      <section className="section section-alt">
        <div className="container">
          <div className="section-label">{c.rateLabel}</div>
          <h2 className="section-title">{c.rateTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>{c.rateSub}</p>
          <div className="demo-rates">
            {([
              { pair: "RUB → THB", unit: "₽ за 1 ฿", rows: RATE_RUB },
              { pair: "USDT → THB", unit: "฿ за 1 USDT", rows: RATE_USDT },
            ] as const).map((tbl) => (
              <div key={tbl.pair} className="demo-rate">
                <div className="demo-rate-head">
                  <span className="demo-rate-pair">{tbl.pair}</span>
                  <span className="demo-rate-unit">{tbl.unit}</span>
                </div>
                <table className="demo-rate-table">
                  <thead>
                    <tr>
                      <th>{c.rateAmt}</th>
                      <th>{c.rateRate}</th>
                      <th>{c.rateDev}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tbl.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.amt}</td>
                        <td className="demo-rate-val">{r.rate}</td>
                        <td className="demo-rate-dev">{r.dev}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Requisites */}
      <section className="section">
        <div className="container">
          <div className="section-label">{c.reqLabel}</div>
          <h2 className="section-title">{c.reqTitle}</h2>
          <p className="section-sub" style={{ marginBottom: 28 }}>{c.reqSub}</p>
          <div className="demo-reqs">
            {REQS.map((r, i) => (
              <div key={i} className="demo-req">
                <div className="demo-req-label">{t(r.label, lang)}</div>
                <div className={`demo-req-value${r.mono ? " demo-mono" : ""}`}>{r.value}</div>
                <div className="demo-req-sub">{t(r.sub, lang)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
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
