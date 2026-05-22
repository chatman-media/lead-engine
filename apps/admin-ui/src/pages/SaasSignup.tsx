import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
        if (err.status === 409) setError("Email или slug уже занят.");
        else if (err.status === 400) setError(`Невалидные данные: ${err.errorCode}`);
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
      title="Создать аккаунт"
      subtitle="Своя база знаний + AI-ассистент. Без карты, free-план."
      footer={
        <>
          Уже есть аккаунт?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Войти
          </Link>
        </>
      }
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
            // biome-ignore lint/a11y/noAutofocus: первичное поле формы регистрации
            autoFocus
          />
        </div>
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
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">
            Slug аккаунта <span className="text-muted-foreground">(опционально)</span>
          </Label>
          <Input
            id="slug"
            type="text"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value.toLowerCase())}
            placeholder="сгенерим из email"
            pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]"
            title="Lowercase a-z 0-9 -, 3-32 символа"
          />
        </div>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Создаём…" : "Зарегистрироваться"}
        </Button>
      </form>
    </AuthLayout>
  );
}
