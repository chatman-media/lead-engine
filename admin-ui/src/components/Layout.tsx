import { useNavigate, NavLink } from "react-router-dom";
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
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <aside
        style={{
          width: "var(--sidebar)",
          flexShrink: 0,
          background: "var(--bg-1)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "0",
        }}
      >
        <div
          style={{
            padding: "20px 16px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 13,
              color: "var(--amber)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            tg-chatbot
          </div>
          <div
            style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4 }}
          >
            admin panel
          </div>
        </div>

        <nav style={{ flex: 1, padding: "12px 8px" }}>
          {[
            { to: "/admin/chats", label: "Chats" },
            { to: "/admin/users", label: "Users" },
            { to: "/admin/styles", label: "Sales styles" },
            { to: "/admin/experiments", label: "Experiments" },
          ].map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              style={({ isActive }) => ({
                display: "block",
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                marginBottom: 2,
                color: isActive ? "var(--text)" : "var(--text-2)",
                background: isActive ? "var(--bg-3)" : "transparent",
                fontWeight: isActive ? 500 : 400,
                transition: "all 0.1s",
              })}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
              marginBottom: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {admin.email}
          </div>
          <button
            onClick={handleLogout}
            style={{
              width: "100%",
              padding: "6px 0",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text-3)",
              fontSize: 12,
              transition: "all 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text)";
              e.currentTarget.style.borderColor = "var(--text-3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-3)";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg)",
        }}
      >
        {children}
      </main>
    </div>
  );
}
