import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, type TenantRow, saas } from "../api/saas.ts";
import { toast } from "sonner";

const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro" };
const PLANS = ["free", "starter", "pro"] as const;

function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function SaasSuperadmin() {
  const [items, setItems] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState<number | null>(null);

  useEffect(() => {
    saas.listAllTenants()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError("Нет доступа");
        } else {
          setError("Не удалось загрузить тенантов");
        }
      });
  }, []);

  async function handlePlanChange(id: number, plan: string) {
    setChanging(id);
    try {
      const updated = await saas.updateTenantPlan(id, plan);
      setItems((prev) => prev?.map((t) => t.id === id ? { ...t, plan: updated.plan } : t) ?? null);
      toast.success(`${updated.slug}: план изменён на ${PLAN_LABEL[plan] ?? plan}`);
    } catch {
      toast.error("Не удалось изменить план");
    } finally {
      setChanging(null);
    }
  }

  if (error) return <p className="p-8 text-destructive">{error}</p>;

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Суперадмин — тенанты</h1>
        <p className="text-sm text-muted-foreground">Все аккаунты платформы</p>
      </div>

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th scope="col" className="text-left px-4 py-2 font-medium">Слаг</th>
              <th scope="col" className="text-left px-4 py-2 font-medium">Email владельца</th>
              <th scope="col" className="text-left px-4 py-2 font-medium">План</th>
              <th scope="col" className="text-left px-4 py-2 font-medium">Статус</th>
              <th scope="col" className="text-right px-4 py-2 font-medium">Лиды</th>
              <th scope="col" className="text-right px-4 py-2 font-medium">Диалоги</th>
              <th scope="col" className="text-left px-4 py-2 font-medium">Создан</th>
              <th scope="col" className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {items === null
              ? Array.from({ length: 5 }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                  <tr key={i} className="border-t">
                    {Array.from({ length: 8 }).map((__, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                      <td key={j} className="px-4 py-2">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : items.map((t) => (
                  <tr key={t.id} className="border-t hover:bg-muted/30 transition-colors">
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
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        t.status === "active"
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-destructive/10 text-destructive"
                      }`}>
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.leadCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.conversationCount}</td>
                    <td className="px-4 py-2 text-muted-foreground text-xs">{fmtDate(t.createdAt)}</td>
                    <td className="px-4 py-2" />
                  </tr>
                ))}
          </tbody>
        </table>
        {items?.length === 0 && (
          <p className="text-center text-muted-foreground text-sm py-8">Нет тенантов</p>
        )}
      </div>
    </div>
  );
}
