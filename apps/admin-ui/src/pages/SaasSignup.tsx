import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, saas, setToken } from "../api/saas.ts";

export function SaasSignup() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Заполните email и пароль.");
      return;
    }
    if (password.length < 8) {
      setError("Пароль должен быть не короче 8 символов.");
      return;
    }
    setLoading(true);
    try {
      const res = await saas.signup(email, password, tenantSlug || undefined);
      setToken(res.token);
      navigate("/onboarding", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setError("Email или slug уже занят.");
        } else if (err.status === 400) {
          setError(`Невалидные данные: ${err.errorCode}`);
        } else {
          setError(`Ошибка: ${err.errorCode}`);
        }
      } else {
        setError("Сеть недоступна. Попробуйте позже.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Создать аккаунт</h1>
        <p className="auth-sub">Своя база знаний + AI-ассистент. Без credit card. Free plan.</p>
        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            Пароль (≥ 8 символов)
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          <label>
            Slug аккаунта (опционально)
            <input
              type="text"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value.toLowerCase())}
              placeholder="оставьте пустым — сгенерим из email"
              pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]"
              title="Lowercase a-z 0-9 -, 3-32 символа"
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? "Создаём..." : "Зарегистрироваться"}
          </button>
        </form>
        <p className="auth-alt">
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </p>
      </div>
    </div>
  );
}
