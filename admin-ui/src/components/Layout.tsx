import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ws } from "../App.tsx";
import { type Admin, api } from "../api.ts";

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

  const navItems = [
    { to: "/admin/status", label: "Status" },
    { to: "/admin/analytics", label: "Analytics" },
    { to: "/admin/chats", label: "Chats", badge: queuedCount > 0 ? queuedCount : undefined },
    { to: "/admin/leads", label: "Leads" },
    { to: "/admin/users", label: "Users" },
    { to: "/admin/vacancies", label: "Vacancies" },
    { to: "/admin/kb", label: "Knowledge base" },
    {
      to: "/admin/kb-suggestions",
      label: "KB Suggestions",
      badge: pendingKbCount > 0 ? pendingKbCount : undefined,
    },
    { to: "/admin/styles", label: "Sales styles" },
    { to: "/admin/skills", label: "Skills" },
    { to: "/admin/self-play", label: "Self-play" },
    {
      to: "/admin/coach",
      label: "Coach",
      badge: pendingCoachCount > 0 ? pendingCoachCount : undefined,
    },
  ];

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
          <div className="sidebar-email">{admin.email}</div>
          <button className="btn btn-ghost btn-sm btn-block" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: "auto", background: "var(--bg)" }}>{children}</main>
    </div>
  );
}
