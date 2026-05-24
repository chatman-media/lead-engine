/**
 * Платформенный superadmin дашборд.
 *
 * Доступ: отдельный Bearer-токен (PLATFORM_SUPERADMIN_TOKEN). Вводится
 * один раз — сохраняется в localStorage под ключом `sa_token`. Не связан
 * с обычной tenant-сессией.
 *
 * URL: /superadmin
 */
import { CheckIcon, RefreshCwIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

// ── Types ─────────────────────────────────────────────────────────────────

interface TenantItem {
  id: number;
  slug: string;
  plan: string;
  status: string;
  llmBillingMode: string;
  createdAt: number;
  adminCount: number;
  channelCount: number;
  stripeStatus: string | null;
}

interface Stats {
  totalTenants: number;
  newThisWeek: number;
  totalChannels: number;
  activeSubscriptions: number;
  byPlan: Record<string, number>;
}

// ── Token storage ─────────────────────────────────────────────────────────

const SA_TOKEN_KEY = "sa_token";

function getSaToken(): string {
  return localStorage.getItem(SA_TOKEN_KEY) ?? "";
}

function setSaToken(t: string) {
  if (t) localStorage.setItem(SA_TOKEN_KEY, t);
  else localStorage.removeItem(SA_TOKEN_KEY);
}

// ── API ───────────────────────────────────────────────────────────────────

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function saRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getSaToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString("ru", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const PLAN_COLORS: Record<string, string> = {
  free: "secondary",
  starter: "outline",
  pro: "default",
  enterprise: "destructive",
};

const STATUS_COLORS: Record<string, string> = {
  active: "default",
  suspended: "destructive",
  deleted: "secondary",
};

// ── Components ────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm text-muted-foreground mt-1">{label}</div>
      </CardContent>
    </Card>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  return (
    <Badge variant={(PLAN_COLORS[plan] ?? "outline") as "default" | "secondary" | "outline" | "destructive"}>
      {plan}
    </Badge>
  );
}

// ── Login form ────────────────────────────────────────────────────────────

function TokenForm({ onToken }: { onToken: (t: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlertIcon className="h-5 w-5 text-destructive" />
            <CardTitle>Superadmin доступ</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Введите платформенный токен (PLATFORM_SUPERADMIN_TOKEN).
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (val.trim()) onToken(val.trim());
            }}
            className="space-y-3"
          >
            <Input
              type="password"
              placeholder="Токен..."
              value={val}
              onChange={(e) => setVal(e.target.value)}
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={!val.trim()}>
              Войти
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Plan editor ───────────────────────────────────────────────────────────

function PlanEditor({
  tenant,
  onSave,
}: {
  tenant: TenantItem;
  onSave: (id: number, plan: string, status: string) => Promise<void>;
}) {
  const [plan, setPlan] = useState(tenant.plan);
  const [status, setStatus] = useState(tenant.status);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave(tenant.id, plan, status);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={plan} onValueChange={setPlan}>
        <SelectTrigger className="w-28 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {["free", "starter", "pro", "enterprise"].map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-28 h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {["active", "suspended"].map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs"
        onClick={save}
        disabled={saving || (plan === tenant.plan && status === tenant.status)}
      >
        {saved ? <CheckIcon className="h-3 w-3 text-green-500" /> : "Сохранить"}
      </Button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function SaasSuperadmin() {
  const [token, setToken] = useState(getSaToken());
  const [stats, setStats] = useState<Stats | null>(null);
  const [tenants, setTenants] = useState<TenantItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  function handleToken(t: string) {
    setSaToken(t);
    setToken(t);
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [statsRes, tenantsRes] = await Promise.all([
        saRequest<Stats>("/api/superadmin/stats"),
        saRequest<{ items: TenantItem[]; total: number }>("/api/superadmin/tenants?limit=100"),
      ]);
      setStats(statsRes);
      setTenants(tenantsRes.items);
      setTotal(tenantsRes.total);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
        setSaToken("");
        setToken("");
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) load();
  }, [token]);

  async function updateTenant(id: number, plan: string, status: string) {
    await saRequest(`/api/superadmin/tenants/${id}/plan`, {
      method: "PATCH",
      body: JSON.stringify({ plan, status }),
    });
    setTenants((prev) =>
      prev.map((t) => (t.id === id ? { ...t, plan, status } : t)),
    );
  }

  if (!token) return <TokenForm onToken={handleToken} />;

  const filtered = search.trim()
    ? tenants.filter(
        (t) =>
          t.slug.includes(search.toLowerCase()) ||
          t.plan.includes(search.toLowerCase()),
      )
    : tenants;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Superadmin"
        description="Платформенный операторский дашборд"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCwIcon className="h-4 w-4 mr-1" />
              Обновить
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSaToken("");
                setToken("");
              }}
            >
              <XIcon className="h-4 w-4 mr-1" />
              Выйти
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {/* Stats */}
      {loading && !stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Всего тенантов" value={stats.totalTenants} />
          <StatCard label="Новые за 7 дней" value={stats.newThisWeek} />
          <StatCard label="Каналов" value={stats.totalChannels} />
          <StatCard label="Активных подписок" value={stats.activeSubscriptions} />
        </div>
      ) : null}

      {/* Plan breakdown */}
      {stats && (
        <div className="flex gap-2 flex-wrap">
          {Object.entries(stats.byPlan).map(([plan, cnt]) => (
            <Badge key={plan} variant={(PLAN_COLORS[plan] ?? "outline") as "default" | "secondary" | "outline" | "destructive"}>
              {plan}: {cnt}
            </Badge>
          ))}
        </div>
      )}

      {/* Tenants table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Тенанты ({total})</CardTitle>
            <Input
              placeholder="Поиск по slug / плану..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 h-8 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading && !tenants.length ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground text-xs">
                    <th className="px-4 py-2 text-left font-medium">ID</th>
                    <th className="px-4 py-2 text-left font-medium">Slug</th>
                    <th className="px-4 py-2 text-left font-medium">План / Статус</th>
                    <th className="px-4 py-2 text-left font-medium">Stripe</th>
                    <th className="px-4 py-2 text-left font-medium">Admins</th>
                    <th className="px-4 py-2 text-left font-medium">Каналы</th>
                    <th className="px-4 py-2 text-left font-medium">Создан</th>
                    <th className="px-4 py-2 text-left font-medium">Изменить</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2 text-muted-foreground font-mono">{t.id}</td>
                      <td className="px-4 py-2 font-medium">{t.slug}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1">
                          <PlanBadge plan={t.plan} />
                          {t.status !== "active" && (
                            <Badge
                              variant={(STATUS_COLORS[t.status] ?? "secondary") as "default" | "secondary" | "outline" | "destructive"}
                              className="text-xs"
                            >
                              {t.status}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground text-xs">
                        {t.stripeStatus ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-center">{t.adminCount}</td>
                      <td className="px-4 py-2 text-center">{t.channelCount}</td>
                      <td className="px-4 py-2 text-muted-foreground text-xs">{fmtDate(t.createdAt)}</td>
                      <td className="px-4 py-2">
                        <PlanEditor tenant={t} onSave={updateTenant} />
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                        Тенантов не найдено
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
