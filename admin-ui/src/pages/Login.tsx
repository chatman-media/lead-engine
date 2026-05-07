import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ws } from "../App.tsx";
import { api } from "../api.ts";

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
    <div className="login-wrap">
      <div className="login-card fade-in">
        <div className="login-logo">
          <div className="login-logo-name">tg-chatbot</div>
          <div className="login-logo-sub">Admin access only</div>
        </div>

        <form onSubmit={handleSubmit} noValidate data-testid="login-form">
          <div className="field">
            <label className="field-label" htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoComplete="email"
              data-testid="email"
              className="input"
            />
          </div>

          <div className="field" style={{ marginBottom: 24 }}>
            <label className="field-label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              data-testid="password"
              className="input"
            />
          </div>

          {error && (
            <div className="error-box" data-testid="login-error">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            data-testid="login-submit"
            className="btn btn-primary btn-block"
            style={{ padding: "10px 0" }}
          >
            {loading ? "signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
