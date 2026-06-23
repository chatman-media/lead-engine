import { useEffect, useState } from "react";
import { ApiError, clearToken, saas, type VacancyItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function SaasVacancies() {
  const navigate = useNavigate();
  const [items, setItems] = useState<VacancyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Form state (shared for create & edit)
  const [editing, setEditing] = useState<VacancyItem | null | "new">(null);
  const [formTitle, setFormTitle] = useState("");
  const [formBody, setFormBody] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirmDeleteVacancyId, setConfirmDeleteVacancyId] = useState<number | null>(null);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function reload() {
    try {
      const data = await saas.listVacancies();
      setItems(data.items);
    } catch (err) {
      if (!onAuthError(err)) setError("Не удалось загрузить записи");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  function openNew() {
    setEditing("new");
    setFormTitle("");
    setFormBody("");
    setFormUrl("");
    setFormActive(true);
    setFormError("");
  }

  function openEdit(v: VacancyItem) {
    setEditing(v);
    setFormTitle(v.title);
    setFormBody(v.body);
    setFormUrl(v.url ?? "");
    setFormActive(v.isActive);
    setFormError("");
  }

  function closeForm() {
    setEditing(null);
    setFormError("");
  }

  async function handleSave() {
    if (!formTitle.trim()) {
      setFormError("Введите название");
      return;
    }
    if (!formBody.trim()) {
      setFormError("Введите описание");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      if (editing === "new") {
        await saas.createVacancy({
          title: formTitle.trim(),
          body: formBody.trim(),
          url: formUrl.trim() || undefined,
          isActive: formActive,
        });
      } else if (editing) {
        await saas.updateVacancy(editing.id, {
          title: formTitle.trim(),
          body: formBody.trim(),
          url: formUrl.trim() || null,
          isActive: formActive,
        });
      }
      closeForm();
      await reload();
    } catch (err) {
      if (!onAuthError(err)) setFormError(err instanceof Error ? err.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(v: VacancyItem) {
    try {
      await saas.updateVacancy(v.id, { isActive: !v.isActive });
      await reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleDelete(v: VacancyItem) {
    setConfirmDeleteVacancyId(null);
    try {
      await saas.deleteVacancy(v.id);
      await reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  const active = items.filter((v) => v.isActive);
  const inactive = items.filter((v) => !v.isActive);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Каталог"
          description={`${active.length} активных · ${inactive.length} архивных`}
        />
        <Button size="sm" onClick={openNew}>
          <PlusIcon className="mr-1.5 size-3.5" />
          Новая запись
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Form: create or edit */}
      {editing !== null && (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">
                {editing === "new"
                  ? "Новая запись"
                  : `Редактировать: ${(editing as VacancyItem).title}`}
              </CardTitle>
              <Button variant="ghost" size="icon" className="size-6" onClick={closeForm}>
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Название *</Label>
              <Input
                placeholder="например: Апартаменты 2BR, Dubai Marina"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Описание *</Label>
              <Textarea
                placeholder="Подробное описание, условия, характеристики…"
                rows={5}
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                className="text-sm font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ссылка (необязательно)</Label>
              <Input
                placeholder="https://…"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="vacancy-active" checked={formActive} onCheckedChange={setFormActive} />
              <Label htmlFor="vacancy-active" className="text-xs cursor-pointer">
                Активна (бот использует при поиске)
              </Label>
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
            <div className="flex gap-2 pt-1">
              <Button size="sm" disabled={saving} onClick={handleSave}>
                {saving ? "Сохранение…" : "Сохранить"}
              </Button>
              <Button size="sm" variant="ghost" onClick={closeForm} disabled={saving}>
                Отмена
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <div className="flex gap-1">
                  <Skeleton className="h-7 w-16" />
                  <Skeleton className="h-7 w-7" />
                  <Skeleton className="h-7 w-7" />
                </div>
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Каталог пуст. Создайте первую запись — бот будет использовать её при ответах.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {[...active, ...inactive].map((v) => (
            <Card key={v.id} className={v.isActive ? "" : "opacity-60"}>
              <CardHeader className="pb-2 pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-sm">{v.title}</CardTitle>
                      {v.isActive ? (
                        <Badge variant="secondary" className="text-xs">
                          Активна
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Архив
                        </Badge>
                      )}
                      {v.url && (
                        <a
                          href={v.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-0.5"
                        >
                          <ExternalLinkIcon className="size-3" />
                          Ссылка
                        </a>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Создана {formatDate(v.createdAt)}
                      {v.updatedAt !== v.createdAt && ` · изменена ${formatDate(v.updatedAt)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => handleToggleActive(v)}
                    >
                      {v.isActive ? "В архив" : "Восстановить"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => openEdit(v)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    {confirmDeleteVacancyId === v.id ? (
                      <div className="flex items-center gap-1">
                        <AlertTriangleIcon className="size-3.5 text-destructive shrink-0" />
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(v)}>
                          Да
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteVacancyId(null)}
                        >
                          Нет
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setConfirmDeleteVacancyId(v.id)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pb-4">
                <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">
                  {v.body}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
