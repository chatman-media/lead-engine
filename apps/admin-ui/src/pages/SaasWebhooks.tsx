import { CheckCircleIcon, PlusIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, type StageWebhook, saas } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function SaasWebhooks({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<StageWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create form
  const [creating, setCreating] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [saving, setSaving] = useState(false);

  // Test results per webhook id
  const [testResults, setTestResults] = useState<
    Record<number, { ok: boolean; status?: number; error?: string }>
  >({});
  const [testing, setTesting] = useState<number | null>(null);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  function reload() {
    saas
      .listStageWebhooks()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (!onAuthError(err)) setError("Не удалось загрузить вебхуки");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleCreate() {
    if (!newUrl.trim()) return;
    setSaving(true);
    try {
      await saas.createStageWebhook({
        url: newUrl.trim(),
        ...(newSecret.trim() ? { secret: newSecret.trim() } : {}),
      });
      setCreating(false);
      setNewUrl("");
      setNewSecret("");
      reload();
    } catch (err) {
      if (!onAuthError(err)) setError("Ошибка при создании");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(hook: StageWebhook) {
    try {
      await saas.updateStageWebhook(hook.id, { isActive: !hook.isActive });
      setItems((prev) =>
        prev.map((h) => (h.id === hook.id ? { ...h, isActive: !hook.isActive } : h)),
      );
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleDelete(id: number) {
    try {
      await saas.deleteStageWebhook(id);
      setItems((prev) => prev.filter((h) => h.id !== id));
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleTest(id: number) {
    setTesting(id);
    setTestResults((prev) => ({ ...prev, [id]: undefined as never }));
    try {
      const result = await saas.testStageWebhook(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      onAuthError(err);
    } finally {
      setTesting(null);
    }
  }

  if (loading)
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        {embedded ? (
          <p className="text-sm text-muted-foreground">
            Уведомления при смене стадии лида — интеграция с CRM, n8n, Zapier и др.
          </p>
        ) : (
          <PageHeader
            title="Вебхуки"
            description="Уведомления при смене стадии лида — интеграция с CRM, n8n, Zapier и др."
          />
        )}
        <Button
          size="sm"
          onClick={() => {
            setCreating(true);
            setNewUrl("");
            setNewSecret("");
          }}
        >
          <PlusIcon className="mr-1.5 size-3.5" />
          Добавить
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {creating && (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Новый вебхук</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">
                URL <span className="text-muted-foreground">(POST, JSON)</span>
              </Label>
              <Input
                placeholder="https://example.com/webhook"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Секрет для подписи <span className="text-muted-foreground">(опционально)</span>
              </Label>
              <Input
                type="password"
                placeholder="HMAC-secret — заголовок X-Signature: sha256=…"
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
                className="text-sm font-mono"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" disabled={!newUrl.trim() || saving} onClick={handleCreate}>
                {saving ? "Сохранение…" : "Сохранить"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCreating(false)}
                disabled={saving}
              >
                Отмена
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {items.length === 0 && !creating && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Нет вебхуков. Добавьте URL для получения событий смены стадии.
        </div>
      )}

      {items.map((hook) => {
        const testResult = testResults[hook.id];
        return (
          <Card key={hook.id} className={hook.isActive ? "" : "opacity-60"}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-start gap-3">
                <ZapIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono truncate">{hook.url}</p>
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {hook.hasSecret && (
                      <Badge variant="secondary" className="text-xs">
                        подписан
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      создан {formatDate(hook.createdAt)}
                    </span>
                    {testResult && (
                      <Badge
                        variant={testResult.ok ? "secondary" : "destructive"}
                        className="text-xs"
                      >
                        {testResult.ok
                          ? `✓ ${testResult.status}`
                          : (testResult.error ?? `✗ ${testResult.status}`)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={hook.isActive} onCheckedChange={() => handleToggle(hook)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7 px-2"
                    disabled={testing === hook.id}
                    onClick={() => handleTest(hook.id)}
                  >
                    <CheckCircleIcon className="mr-1 size-3.5" />
                    {testing === hook.id ? "Тест…" : "Тест"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7 px-2 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(hook.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium">Payload примера:</p>
        <pre className="overflow-x-auto">
          {JSON.stringify(
            {
              event: "lead.stage_changed",
              tenantId: 1,
              leadId: 42,
              contactId: 10,
              contactName: "Иван Иванов",
              from: { stageId: 1, slug: "initial", displayName: "Входящий" },
              to: { stageId: 2, slug: "qualified", displayName: "Квалифицирован" },
              timestamp: 1748000000,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </div>
  );
}
