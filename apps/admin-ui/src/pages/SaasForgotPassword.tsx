import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saas } from "../api/saas.ts";

export function SaasForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await saas.forgotPassword(email.trim().toLowerCase());
      setSent(true);
    } catch {
      setError("Что-то пошло не так. Попробуйте позже.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      title="Восстановление пароля"
      subtitle="Введите email — пришлём ссылку для сброса"
      footer={
        <Link to="/login" className="font-medium text-primary hover:underline">
          Назад ко входу
        </Link>
      }
    >
      {sent ? (
        <div className="rounded-md border border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          Если аккаунт с этим email существует — письмо уже отправлено. Проверьте почту.
        </div>
      ) : (
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
              // biome-ignore lint/a11y/noAutofocus: первичное поле формы
              autoFocus
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Отправляем…" : "Отправить ссылку"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
