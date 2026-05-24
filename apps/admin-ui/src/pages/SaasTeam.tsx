import { AlertTriangleIcon, CheckIcon, CopyIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AdminRow,
  ApiError,
  type CreateInviteResult,
  clearToken,
  type InviteRow,
  saas,
} from "../api/saas.ts";

export function SaasTeam() {
  const navigate = useNavigate();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"manager" | "superadmin">("manager");
  const [submitting, setSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreateInviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<number | null>(null);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refresh() {
    try {
      const [adminsRes, invitesRes] = await Promise.all([saas.listAdmins(), saas.listInvites()]);
      setAdmins(adminsRes.items);
      setInvites(invitesRes.items);
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once
  }, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLastCreated(null);
    if (!email.trim()) {
      setError("Email обязателен");
      return;
    }
    setSubmitting(true);
    try {
      const res = await saas.inviteAdmin({ email: email.trim().toLowerCase(), role });
      setLastCreated(res);
      setEmail("");
      await refresh();
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err instanceof ApiError) {
        if (err.status === 403) setError("Только superadmin может приглашать");
        else if (err.status === 409) setError("Admin с этим email уже существует");
        else setError(`Ошибка ${err.status}: ${err.errorCode}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: number) {
    setConfirmRevokeId(null);
    try {
      await saas.revokeInvite(id);
      await refresh();
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyShareUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard может быть недоступен
    }
  }

  if (loading) return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="rounded-lg border p-6 space-y-3">
        <Skeleton className="h-5 w-40" />
        <div className="flex gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border p-4 space-y-3">
            <Skeleton className="h-5 w-32" />
            {[0, 1, 2].map((j) => (
              <div key={j} className="flex justify-between items-center py-2">
                <div className="space-y-1">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Команда"
        description="Управление администраторами и приглашениями коллег."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Пригласить коллегу</CardTitle>
          <p className="text-sm text-muted-foreground">
            Email-доставка пока не автоматизирована — создайте приглашение и отправьте ссылку
            коллеге (Telegram / WhatsApp / email).
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                required
              />
            </div>
            <div className="space-y-1.5 sm:w-56">
              <Label>Роль</Label>
              <Select value={role} onValueChange={(v) => setRole(v as "manager" | "superadmin")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manager">Manager — повседневный</SelectItem>
                  <SelectItem value="superadmin">Superadmin — полный</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={submitting || !email.trim()}>
              {submitting ? "Создаём…" : "Пригласить"}
            </Button>
          </form>

          {lastCreated?.shareUrl && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium">Ссылка-приглашение для {lastCreated.email}</p>
              <p className="text-xs text-muted-foreground">Действует 7 дней.</p>
              <pre className="overflow-x-auto rounded-md bg-background p-3 font-mono text-xs">
                {lastCreated.shareUrl}
              </pre>
              <Button
                variant="outline"
                size="sm"
                onClick={() => lastCreated.shareUrl && copyShareUrl(lastCreated.shareUrl)}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Скопировано" : "Копировать"}
              </Button>
            </div>
          )}
          {lastCreated && !lastCreated.shareUrl && (
            <p className="rounded-md border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
              ⚠ PLATFORM_PUBLIC_URL не настроен. Token:{" "}
              <code className="font-mono">{lastCreated.token}</code>
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Администраторы</CardTitle>
            <Badge variant="secondary">{admins.length}</Badge>
          </CardHeader>
          <CardContent>
            {admins.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Никого нет</p>
            ) : (
              <ul className="divide-y">
                {admins.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.email}</p>
                      <p className="text-xs text-muted-foreground">
                        добавлен {new Date(a.createdAt * 1000).toLocaleDateString("ru")}
                      </p>
                    </div>
                    <Badge variant={a.role === "superadmin" ? "default" : "secondary"}>
                      {a.role}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Приглашения</CardTitle>
            <Badge variant="secondary">{invites.length}</Badge>
          </CardHeader>
          <CardContent>
            {invites.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Нет приглашений</p>
            ) : (
              <ul className="divide-y">
                {invites.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{inv.email}</p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Badge variant="outline">{inv.role}</Badge>
                        {inv.status === "pending" && <Badge variant="warning">ожидает</Badge>}
                        {inv.status === "accepted" && <Badge variant="success">принято</Badge>}
                        {inv.status === "expired" && <Badge variant="secondary">истёк</Badge>}
                      </div>
                    </div>
                    {inv.status === "pending" && (
                      confirmRevokeId === inv.id ? (
                        <div className="flex items-center gap-1 text-sm">
                          <AlertTriangleIcon className="size-3.5 text-warning" />
                          <Button size="sm" variant="destructive" onClick={() => handleRevoke(inv.id)}>
                            Да
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRevokeId(null)}>
                            Нет
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmRevokeId(inv.id)}
                        >
                          Отозвать
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
