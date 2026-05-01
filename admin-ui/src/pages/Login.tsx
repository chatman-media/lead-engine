import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { ws } from "../App.tsx";

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError("Fill in both fields.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.login(email, password);
      ws.connect();
      navigate("/admin/chats", { replace: true });
    } catch {
      setError("Invalid credentials.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <div
        className="fade-in"
        style={{
          width: 360,
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "40px 36px",
        }}
      >
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontWeight: 600,
              fontSize: 15,
              color: "var(--amber)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            tg-chatbot
          </div>
          <div style={{ color: "var(--text-3)", fontSize: 13 }}>
            Admin access only
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate data-testid="login-form">
          <label style={labelStyle}>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoComplete="email"
              data-testid="email"
              style={inputStyle}
            />
          </label>

          <label style={{ ...labelStyle, marginBottom: 24 }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              data-testid="password"
              style={inputStyle}
            />
          </label>

          {error && (
            <div
              data-testid="login-error"
              style={{
                marginBottom: 16,
                padding: "8px 12px",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: "var(--radius)",
                color: "var(--red)",
                fontSize: 12,
                fontFamily: "var(--mono)",
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            data-testid="login-submit"
            style={{
              width: "100%",
              padding: "10px 0",
              background: loading ? "var(--bg-3)" : "var(--amber)",
              color: loading ? "var(--text-3)" : "#000",
              border: "none",
              borderRadius: "var(--radius)",
              fontWeight: 600,
              fontSize: 13,
              fontFamily: "var(--mono)",
              letterSpacing: "0.05em",
              transition: "background 0.15s",
            }}
          >
            {loading ? "signing in…" : "SIGN IN"}
          </button>
        </form>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  color: "var(--text-2)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontFamily: "var(--mono)",
  marginBottom: 16,
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "9px 12px",
  color: "var(--text)",
  width: "100%",
  outline: "none",
  transition: "border-color 0.15s",
};
