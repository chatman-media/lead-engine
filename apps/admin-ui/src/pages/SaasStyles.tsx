import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type StyleItem } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangleIcon, EditIcon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";

interface StyleFormState {
  displayName: string;
  slug: string;
  personaName: string;
  personaRole: string;
  personaCompany: string;
  framework: string;
  isActive: boolean;
}

const EMPTY_FORM: StyleFormState = {
  displayName: "",
  slug: "",
  personaName: "",
  personaRole: "",
  personaCompany: "",
  framework: "",
  isActive: true,
};

const FRAMEWORKS = ["SPIN", "AIDA", "Challenger", "Sandler", "Consultative"];

function toSlug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

function buildConfigJson(form: StyleFormState): string {
  const config: Record<string, unknown> = {};
  if (form.personaName || form.personaRole || form.personaCompany) {
    const persona: Record<string, string> = {};
    if (form.personaName) persona.name = form.personaName;
    if (form.personaRole) persona.role = form.personaRole;
    if (form.personaCompany) persona.company = form.personaCompany;
    config.persona = persona;
  }
  if (form.framework) config.framework = form.framework;
  return JSON.stringify(config);
}

function formFromItem(item: StyleItem): StyleFormState {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(item.configJson) as Record<string, unknown>;
  } catch {
    // ignore
  }
  const persona = config.persona as Record<string, string> | undefined;
  return {
    displayName: item.displayName,
    slug: item.slug,
    personaName: persona?.name ?? "",
    personaRole: persona?.role ?? "",
    personaCompany: persona?.company ?? "",
    framework: (config.framework as string) ?? "",
    isActive: item.isActive,
  };
}

