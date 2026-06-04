import { KeyRoundIcon, SaveIcon, UserCircleIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Skeleton } from "@/components/ui/skeleton";
import { type Admin, ApiError, saas, type Tenant } from "../api/saas.ts";

export default function SaasProfile() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  // Профиль (имя)
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Смена пароля
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [savingPwd, setSavingPwd] = useState(false);
  const [pwdError, setPwdError] = useState("");

  useEffect(() => {
    let cancelled = false;
    saas
      .me()
      .then((res) => {
        if (cancelled) return;
        setAdmin(res.admin);
        setTenant(res.tenant);
        setName(res.admin.name ?? "");
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSaveName(e: FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      const res = await saas.updateProfile(name.trim());
      setAdmin(res.admin);
      setName(res.admin.name ?? "");
      toast.success("Профиль сохранён");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwdError("");
    if (newPwd.length < 8) {
      setPwdError("Новый пароль — не менее 8 символов");
      return;
    }
    setSavingPwd(true);
    try {
      await saas.changePassword(currentPwd, newPwd);
      toast.success("Пароль изменён");
      setCurrentPwd("");
      setNewPwd("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPwdError("Неверный текущий пароль");
        return;
      }
      setPwdError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPwd(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Профиль" description="Личные данные и безопасность аккаунта." />
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  const roleLabel = admin?.role === "superadmin" ? "Суперадмин" : "Менеджер";
  const nameUnchanged = name.trim() === (admin?.name ?? "");

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Профиль" description="Личные данные и безопасность аккаунта." />

      <div className="space-y-4">
        {/* Личные данные */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCircleIcon className="size-4 text-muted-foreground" /> Личные данные
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveName} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">Имя</Label>
                <Input
                  id="profile-name"
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Как к вам обращаться"
                />
                <p className="text-xs text-muted-foreground">
                  Отображается в кабинете. Бот при общении с клиентами это имя не использует.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>E-mail</Label>
                  <Input value={admin?.email ?? ""} readOnly disabled />
                </div>
                <div className="space-y-1.5">
                  <Label>Роль</Label>
                  <Input value={roleLabel} readOnly disabled />
                </div>
              </div>

              {tenant && (
                <div className="space-y-1.5">
                  <Label>Аккаунт</Label>
                  <Input value={tenant.slug} readOnly disabled />
                </div>
              )}

              <div className="flex justify-end">
                <Button type="submit" disabled={savingName || nameUnchanged}>
                  <SaveIcon /> {savingName ? "Сохраняем…" : "Сохранить"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Смена пароля */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4 text-muted-foreground" /> Сменить пароль
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pwdError && (
              <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {pwdError}
              </p>
            )}
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="cur-pwd">Текущий пароль</Label>
                <PasswordInput
                  id="cur-pwd"
                  autoComplete="current-password"
                  value={currentPwd}
                  onChange={(e) => setCurrentPwd(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pwd">Новый пароль (≥ 8 символов)</Label>
                <PasswordInput
                  id="new-pwd"
                  autoComplete="new-password"
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={savingPwd}>
                  <KeyRoundIcon /> {savingPwd ? "Сохраняем…" : "Изменить пароль"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
