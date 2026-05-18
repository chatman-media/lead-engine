import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ws } from "../App.tsx";
import { type Admin, api } from "../api.ts";
import { useTabVisibility } from "../useTabVisibility.ts";
import { ThemeToggle } from "./ThemeToggle.tsx";

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

interface LayoutProps {
  admin: Admin;
  children: React.ReactNode;
}

export function Layout({ admin, children }: LayoutProps) {
  const navigate = useNavigate();
  const [queuedCount, setQueuedCount] = useState(0);
  const [pendingKbCount, setPendingKbCount] = useState(0);
  // Conversation ids currently in the queue, as last observed. A new id
  // appearing here means a chat just escalated and needs an operator.
  const knownQueuedRef = useRef<Set<number>>(new Set());
  const seededRef = useRef(false);

  useEffect(() => {
    // Initial fetch of the pending-questions count.
    api
      .kbSuggestionCounts()
      .then((c) => setPendingKbCount(c.pending))
      .catch(() => {});

    // Queued-chat watcher: keeps the sidebar badge fresh and, when a chat
    // newly escalates into the queue, pulls the operator to the chats list
    // with the fresh one flagged for a transient highlight (see Chats.tsx).
    const checkQueued = async () => {
      let result: Awaited<ReturnType<typeof api.conversations>>;
      try {
        result = await api.conversations();
      } catch {
        return;
      }
      const queuedIds = result.conversations.filter((c) => c.mode === "queued").map((c) => c.id);
      setQueuedCount(queuedIds.length);
      if (!seededRef.current) {
        knownQueuedRef.current = new Set(queuedIds);
        seededRef.current = true;
        return;
      }
      const fresh = queuedIds.filter((id) => !knownQueuedRef.current.has(id));
      knownQueuedRef.current = new Set(queuedIds);
      if (fresh.length > 0) {
        navigate("/admin/chats", {
          state: { highlightConvId: fresh[fresh.length - 1], ts: Date.now() },
        });
      }
    };
    checkQueued();

    // Re-check on escalation events and on a slow poll. The poll is the
    // fallback for userbot-channel escalations whose WS events may not
    // reach this client.
    const poll = setInterval(checkQueued, 20_000);
    const unsub = ws.on((evt) => {
      if (evt.type === "conversation:updated" || evt.type === "queued:count") {
        checkQueued();
      }
      if (evt.type === "kb-suggestion:created") {
        setPendingKbCount((n) => n + 1);
      }
    });
    return () => {
      clearInterval(poll);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogout() {
    await api.logout().catch(() => {});
    navigate("/admin/login", { replace: true });
  }

  const { visible } = useTabVisibility();

  const allNavItems = [
    { to: "/admin", label: "Главная", key: null, end: true },
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
      label: "Вопросы без ответа",
      key: "kb-suggestions",
      badge: pendingKbCount > 0 ? pendingKbCount : undefined,
    },
    { to: "/admin/self-play", label: "Симуляция диалогов", key: "self-play" },
    { to: "/admin/operators", label: "Операторы", key: null, superadmin: true },
    { to: "/admin/ops", label: "Операции", key: null, superadmin: true },
  ];

  const navItems = allNavItems.filter(
    (item) =>
      (item.key === null || visible(item.key)) &&
      // Superadmin-only items (destructive ops) are hidden from managers.
      (!("superadmin" in item) || admin.role === "superadmin"),
  );

  return (
    <div className="layout">
      <div className="account-email">{admin.email}</div>
      <NavLink
        to="/admin/settings"
        className="settings-fab"
        title="Настройки"
        aria-label="Настройки"
      >
        <GearIcon />
      </NavLink>
      <ThemeToggle />

      <aside className="sidebar">
        <nav className="sidebar-nav">
          {navItems.map(({ to, label, badge, end }) => (
            <NavLink key={to} to={to} end={end} className="nav-item">
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
          <button className="btn btn-sm btn-block btn-logout" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: "auto", background: "var(--bg)", paddingTop: 56 }}>
        {children}
      </main>
    </div>
  );
}
