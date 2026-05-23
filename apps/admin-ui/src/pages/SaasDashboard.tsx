import { CheckIcon, FileTextIcon, LightbulbIcon, PauseIcon, PlayIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { PlanWidget } from "@/components/PlanWidget";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type Admin,
  ApiError,
  type BillingPlan,
  clearToken,
  type DashboardStats,
  type KbDoc,
  type KbSuggestion,
  type OnboardingStatus,
  saas,
  type Tenant,
  type TenantInfo,
} from "../api/saas.ts";

export function SaasDashboard() {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [pasteTopic, setPasteTopic] = useState("");
  const [uploading, setUploading] = useState(false);

  // KB suggestions
  const [suggestions, setSuggestions] = useState<KbSuggestion[]>([]);
  const [suggestionDrafts, setSuggestionDrafts] = useState<Record<number, string>>({});
  const [decidingId, setDecidingId] = useState<number | null>(null);

  function onAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refreshSuggestions() {
    try {
      const res = await saas.listKbSuggestions({ status: "pending", limit: 20 });
      setSuggestions(res.items);
      setSuggestionDrafts((prev) => {
        const next = { ...prev };
        for (const s of res.items) {
          if (!(s.id in next)) next[s.id] = s.answerDraft ?? "";
        }
        return next;
      });
    } catch {
      // ignore — suggestions might not exist yet
    }
  }

  async function handleDecide(id: number, action: "approve" | "reject") {
    setDecidingId(id);
    try {
      await saas.decideKbSuggestion(id, action, {
        answerDraft: action === "approve" ? suggestionDrafts[id] : undefined,
      });
      await Promise.all([refreshSuggestions(), refreshDocs(), refreshOnboarding()]);
    } catch {
      // ignore
    } finally {
      setDecidingId(null);
    }
  }

  async function refreshDocs() {
    try {
      const list = await saas.listDocs();
      setDocs(list.items);
    } catch (err) {
      // KB-роуты на бэкенде включаются только если у какого-то тенанта есть
      // embed-конфиг (boot-gate) — иначе listDocs отдаёт 404. Это не ошибка
      // дашборда: считаем, что документов пока нет, и не пугаем баннером.
      if (!onAuthError(err)) setDocs([]);
    }
  }
  async function refreshOnboarding() {
    try {
      setOnboarding(await saas.onboardingStatus());
    } catch (err) {
      onAuthError(err);
    }
  }
  async function refreshBilling() {
    try {
      const [b, p] = await Promise.all([saas.getBillingPlan(), saas.listPlans()]);
      setBilling(b);
      setStripeEnabled(p.stripeEnabled);
    } catch (err) {
      onAuthError(err);
    }
  }
  async function refreshTenantInfo() {
    try {
      const { tenant } = await saas.getTenantInfo();
      setTenantInfo(tenant);
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleTogglePause() {
    if (!tenantInfo) return;
    const newPaused = tenantInfo.status === "active";
    if (newPaused && !confirm("Бот перестанет принимать сообщения. Продолжить?")) return;
    setTogglingPause(true);
    setError("");
    try {
      await saas.setTenantPaused(newPaused);
      await refreshTenantInfo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingPause(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await saas.me();
        if (cancelled) return;
        setAdmin(me.admin);
        setTenant(me.tenant);
        await Promise.all([
          refreshDocs(),
          refreshSuggestions(),
          refreshOnboarding(),
          refreshTenantInfo(),
          refreshBilling(),
          saas.getDashboardStats().then(setStats).catch(() => {}),
        ]);
      } catch (err) {
        if (cancelled) return;
        if (!onAuthError(err)) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  }, []);

  async function handlePaste(e: FormEvent) {
    e.preventDefault();
    if (!pasteBody.trim()) return;
    setUploading(true);
    setError("");
    try {
      await saas.uploadJson({
        title: pasteTitle.trim() || "untitled",
        body: pasteBody,
        ...(pasteTopic.trim() ? { topic: pasteTopic.trim() } : {}),
      });
      setPasteTitle("");
      setPasteBody("");
      setPasteTopic("");
      await Promise.all([refreshDocs(), refreshOnboarding()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError((err.extra?.upgradeHint as string) ?? "Лимит документов исчерпан — повысьте план");
      } else if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      await saas.uploadFile(file);
      await Promise.all([refreshDocs(), refreshOnboarding()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        setError((err.extra?.upgradeHint as string) ?? "Лимит документов исчерпан — повысьте план");
      } else if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Удалить документ?")) return;
    try {
      await saas.deleteDoc(id);
      await Promise.all([refreshDocs(), refreshOnboarding()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>;
  }

  const paused = tenantInfo?.status === "suspended";

  return (
    <div className="space-y-6">
      <PageHeader
        title="База знаний"
        description={`${admin?.email ?? ""} · ${tenant?.slug ?? "—"} · ${tenant?.plan ?? "free"}`}
        actions={
          tenantInfo && (
            <Button
              variant={paused ? "default" : "outline"}
              size="sm"
              onClick={handleTogglePause}
              disabled={togglingPause}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
              {paused ? "Возобновить бота" : "Пауза"}
            </Button>
          )
        }
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {paused && (
        <p className="flex items-center gap-2 rounded-lg border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] px-4 py-2.5 text-sm text-[var(--warning)]">
          <PauseIcon className="size-4 shrink-0" /> Бот на паузе — сообщения от клиентов не
          обрабатываются.
        </p>
      )}

      {onboarding && <OnboardingChecklist status={onboarding} />}

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold">{stats.leads.total}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Лидов всего</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-green-500">
                {stats.leads.byStage.filter((s) => s.kind === "terminal_won").reduce((sum, s) => sum + s.count, 0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Закрыто ботом</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold">{stats.conversations.open}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Активных диалогов</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold text-amber-500">{stats.conversations.escalated}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Ждут оператора</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-2xl font-bold">{stats.messages.last7days}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Сообщений за 7 дней</p>
            </CardContent>
          </Card>
          {stats.leads.byStage.length > 0 && (
            <div className="col-span-2 sm:col-span-5">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Лиды по стадиям</p>
                  <div className="flex flex-wrap gap-2">
                    {stats.leads.byStage.map((s) => (
                      <div
                        key={s.slug}
                        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1"
                      >
                        {s.color && (
                          <span
                            className="size-2 rounded-full shrink-0"
                            style={{ backgroundColor: s.color }}
                          />
                        )}
                        <span className="text-xs text-muted-foreground">{s.displayName}</span>
                        <span className="text-xs font-semibold">{s.count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Добавить документ</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-muted/50">
                <span className="grid size-10 place-items-center rounded-full bg-primary/15 text-primary">
                  <UploadIcon className="size-5" />
                </span>
                <span className="text-sm font-medium">Загрузить файл</span>
                <span className="text-xs text-muted-foreground">.txt, .md, .json, .pdf</span>
                <input
                  type="file"
                  accept=".txt,.md,.json,.pdf"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="sr-only"
                />
              </label>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 text-xs uppercase tracking-wider text-muted-foreground">
                    или вставить текст
                  </span>
                </div>
              </div>

              <form onSubmit={handlePaste} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder="Заголовок"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                  />
                  <Input
                    placeholder="Тема (опционально)"
                    value={pasteTopic}
                    onChange={(e) => setPasteTopic(e.target.value)}
                  />
                </div>
                <Textarea
                  placeholder="Текст документа…"
                  rows={6}
                  className="font-mono text-xs"
                  value={pasteBody}
                  onChange={(e) => setPasteBody(e.target.value)}
                />
                <Button type="submit" disabled={uploading || !pasteBody.trim()}>
                  {uploading ? "Загружаем…" : "Добавить документ"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Документы</CardTitle>
              <Badge variant="secondary">{docs.length}</Badge>
            </CardHeader>
            <CardContent>
              {docs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Документов пока нет. Загрузите первый ↑
                </p>
              ) : (
                <ul className="divide-y">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                        <FileTextIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{d.title}</p>
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                          {d.topic && <Badge variant="outline">{d.topic}</Badge>}
                          <span className="font-mono">{d.source}</span>
                          <span>· {new Date(d.createdAt * 1000).toLocaleDateString("ru")}</span>
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(d.id)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* KB Suggestions */}
          {suggestions.length > 0 && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2">
                  <LightbulbIcon className="size-4 text-amber-500" />
                  Предложения в базу знаний
                </CardTitle>
                <Badge variant="secondary">{suggestions.length}</Badge>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {suggestions.map((s) => (
                    <li key={s.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                      <p className="text-sm font-medium">{s.questionText}</p>
                      <textarea
                        className="min-h-[80px] w-full rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="Ответ для добавления в базу знаний…"
                        value={suggestionDrafts[s.id] ?? ""}
                        onChange={(e) =>
                          setSuggestionDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                        }
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={decidingId === s.id || !(suggestionDrafts[s.id] ?? "").trim()}
                          onClick={() => handleDecide(s.id, "approve")}
                        >
                          <CheckIcon className="mr-1.5 size-3.5" />
                          Добавить в КБ
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={decidingId === s.id}
                          onClick={() => handleDecide(s.id, "reject")}
                        >
                          <XIcon className="mr-1.5 size-3.5" />
                          Отклонить
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          {billing && (
            <PlanWidget
              billing={billing}
              stripeEnabled={stripeEnabled}
              onRefresh={refreshBilling}
            />
          )}
        </div>
      </div>
    </div>
  );
}
