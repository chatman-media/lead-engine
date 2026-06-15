import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type DirectorHook } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangleIcon, EditIcon, GripVerticalIcon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

interface HookFormState {
  name: string;
  body: string;
  triggerHint: string;
  applicableStages: string[];
  isActive: boolean;
}

const EMPTY_FORM: HookFormState = {
  name: "",
  body: "",
  triggerHint: "",
  applicableStages: [],
  isActive: true,
};

// Стадии воронки для стадийной фильтрации хука (FUNNEL_STAGES в packages/kb).
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "opener", label: "Открытие" },
  { value: "qualify", label: "Квалификация" },
  { value: "pitch", label: "Презентация" },
  { value: "objection", label: "Возражения" },
  { value: "close", label: "Закрытие" },
];

/** Парсит applicable_stages_json в массив (битый JSON → []). */
function parseStages(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function SaasHooks() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DirectorHook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // null = closed, 0 = create new, N = edit existing id
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<HookFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteHookId, setConfirmDeleteHookId] = useState<number | null>(null);

  // drag-to-reorder state
  const [draggingId, setDraggingId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    saas
      .listDirectorHooks()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
        } else {
          setError("Не удалось загрузить хуки");
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId(0);
  }

  function openEdit(hook: DirectorHook) {
    setForm({
      name: hook.name,
      body: hook.body,
      triggerHint: hook.triggerHint ?? "",
      applicableStages: parseStages(hook.applicableStagesJson),
      isActive: hook.isActive,
    });
    setEditingId(hook.id);
  }

  function toggleStage(value: string) {
    setForm((f) => ({
      ...f,
      applicableStages: f.applicableStages.includes(value)
        ? f.applicableStages.filter((v) => v !== value)
        : [...f.applicableStages, value],
    }));
  }

  function closeForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.body.trim()) {
      toast.error("Название и текст обязательны");
      return;
    }
    setSaving(true);
    try {
      if (editingId === 0) {
        await saas.createDirectorHook({
          name: form.name.trim(),
          body: form.body.trim(),
          triggerHint: form.triggerHint.trim() || undefined,
          applicableStages: form.applicableStages,
          isActive: form.isActive,
        });
        toast.success("Хук создан");
      } else if (editingId !== null) {
        await saas.updateDirectorHook(editingId, {
          name: form.name.trim(),
          body: form.body.trim(),
          triggerHint: form.triggerHint.trim() || null,
          applicableStages: form.applicableStages,
          isActive: form.isActive,
        });
        toast.success("Хук обновлён");
      }
      closeForm();
      load();
    } catch {
      toast.error("Не удалось сохранить хук");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    setConfirmDeleteHookId(null);
    setDeletingId(id);
    try {
      await saas.deleteDirectorHook(id);
      toast.success("Хук удалён");
      setItems((prev) => prev.filter((h) => h.id !== id));
    } catch {
      toast.error("Не удалось удалить хук");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleToggleActive(hook: DirectorHook) {
    const newVal = !hook.isActive;
    setItems((prev) => prev.map((h) => (h.id === hook.id ? { ...h, isActive: newVal } : h)));
    try {
      await saas.updateDirectorHook(hook.id, { isActive: newVal });
    } catch {
      setItems((prev) => prev.map((h) => (h.id === hook.id ? { ...h, isActive: hook.isActive } : h)));
      toast.error("Не удалось обновить хук");
    }
  }

  // Drag-to-reorder handlers
  function handleDragStart(id: number) {
    setDraggingId(id);
  }

  function handleDragOver(e: React.DragEvent, targetId: number) {
    e.preventDefault();
    if (draggingId === null || draggingId === targetId) return;
    setItems((prev) => {
      const from = prev.findIndex((h) => h.id === draggingId);
      const to = prev.findIndex((h) => h.id === targetId);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }

  async function handleDragEnd() {
    setDraggingId(null);
    const ids = items.map((h) => h.id);
    try {
      await saas.reorderDirectorHooks(ids);
    } catch {
      toast.error("Не удалось сохранить порядок");
      load();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Хуки убеждения"
        description="Короткие скрипты, которые бот использует когда нужно снять возражение или усилить оффер"
      />

      <div>
        <Button onClick={openCreate} size="sm" disabled={editingId === 0}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Добавить хук
        </Button>
      </div>

      {/* Create / Edit form */}
      {editingId !== null && (
        <Card className="border-primary/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {editingId === 0 ? "Новый хук" : "Редактировать хук"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="hook-name">Название</Label>
              <Input
                id="hook-name"
                placeholder="Например: Рассрочка 20/80"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hook-trigger">Когда использовать (необязательно)</Label>
              <Input
                id="hook-trigger"
                placeholder="Когда клиент говорит что нет всей суммы"
                value={form.triggerHint}
                onChange={(e) => setForm((f) => ({ ...f, triggerHint: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Стадии воронки</Label>
              <div className="flex flex-wrap gap-1.5">
                {STAGE_OPTIONS.map((s) => {
                  const on = form.applicableStages.includes(s.value);
                  return (
                    <Button
                      key={s.value}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      onClick={() => toggleStage(s.value)}
                    >
                      {s.label}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Если ничего не выбрано — хук применяется на всех стадиях.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="hook-body">Инструкция боту</Label>
              <Textarea
                id="hook-body"
                rows={6}
                placeholder="Если покупатель говорит «нет всей суммы сейчас» — объясни: в большинстве off-plan проектов достаточно 20% PDC при подписании..."
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="hook-active"
                checked={form.isActive}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
              />
              <Label htmlFor="hook-active">Активен</Label>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <SaveIcon className="mr-2 h-4 w-4" />
                {saving ? "Сохраняем…" : "Сохранить"}
              </Button>
              <Button size="sm" variant="ghost" onClick={closeForm}>
                <XIcon className="mr-2 h-4 w-4" />
                Отмена
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="flex justify-between">
                <Skeleton className="h-4 w-40" />
                <div className="flex gap-1"><Skeleton className="h-7 w-7" /><Skeleton className="h-7 w-7" /></div>
              </div>
              <Skeleton className="h-3 w-64" />
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* Hooks list */}
      {!loading && items.length === 0 && !error && editingId === null && (
        <p className="text-muted-foreground text-sm">
          Хуков пока нет. Добавьте первый — например: «Рассрочка 20/80» или «Контракт до вылета».
        </p>
      )}

      <div className="flex flex-col gap-3">
        {items.map((hook) => (
          <div
            key={hook.id}
            draggable
            onDragStart={() => handleDragStart(hook.id)}
            onDragOver={(e) => handleDragOver(e, hook.id)}
            onDragEnd={handleDragEnd}
            className={`transition-opacity ${draggingId === hook.id ? "opacity-50" : ""}`}
          >
            <Card className={hook.isActive ? "" : "opacity-60"}>
              <CardHeader className="pb-2">
                <div className="flex items-start gap-2">
                  <GripVerticalIcon className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{hook.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={hook.isActive}
                          onCheckedChange={() => handleToggleActive(hook)}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => openEdit(hook)}
                          disabled={editingId !== null}
                        >
                          <EditIcon className="h-3.5 w-3.5" />
                        </Button>
                        {confirmDeleteHookId === hook.id ? (
                          <div className="flex items-center gap-1">
                            <AlertTriangleIcon className="size-3.5 text-destructive shrink-0" />
                            <Button size="sm" variant="destructive" onClick={() => handleDelete(hook.id)} disabled={deletingId === hook.id}>
                              Да
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteHookId(null)}>
                              Нет
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => setConfirmDeleteHookId(hook.id)}
                            disabled={deletingId === hook.id}
                          >
                            <Trash2Icon className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </CardTitle>
                    {hook.triggerHint && (
                      <p className="text-xs text-muted-foreground italic">{hook.triggerHint}</p>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap">
                  {hook.body}
                </p>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
