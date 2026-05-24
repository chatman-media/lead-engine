import { AlertTriangleIcon, CheckIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { type ReferralCode, saas } from "../api/saas.ts";

export function SaasReferral() {
  const [codes, setCodes] = useState<ReferralCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [customCode, setCustomCode] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const res = await saas.listReferralCodes();
      setCodes(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  async function handleCreate() {
    setCreating(true);
    setError("");
    try {
      await saas.createReferralCode(customCode.trim() || undefined);
      setCustomCode("");
      await refresh();
      toast.success("Код создан");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: number) {
    setConfirmDeleteId(null);
    try {
      await saas.deleteReferralCode(id);
      await refresh();
      toast.success("Код удалён");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopy(code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  }

  if (loading) return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="rounded-lg border p-5 space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="rounded-lg border p-4 space-y-2">
        <Skeleton className="h-5 w-24" />
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <Skeleton className="h-8 flex-1 rounded-md" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-8 w-8" />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Партнёрские коды"
        description="Раздавайте коды партнёрам — они передают их клиентам при регистрации"
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Создать код</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              placeholder="Свой код (необязательно, напр. PARTNER2026)"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
              className="max-w-xs font-mono"
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <Button onClick={handleCreate} disabled={creating}>
              <PlusIcon className="size-4" />
              {creating ? "Создаём…" : "Создать"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Если оставить пустым — сгенерируется автоматически
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Ваши коды</CardTitle>
          <Badge variant="secondary">{codes.length}</Badge>
        </CardHeader>
        <CardContent>
          {codes.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Кодов пока нет. Создайте первый ↑
            </p>
          ) : (
            <ul className="divide-y">
              {codes.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <code className="flex-1 rounded bg-muted px-3 py-1.5 font-mono text-sm font-semibold tracking-wider">
                    {c.code}
                  </code>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {c.usesCount === 0
                      ? "не использован"
                      : `${c.usesCount} регистр${c.usesCount === 1 ? "ация" : "аций"}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    onClick={() => handleCopy(c.code)}
                    title="Скопировать код"
                  >
                    {copied === c.code ? (
                      <CheckIcon className="size-4 text-green-500" />
                    ) : (
                      <CopyIcon className="size-4" />
                    )}
                  </Button>
                  {confirmDeleteId === c.id ? (
                    <div className="flex items-center gap-1">
                      <AlertTriangleIcon className="size-3.5 text-destructive shrink-0" />
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(c.id)}>
                        Да
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                        Нет
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmDeleteId(c.id)}
                      title="Удалить"
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <p className="text-sm font-medium mb-2">Как это работает</p>
          <ol className="space-y-1.5 text-sm text-muted-foreground list-decimal list-inside">
            <li>Создайте код и отправьте его партнёру (агентству, реселлеру)</li>
            <li>Партнёр передаёт код своим клиентам при регистрации</li>
            <li>Клиенты вводят код в поле «Реферальный код» на странице регистрации</li>
            <li>Счётчик «регистраций» обновляется автоматически</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
