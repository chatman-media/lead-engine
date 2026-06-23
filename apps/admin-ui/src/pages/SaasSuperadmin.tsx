import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  UserPlusIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, type EarlyAccessRequest, type TenantRow, saas } from "../api/saas.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro" };
const PLANS = ["free", "starter", "pro"] as const;

function fmtDate(epoch: number | null) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function fmtDateTime(epoch: number | null) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AlphaStatus({ item }: { item: EarlyAccessRequest }) {
  if (item.inviteUsedAt) {
    return (
      <Badge variant="success">
        <CheckCircle2Icon />
        accepted
      </Badge>
    );
  }
  if (item.status === "approved") return <Badge variant="default">approved</Badge>;
  if (item.status === "new") return <Badge variant="warning">new</Badge>;
  return <Badge variant="outline">{item.status}</Badge>;
}

export function SaasSuperadmin() {
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [alpha, setAlpha] = useState<EarlyAccessRequest[] | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState<number | null>(null);
  const [approving, setApproving] = useState<number | null>(null);

  async function loadData() {
    try {
      const [tenantRows, alphaRows] = await Promise.all([
        saas.listAllTenants(),
        saas.listEarlyAccessRequests(),
      ]);
      setTenants(tenantRows.items);
      setAlpha(alphaRows.items);
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Нет доступа");
      } else {
        setError("Не удалось загрузить superadmin данные");
      }
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handlePlanChange(id: number, plan: string) {
    setChanging(id);
    try {
      const updated = await saas.updateTenantPlan(id, plan);
      setTenants(
        (prev) => prev?.map((t) => (t.id === id ? { ...t, plan: updated.plan } : t)) ?? null,
      );
      toast.success(`${updated.slug}: план изменён на ${PLAN_LABEL[plan] ?? plan}`);
    } catch {
      toast.error("Не удалось изменить план");
    } finally {
      setChanging(null);
    }
  }

  async function copyInvite(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link скопирован");
    } catch {
      toast.error("Не удалось скопировать ссылку");
    }
  }

  async function handleApprove(id: number) {
    setApproving(id);
    try {
      const result = await saas.approveEarlyAccess(id, { plan: "starter" });
      setAlpha((prev) => prev?.map((item) => (item.id === id ? result.item : item)) ?? null);
      const tenantRows = await saas.listAllTenants();
      setTenants(tenantRows.items);
      if (result.invite.shareUrl) {
        await navigator.clipboard.writeText(result.invite.shareUrl).catch(() => {});
      }
      toast.success("Alpha-доступ выдан", {
        description: `${result.tenant.slug}: invite link готов`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Такой slug уже занят");
      } else {
        toast.error("Не удалось выдать доступ");
      }
    } finally {
      setApproving(null);
    }
  }

  if (error) return <p className="p-8 text-destructive">{error}</p>;

  const pendingCount = alpha?.filter((item) => item.status === "new").length ?? 0;
  const approvedCount = alpha?.filter((item) => item.status === "approved").length ?? 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Alpha access</h1>
          <p className="text-sm text-muted-foreground">
            Approve-only доступ: заявка → tenant → invite link на создание пароля.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadData}>
          <RefreshCwIcon />
          Обновить
        </Button>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Заявки раннего доступа
          </h2>
          <Badge variant={pendingCount > 0 ? "warning" : "secondary"}>{pendingCount} new</Badge>
          <Badge variant="default">{approvedCount} approved</Badge>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Заявка
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Workflow
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Статус
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Tenant
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Invite
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Действие
                </th>
              </tr>
            </thead>
            <tbody>
              {alpha === null
                ? Array.from({ length: 4 }).map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                    <tr key={i} className="border-t">
                      {Array.from({ length: 6 }).map((__, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                        <td key={j} className="px-4 py-3">
                          <Skeleton className="h-4 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                : alpha.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t align-top transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <p className="font-medium">{item.email}</p>
                          <p className="text-xs text-muted-foreground">
                            {[item.name, item.company].filter(Boolean).join(" · ") || "—"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {fmtDateTime(item.createdAt)}
                          </p>
                        </div>
                      </td>
                      <td className="max-w-[300px] whitespace-normal px-4 py-3 text-muted-foreground">
                        {item.useCase || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <AlphaStatus item={item} />
                      </td>
                      <td className="px-4 py-3">
                        {item.tenantSlug ? (
                          <div className="space-y-1">
                            <p className="font-mono font-medium">{item.tenantSlug}</p>
                            <p className="text-xs text-muted-foreground">
                              {PLAN_LABEL[item.tenantPlan ?? ""] ?? item.tenantPlan}
                            </p>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {item.inviteUrl ? (
                          <div className="flex min-w-[280px] items-center gap-2">
                            <code className="max-w-[260px] flex-1 truncate rounded border bg-muted px-2 py-1 text-xs">
                              {item.inviteUrl}
                            </code>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="size-8"
                              onClick={() => copyInvite(item.inviteUrl!)}
                              aria-label="Скопировать invite link"
                            >
                              <CopyIcon className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="size-8"
                              asChild
                            >
                              <a
                                href={item.inviteUrl}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Открыть invite link"
                              >
                                <ExternalLinkIcon className="size-4" />
                              </a>
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {item.inviteExpiresAt && !item.inviteUsedAt && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            expires {fmtDate(item.inviteExpiresAt)}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {item.status === "new" ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleApprove(item.id)}
                            disabled={approving === item.id}
                          >
                            <UserPlusIcon />
                            Approve
                          </Button>
                        ) : item.inviteUrl ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => copyInvite(item.inviteUrl!)}
                          >
                            <CopyIcon />
                            Copy
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {alpha?.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">Заявок пока нет</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Тенанты
          </h2>
          <p className="text-sm text-muted-foreground">Все аккаунты платформы и их текущий план.</p>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Слаг
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Email владельца
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  План
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Статус
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Лиды
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Диалоги
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Создан
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants === null
                ? Array.from({ length: 5 }).map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                    <tr key={i} className="border-t">
                      {Array.from({ length: 7 }).map((__, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                        <td key={j} className="px-4 py-2">
                          <Skeleton className="h-4 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))
                : tenants.map((t) => (
                    <tr key={t.id} className="border-t transition-colors hover:bg-muted/30">
                      <td className="px-4 py-2 font-mono font-medium">{t.slug}</td>
                      <td className="px-4 py-2 text-muted-foreground">{t.ownerEmail ?? "—"}</td>
                      <td className="px-4 py-2">
                        <Select
                          value={t.plan}
                          onValueChange={(v) => handlePlanChange(t.id, v)}
                          disabled={changing === t.id}
                        >
                          <SelectTrigger className="h-7 w-28 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PLANS.map((p) => (
                              <SelectItem key={p} value={p} className="text-xs">
                                {PLAN_LABEL[p]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            t.status === "active"
                              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                              : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{t.leadCount}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{t.conversationCount}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {fmtDate(t.createdAt)}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {tenants?.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">Нет тенантов</p>
          )}
        </div>
      </section>
    </div>
  );
}
