import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type ExperimentItem, type StyleItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangleIcon, EditIcon, PauseIcon, PlayIcon, PlusIcon, SaveIcon, SquareIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  running: "bg-green-500/10 text-green-600 dark:text-green-400",
  paused: "bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] text-[var(--warning)]",
  done: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "черновик", running: "идёт", paused: "пауза", done: "завершён",
};
const METRIC_LABEL: Record<string, string> = {
  qualified: "Квалификация", won: "Сделка", "replied_3+": "3+ ответа",
};
const METRICS = ["qualified", "won", "replied_3+"] as const;

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}

interface AllocEntry { styleSlug: string; weight: number }

function parseAlloc(json: string): AllocEntry[] {
  try {
    const arr = JSON.parse(json) as Array<{ style_slug?: string; styleSlug?: string; weight?: number }>;
    return arr.map((e) => ({ styleSlug: e.style_slug ?? e.styleSlug ?? "", weight: e.weight ?? 1 }));
  } catch { return []; }
}

function totalWeight(entries: AllocEntry[]) {
  return entries.reduce((s, e) => s + e.weight, 0);
}

export function SaasExperiments() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ExperimentItem[]>([]);
  const [styles, setStyles] = useState<StyleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [editingId, setEditingId] = useState<number | null>(null); // 0 = create
  const [slug, setSlug] = useState("");
  const [metric, setMetric] = useState<string>("qualified");
  const [alloc, setAlloc] = useState<AllocEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<{ id: number; status: "running" | "paused" | "done" } | null>(null);

  function load() {
    setLoading(true);
    Promise.all([saas.listExperiments(), saas.listStyles()])
      .then(([expRes, styleRes]) => {
        setItems(expRes.items);
        setStyles(styleRes.items.filter((s) => s.isActive));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) { clearToken(); navigate("/login", { replace: true }); }
        else setError("Не удалось загрузить данные");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function openCreate() {
    setSlug(""); setMetric("qualified");
    setAlloc(styles.slice(0, 2).map((s) => ({ styleSlug: s.slug, weight: 1 })));
    setEditingId(0);
  }

  function openEdit(exp: ExperimentItem) {
    setSlug(exp.slug); setMetric(exp.successMetric);
    setAlloc(parseAlloc(exp.allocationJson));
    setEditingId(exp.id);
  }

  function closeForm() { setEditingId(null); }

  function setAllocStyle(idx: number, styleSlug: string) {
    setAlloc((a) => a.map((e, i) => i === idx ? { ...e, styleSlug } : e));
  }
  function setAllocWeight(idx: number, w: number) {
    setAlloc((a) => a.map((e, i) => i === idx ? { ...e, weight: Math.max(1, w) } : e));
  }
  function addAllocRow() {
    const used = new Set(alloc.map((e) => e.styleSlug));
    const next = styles.find((s) => !used.has(s.slug));
    setAlloc((a) => [...a, { styleSlug: next?.slug ?? "", weight: 1 }]);
  }
  function removeAllocRow(idx: number) {
    setAlloc((a) => a.filter((_, i) => i !== idx));
  }

  async function handleSave() {
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) { toast.error("Slug: только a-z, 0-9, _"); return; }
    if (alloc.length < 2) { toast.error("Нужно минимум 2 варианта"); return; }
    if (alloc.some((e) => !e.styleSlug)) { toast.error("Выбери стиль для каждого варианта"); return; }
    const slugSet = new Set(alloc.map((e) => e.styleSlug));
    if (slugSet.size < alloc.length) { toast.error("Стили не должны повторяться"); return; }

    const allocationJson = JSON.stringify(alloc.map((e) => ({ style_slug: e.styleSlug, weight: e.weight })));
    setSaving(true);
    try {
      if (editingId === 0) {
        await saas.createExperiment({ slug, allocationJson, successMetric: metric });
        toast.success("Эксперимент создан");
      } else if (editingId !== null) {
        await saas.updateExperiment(editingId, { allocationJson, successMetric: metric });
        toast.success("Эксперимент обновлён");
      }
      closeForm(); load();
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 409 ? "Slug уже занят" : "Не удалось сохранить";
      toast.error(msg);
    } finally { setSaving(false); }
  }

  async function handleStatus(id: number, status: "running" | "paused" | "done") {
    setConfirmStatus(null);
    try {
      const updated = await saas.setExperimentStatus(id, status);
      setItems((prev) => prev.map((e) => e.id === id ? updated : e));
      toast.success(`Статус: ${STATUS_LABEL[status]}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Не удалось изменить статус";
      toast.error(msg);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="A/B эксперименты"
        description="Сравнение стилей общения по исходу лидов"
      />

      <div>
        <Button onClick={openCreate} size="sm" disabled={editingId === 0 || styles.length < 2}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Новый эксперимент
        </Button>
        {styles.length < 2 && (
          <p className="mt-2 text-xs text-muted-foreground">Нужно минимум 2 активных стиля — создайте их на странице «Стили».</p>
        )}
      </div>

      {/* Form */}
      {editingId !== null && (
        <Card className="border-primary/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{editingId === 0 ? "Новый эксперимент" : "Редактировать эксперимент"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {editingId === 0 && (
              <div className="space-y-1">
                <Label htmlFor="exp-slug">Slug <span className="text-muted-foreground text-xs font-normal">(a-z, 0-9, _)</span></Label>
                <Input
                  id="exp-slug"
                  className="font-mono"
                  placeholder="например: friendly_vs_consultant_q3"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                />
              </div>
            )}

            <div className="space-y-1">
              <Label>Метрика успеха</Label>
              <Select value={metric} onValueChange={setMetric}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((m) => (
                    <SelectItem key={m} value={m}>{METRIC_LABEL[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Варианты (стиль → вес)</Label>
              <p className="text-xs text-muted-foreground">Вес — относительный. 2 и 1 означает 67% / 33% трафика.</p>
              <div className="space-y-2">
                {alloc.map((entry, idx) => {
                  const pct = totalWeight(alloc) > 0
                    ? Math.round((entry.weight / totalWeight(alloc)) * 100)
                    : 0;
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <Select value={entry.styleSlug} onValueChange={(v) => setAllocStyle(idx, v)}>
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder="Выбери стиль" />
                        </SelectTrigger>
                        <SelectContent>
                          {styles.map((s) => (
                            <SelectItem key={s.slug} value={s.slug}>{s.displayName}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        min={1}
                        max={99}
                        className="w-16 text-center font-mono"
                        value={entry.weight}
                        onChange={(e) => setAllocWeight(idx, Number.parseInt(e.target.value) || 1)}
                      />
                      <span className="text-xs text-muted-foreground w-10 text-right">{pct}%</span>
                      {alloc.length > 2 && (
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeAllocRow(idx)}>
                          <XIcon className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              {alloc.length < styles.length && (
                <Button size="sm" variant="ghost" onClick={addAllocRow} className="text-xs">
                  <PlusIcon className="mr-1 h-3 w-3" /> Добавить вариант
                </Button>
              )}
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <SaveIcon className="mr-2 h-4 w-4" />
                {saving ? "Сохраняем…" : "Сохранить"}
              </Button>
              <Button size="sm" variant="ghost" onClick={closeForm}>
                <XIcon className="mr-2 h-4 w-4" /> Отмена
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="flex justify-between"><Skeleton className="h-5 w-40" /><Skeleton className="h-5 w-16" /></div>
              <Skeleton className="h-3 w-56" />
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex flex-col gap-3">
        {items.map((exp) => {
          const allocs = parseAlloc(exp.allocationJson);
          const total = totalWeight(allocs);
          const canEdit = exp.status === "draft" || exp.status === "paused";

          return (
            <Card key={exp.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono truncate">{exp.slug}</span>
                    <Badge className={STATUS_BADGE[exp.status] ?? ""} variant="outline">
                      {STATUS_LABEL[exp.status] ?? exp.status}
                    </Badge>
                    <Badge variant="secondary" className="text-xs shrink-0">{METRIC_LABEL[exp.successMetric] ?? exp.successMetric}</Badge>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {canEdit && (
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(exp)} disabled={editingId !== null}>
                        <EditIcon className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {/* Status controls */}
                    {exp.status === "draft" && (
                      confirmStatus?.id === exp.id ? (
                        <div className="flex items-center gap-1">
                          <AlertTriangleIcon className="size-3.5 text-primary shrink-0" />
                          <Button size="sm" onClick={() => handleStatus(exp.id, "running")}>Запустить</Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmStatus(null)}>Нет</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setConfirmStatus({ id: exp.id, status: "running" })}>
                          <PlayIcon className="h-3 w-3" /> Запустить
                        </Button>
                      )
                    )}
                    {exp.status === "running" && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => handleStatus(exp.id, "paused")}>
                          <PauseIcon className="h-3 w-3" /> Пауза
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={() => handleStatus(exp.id, "done")}>
                          <SquareIcon className="h-3 w-3" /> Завершить
                        </Button>
                      </div>
                    )}
                    {exp.status === "paused" && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => handleStatus(exp.id, "running")}>
                          <PlayIcon className="h-3 w-3" /> Возобновить
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={() => handleStatus(exp.id, "done")}>
                          <SquareIcon className="h-3 w-3" /> Завершить
                        </Button>
                      </div>
                    )}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Allocation bars */}
                <div className="space-y-1.5">
                  {allocs.map((entry) => {
                    const pct = total > 0 ? Math.round((entry.weight / total) * 100) : 0;
                    const style = styles.find((s) => s.slug === entry.styleSlug);
                    return (
                      <div key={entry.styleSlug} className="flex items-center gap-2 text-xs">
                        <span className="w-32 truncate text-muted-foreground font-mono">{entry.styleSlug}</span>
                        <div className="flex-1 rounded-full bg-secondary h-1.5 overflow-hidden">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-8 text-right text-muted-foreground">{pct}%</span>
                        {style && <span className="text-muted-foreground">· {style.displayName}</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {exp.startedAt && <span>Старт: <span className="text-foreground">{formatDate(exp.startedAt)}</span></span>}
                  {exp.endedAt && <span>Конец: <span className="text-foreground">{formatDate(exp.endedAt)}</span></span>}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!loading && items.length === 0 && !error && editingId === null && (
        <p className="text-muted-foreground text-sm">Экспериментов пока нет. Создайте первый — нужно минимум 2 активных стиля.</p>
      )}
    </div>
  );
}
