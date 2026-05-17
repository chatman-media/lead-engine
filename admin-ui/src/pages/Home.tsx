import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, type SystemStatus } from "../api.ts";

/**
 * Главная — дружелюбная точка входа для заказчика. Один запрос к
 * GET /admin/api/status даёт всё: здоровье бота, очередь чатов, сводку
 * лидов по этапам и счётчики для плиток-ссылок.
 */
export function Home() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return (
      <div style={{ padding: 40, color: "var(--red)", fontFamily: "var(--mono)" }}>
        Не удалось загрузить данные: {error}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="loading-text" style={{ padding: 40 }}>
        загрузка…
      </div>
    );
  }

  const leads = status.leads.by_state;
  const totalLeads = Object.values(leads).reduce((a, b) => a + b, 0);
  const queued = status.conversations.by_mode.queued ?? 0;
  const botOk = status.bot_health.ok;

  const pills = [
    {
      ok: botOk,
      color: botOk ? "var(--green)" : "var(--red)",
      text: botOk ? (
        <>
          <b>Бот работает</b> — отвечает кандидатам
        </>
      ) : (
        <>
          <b>Бот не отвечает</b> — нужна проверка
        </>
      ),
    },
    {
      color: queued > 0 ? "var(--amber)" : "var(--green)",
      text:
        queued > 0 ? (
          <>
            <b>{queued}</b> {plural(queued, "чат ждёт", "чата ждут", "чатов ждут")} оператора
          </>
        ) : (
          <>Все чаты обработаны</>
        ),
    },
    {
      color: leads.intake_complete > 0 ? "var(--amber)" : "var(--green)",
      text:
        leads.intake_complete > 0 ? (
          <>
            <b>{leads.intake_complete}</b>{" "}
            {plural(leads.intake_complete, "лид готов", "лида готовы", "лидов готовы")} к проверке
          </>
        ) : (
          <>Нет лидов в ожидании проверки</>
        ),
    },
  ];

  const funnel = [
    { label: "Новые заявки", value: leads.intake_pending, accent: leads.intake_pending > 0 },
    {
      label: "На проверке",
      value: leads.intake_complete + leads.partner_review,
      accent: leads.intake_complete > 0,
    },
    { label: "Оформление документов", value: leads.approved + leads.docs_pending, accent: false },
    { label: "Готовы к подаче", value: leads.docs_complete, accent: leads.docs_complete > 0 },
    { label: "Поданы", value: leads.submitted + leads.ready_to_work, accent: false },
    { label: "Закрыты", value: leads.rejected + leads.closed, accent: false },
  ];

  const tiles = [
    {
      to: "/admin/leads",
      name: "Лиды",
      count: totalLeads,
      desc: "Заявки кандидатов и их продвижение по этапам.",
    },
    {
      to: "/admin/chats",
      name: "Чаты",
      count: status.conversations.total,
      desc: "Переписки с кандидатами и подключение оператора.",
    },
    {
      to: "/admin/users",
      name: "Пользователи",
      count: status.users.total,
      desc: "Все контакты, с которыми общался бот.",
    },
    {
      to: "/admin/vacancies",
      name: "Вакансии",
      count: status.vacancies.active,
      desc: "Активные вакансии, которые предлагает бот.",
    },
    {
      to: "/admin/kb",
      name: "База знаний",
      count: status.kb.documents,
      desc: "Документы, по которым бот формирует ответы.",
    },
    {
      to: "/admin/analytics",
      name: "Аналитика",
      count: null,
      desc: "Метрики работы бота и воронка заявок.",
    },
  ];

  return (
    <div className="home fade-in">
      <div>
        <div className="home-hero-title">Infinity Agency</div>
        <div className="home-hero-sub">
          Панель управления — обзор работы бота и заявок кандидатов.
        </div>
      </div>

      <div>
        <div className="home-section-label">Состояние системы</div>
        <div className="home-pills">
          {pills.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: фиксированный список из 3 пилюль
            <div key={i} className="stat-pill">
              <span className="stat-pill-dot" style={{ background: p.color }} />
              <span className="stat-pill-text">{p.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="home-section-label">Лиды по этапам · всего {totalLeads}</div>
        <div className="home-funnel">
          {funnel.map((f) => (
            <div key={f.label} className="funnel-card">
              <div className={`funnel-card-num${f.accent ? " accent" : ""}`}>{f.value}</div>
              <div className="funnel-card-label">{f.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="home-section-label">Разделы</div>
        <div className="home-tiles">
          {tiles.map((t) => (
            <NavLink key={t.to} to={t.to} className="home-tile">
              <div className="home-tile-head">
                <span className="home-tile-name">{t.name}</span>
                <span className="home-tile-count">{t.count === null ? "→" : t.count}</span>
              </div>
              <div className="home-tile-desc">{t.desc}</div>
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Русское склонение: 1 чат, 2 чата, 5 чатов. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