export function SaasStyles() {
  const navigate = useNavigate();
  const [items, setItems] = useState<StyleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // null = closed, 0 = create new, N = edit existing id
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<StyleFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    saas
      .listStyles()
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
        } else {
          setError("Не удалось загрузить стили");
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

  function openEdit(item: StyleItem) {
    setForm(formFromItem(item));
    setEditingId(item.id);
  }

  function closeForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function handleDisplayNameChange(val: string) {
    setForm((f) => ({
      ...f,
      displayName: val,
      // auto-fill slug only while creating and slug hasn't been manually touched
      ...(editingId === 0 && f.slug === toSlug(f.displayName) ? { slug: toSlug(val) } : {}),
    }));
  }

  async function handleSave() {
    if (!form.displayName.trim()) {
      toast.error("Название обязательно");
      return;
    }
    if (!form.slug || !/^[a-z0-9_-]+$/.test(form.slug)) {
      toast.error("Slug: только строчные буквы, цифры, _ и -");
      return;
    }
    setSaving(true);
    try {
      const configJson = buildConfigJson(form);
      if (editingId === 0) {
        await saas.createStyle({
          displayName: form.displayName.trim(),
          slug: form.slug,
          configJson,
          isActive: form.isActive,
        });
        toast.success("Стиль создан");
      } else if (editingId !== null) {
        await saas.updateStyle(editingId, {
          displayName: form.displayName.trim(),
          configJson,
          isActive: form.isActive,
        });
        toast.success("Стиль обновлён");
      }
      closeForm();
      load();
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 409
        ? "Стиль с таким slug уже существует"
        : "Не удалось сохранить стиль";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    setConfirmDeleteId(null);
    setDeletingId(id);
    try {
      await saas.deleteStyle(id);
      toast.success("Стиль удалён");
      setItems((prev) => prev.filter((s) => s.id !== id));
    } catch {
      toast.error("Не удалось удалить стиль");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleToggleActive(item: StyleItem) {
    const newVal = !item.isActive;
    setItems((prev) => prev.map((s) => (s.id === item.id ? { ...s, isActive: newVal } : s)));
    try {
      await saas.updateStyle(item.id, { isActive: newVal });
    } catch {
      setItems((prev) => prev.map((s) => (s.id === item.id ? { ...s, isActive: item.isActive } : s)));
      toast.error("Не удалось обновить стиль");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Стили общения"
        description="Персоны и продажные фреймворки — единица A/B тестирования"
      />

      <div>
        <Button onClick={openCreate} size="sm" disabled={editingId === 0}>
          <PlusIcon className="mr-2 h-4 w-4" />
          Добавить стиль
        </Button>
      </div>

      {/* Create / Edit form */}
      {editingId !== null && (
        <Card className="border-primary/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {editingId === 0 ? "Новый стиль" : "Редактировать стиль"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="style-name">Название</Label>
                <Input
                  id="style-name"
                  placeholder="Например: Дружелюбный эксперт"
                  value={form.displayName}
                  onChange={(e) => handleDisplayNameChange(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-slug">
                  Slug <span className="text-muted-foreground text-xs font-normal">(a-z, 0-9, _)</span>
                </Label>
                <Input
                  id="style-slug"
                  placeholder="friendly_expert"
                  value={form.slug}
                  disabled={editingId !== 0}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }))}
                  className="font-mono"
                />
              </div>
            </div>

            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Персона</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="style-persona-name">Имя</Label>
                <Input
                  id="style-persona-name"
                  placeholder="Надежда"
                  value={form.personaName}
                  onChange={(e) => setForm((f) => ({ ...f, personaName: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-persona-role">Роль</Label>
                <Input
                  id="style-persona-role"
                  placeholder="Эксперт по недвижимости"
                  value={form.personaRole}
                  onChange={(e) => setForm((f) => ({ ...f, personaRole: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="style-persona-company">Компания</Label>
                <Input
                  id="style-persona-company"
                  placeholder="INFINITY AGENCY"
                  value={form.personaCompany}
                  onChange={(e) => setForm((f) => ({ ...f, personaCompany: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="style-framework">
                Фреймворк продаж <span className="text-muted-foreground text-xs font-normal">(необязательно)</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {FRAMEWORKS.map((fw) => (
                  <button
                    key={fw}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, framework: f.framework === fw ? "" : fw }))}
                    className={`rounded-md border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                      form.framework === fw
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50"
                    }`}
                  >
                    {fw}
                  </button>
                ))}
                <Input
                  placeholder="Свой…"
                  className="h-7 w-28 text-xs px-2"
                  value={FRAMEWORKS.includes(form.framework) ? "" : form.framework}
                  onChange={(e) => setForm((f) => ({ ...f, framework: e.target.value }))}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="style-active"
                checked={form.isActive}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
              />
              <Label htmlFor="style-active">Активен</Label>
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
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border p-4 space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item) => {
          let config: Record<string, unknown> = {};
          try {
            config = JSON.parse(item.configJson) as Record<string, unknown>;
          } catch {
            // ignore
          }
          const persona = config.persona as Record<string, unknown> | undefined;
          const framework = config.framework as string | undefined;

          return (
            <Card key={item.id} className={item.isActive ? "" : "opacity-60"}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-start justify-between gap-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{item.displayName}</span>
                      {framework && (
                        <Badge variant="secondary" className="text-xs shrink-0">{framework}</Badge>
                      )}
                      <Badge variant="outline" className="text-xs shrink-0">v{item.version}</Badge>
                      {!item.isActive && (
                        <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">неактивен</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">{item.slug}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Switch
                      checked={item.isActive}
                      onCheckedChange={() => handleToggleActive(item)}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEdit(item)}
                      disabled={editingId !== null}
                    >
                      <EditIcon className="h-3.5 w-3.5" />
                    </Button>
                    {confirmDeleteId === item.id ? (
                      <div className="flex items-center gap-1">
                        <AlertTriangleIcon className="size-3.5 text-destructive shrink-0" />
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(item.id)} disabled={deletingId === item.id}>
                          Да
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                          Нет
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setConfirmDeleteId(item.id)}
                        disabled={deletingId === item.id}
                      >
                        <Trash2Icon className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardTitle>
              </CardHeader>
              {persona && (
                <CardContent>
                  <p className="text-sm">
                    <span className="text-muted-foreground">Персона: </span>
                    <span className="font-medium">{persona.name as string}</span>
                    {typeof persona.role === "string" && (
                      <span className="text-muted-foreground"> · {persona.role}</span>
                    )}
                  </p>
                  {typeof persona.company === "string" && (
                    <p className="text-xs text-muted-foreground">{persona.company}</p>
                  )}
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      {!loading && items.length === 0 && !error && editingId === null && (
        <p className="text-muted-foreground text-sm">Стилей пока нет. Добавьте первый.</p>
      )}
    </div>
  );
}
