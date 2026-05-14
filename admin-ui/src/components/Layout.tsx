import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ws } from "../App.tsx";
import { type Admin, api } from "../api.ts";
import { useTabVisibility } from "../useTabVisibility.ts";

interface LayoutProps {
  admin: Admin;
  children: React.ReactNode;
}

export function Layout({ admin, children }: LayoutProps) {
  const navigate = useNavigate();
  const [queuedCount, setQueuedCount] = useState(0);
  const [pendingKbCount, setPendingKbCount] = useState(0);
  const [pendingCoachCount, setPendingCoachCount] = useState(0);

  useEffect(() => {
    // Initial fetch of both counts.
    api
      .kbSuggestionCounts()
      .then((c) => setPendingKbCount(c.pending))
      .catch(() => {});
    api
      .coachProposals({ status: "pending", limit: 1 })
      .then((c) => setPendingCoachCount(c.pending_count))
      .catch(() => {});
    api
      .conversations()
      .then(({ conversations }) => {
        setQueuedCount(conversations.filter((c) => c.mode === "queued").length);
      })
      .catch(() => {});

    // Subscribe to real-time updates.
    const unsub = ws.on((evt) => {
      if (evt.type === "queued:count") {
        setQueuedCount(evt.count);
      }
      if (evt.type === "kb-suggestion:created") {
        setPendingKbCount((n) => n + 1);
      }
    });
    return unsub;
  }, []);

  async function handleLogout() {
    await api.logout().catch(() => {});
    navigate("/admin/login", { replace: true });
  }

  const { visible } = useTabVisibility();

  const allNavItems = [
    { to: "/admin/status", label: "Статус", key: null },
    { to: "/admin/analytics", label: "Аналитика", key: "analytics" },
    {
      to: "/admin/chats",
      label: "Чаты",
      key: null,
      badge: queuedCount > 0 ? queuedCount : undefined,
    },
    { to: "/admin/leads", label: "Лиды", key: null },
    { to: "/admin/users", label: "Пользователи", key: null },
    { to: "/admin/vacancies", label: "Вакансии", key: "vacancies" },
    { to: "/admin/kb", label: "База знаний", key: null },
    {
      to: "/admin/kb-suggestions",
      label: "Предложения в KB",
      key: "kb-suggestions",
      badge: pendingKbCount > 0 ? pendingKbCount : undefined,
    },
    { to: "/admin/styles", label: "Стили продаж", key: "styles" },
    { to: "/admin/skills", label: "Навыки", key: "skills" },
    { to: "/admin/self-play", label: "Self-play", key: "self-play" },
    {
      to: "/admin/coach",
      label: "Coach",
      key: "coach",
      badge: pendingCoachCount > 0 ? pendingCoachCount : undefined,
    },
  ];

  const navItems = allNavItems.filter(({ key }) => key === null || visible(key));

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">tg-chatbot</div>
          <div className="sidebar-tagline">admin panel</div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(({ to, label, badge }) => (
            <NavLink key={to} to={to} className="nav-item">
              <span>{label}</span>
              {badge !== undefined && (
                <span
                  style={{
                    marginLeft: "auto",
                    background: "var(--red, #ef4444)",
                    color: "#fff",
                    borderRadius: "10px",
                    fontSize: "11px",
                    fontWeight: 700,
                    padding: "1px 6px",
                    lineHeight: "16px",
                    minWidth: "18px",
                    textAlign: "center",
                  }}
                >
                  {badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <NavLink to="/admin/settings" className="nav-item" style={{ marginBottom: 8 }}>
            <span>Настройки</span>
          </NavLink>
          <div className="sidebar-email">{admin.email}</div>
          <button className="btn btn-ghost btn-sm btn-block" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>{children}</main>
    </div>
  );
}
