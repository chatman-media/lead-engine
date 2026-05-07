import { NavLink, useNavigate } from "react-router-dom";
import type { Admin } from "../api.ts";
import { api } from "../api.ts";

interface LayoutProps {
  admin: Admin;
  children: React.ReactNode;
}

export function Layout({ admin, children }: LayoutProps) {
  const navigate = useNavigate();

  async function handleLogout() {
    await api.logout().catch(() => {});
    navigate("/admin/login", { replace: true });
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">tg-chatbot</div>
          <div className="sidebar-tagline">admin panel</div>
        </div>

        <nav className="sidebar-nav">
          {[
            { to: "/admin/status", label: "Status" },
            { to: "/admin/chats", label: "Chats" },
            { to: "/admin/leads", label: "Leads" },
            { to: "/admin/users", label: "Users" },
            { to: "/admin/vacancies", label: "Vacancies" },
            { to: "/admin/kb", label: "Knowledge base" },
            { to: "/admin/styles", label: "Sales styles" },
            { to: "/admin/experiments", label: "Experiments" },
          ].map(({ to, label }) => (
            <NavLink key={to} to={to} className="nav-item">
              {label}
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
