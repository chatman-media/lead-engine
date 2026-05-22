import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, saas, setToken } from "../api/saas.ts";

/**
 * /accept-invite?token=<opaque> — публичная страница приглашённого админа:
 * берёт token из query, спрашивает пароль, accept-invite, redirect на /dashboard.
 */
export function SaasAcceptInvite() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) setError("Token отсутствует в URL");
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
          setError(
            err.errorCode === "invite expired"
              ? "Приглашение истекло. Попросите коллегу прислать новое."
              : "Token недействителен",
          );
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
    <AuthLayout
      title="Принять приглашение"
      subtitle="Создайте пароль для входа. Email и роль установлены приглашающим."
      footer={
        <>
          Уже зарегистрированы?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Войти
          </Link>
        </>
      }
    >
      {!token ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Token не найден в URL. Откройте ссылку из приглашения целиком.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">Пароль (≥ 8 символов)</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              minLength={8}
              required
              // biome-ignore lint/a11y/noAutofocus: единственное поле формы
              autoFocus
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Принимаем…" : "Принять и войти"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
