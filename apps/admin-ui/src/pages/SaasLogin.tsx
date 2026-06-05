import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { ApiError, saas, setToken } from "../api/saas.ts";

export function SaasLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Заполните email и пароль.");
      return;
    }
    setLoading(true);
    try {
      const res = await saas.login(email, password);
      setToken(res.token);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setError("Неверный email или пароль.");
        else setError(`Ошибка: ${err.errorCode}`);
      } else {
        setError("Сеть недоступна. Попробуйте позже.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="С возвращением"
      subtitle="Войдите в панель управления ассистентом"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            required
            // biome-ignore lint/a11y/noAutofocus: первичное поле формы входа
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Пароль</Label>
            <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-primary hover:underline">
              Забыли пароль?
            </Link>
          </div>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </div>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Входим…" : "Войти"}
        </Button>
      </form>
    </AuthLayout>
  );
}
