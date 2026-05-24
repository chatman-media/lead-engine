import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { ApiError, saas } from "../api/saas.ts";

export function SaasResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) setError("Ссылка недействительна. Запросите сброс заново.");
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Пароль должен содержать минимум 8 символов.");
      return;
    }
    if (password !== confirm) {
      setError("Пароли не совпадают.");
      return;
    }
    setLoading(true);
    try {
      await saas.resetPassword(token, password);
      navigate("/login?reset=1", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setError("Ссылка устарела или уже использована. Запросите новую.");
        else setError(`Ошибка: ${err.errorCode}`);
      } else {
        setError("Что-то пошло не так. Попробуйте позже.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Новый пароль"
      subtitle="Придумайте надёжный пароль для вашего аккаунта"
      footer={
        <Link to="/login" className="font-medium text-primary hover:underline">
          Назад ко входу
        </Link>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">Новый пароль</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Минимум 8 символов"
            required
            disabled={!token}
            // biome-ignore lint/a11y/noAutofocus: первичное поле формы
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Повторите пароль</Label>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Повторите пароль"
            required
            disabled={!token}
          />
        </div>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={loading || !token}>
          {loading ? "Сохраняем…" : "Установить пароль"}
        </Button>
      </form>
    </AuthLayout>
  );
}
