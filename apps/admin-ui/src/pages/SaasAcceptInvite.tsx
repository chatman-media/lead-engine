import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, saas, setToken } from "../api/saas.ts";

/**
 * /accept-invite?token=<opaque> — public страница для приглашённого admin'а.
 * Берёт token из query, спрашивает пароль, дёргает POST /api/auth/accept-invite,
 * сохраняет session token, redirects на /dashboard.
 */
export function SaasAcceptInvite() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("Token отсутствует в URL");
    }
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!token) return;
    if (password.length < 8) {
      setError("Пароль должен быть не короче 8 символов");
      return;
    }
    setSubmitting(true);
    try {
      const res = await saas.acceptInvite(token, password);
      setToken(res.token);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          if (err.errorCode === "invite expired") {
            setError("Приглашение истекло. Попросите коллегу прислать новое.");
          } else {
            setError("Token недействителен");
          }
        } else if (err.status === 409) {
          setError("Этот email уже зарегистрирован в команде. Войдите через /login.");
        } else if (err.status === 400) {
          setError(`Ошибка: ${err.errorCode}`);
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Принять приглашение</h1>
        <p className="auth-sub">
          Создайте пароль для входа. Email и роль установлены приглашающим.
        </p>
        {!token ? (
          <div className="auth-error">
            Token не найден в URL. Откройте ссылку из приглашения целиком.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <label>
              Пароль (≥ 8 символов)
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                autoFocus
              />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" disabled={submitting}>
              {submitting ? "Принимаем…" : "Принять и войти"}
            </button>
          </form>
        )}
        <p className="auth-alt">
          Уже зарегистрированы? <Link to="/login">Войти</Link>
        </p>
      </div>
    </div>
  );
}
