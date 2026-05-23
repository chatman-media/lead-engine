import { type DragEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  clearToken,
  saas,
  type FieldType,
  type FunnelData,
  type StageDefinition,
  type StageField,
  type StageType,
} from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { GripVerticalIcon, LayersIcon, PlusIcon, Trash2Icon } from "lucide-react";

const STAGE_TYPES: { value: StageType; label: string }[] = [
  { value: "form_fill", label: "Сбор данных" },
  { value: "document_upload", label: "Загрузка документов" },
  { value: "document_signature", label: "Подписание" },
  { value: "external_approval", label: "Внешнее одобрение" },
  { value: "payment", label: "Оплата" },
  { value: "waiting", label: "Ожидание" },
  { value: "interaction", label: "Встреча / звонок" },
  { value: "assessment", label: "Оценка" },
  { value: "milestone", label: "Контрольная точка" },
];

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Текст" },
  { value: "textarea", label: "Длинный текст" },
  { value: "number", label: "Число" },
  { value: "date", label: "Дата" },
  { value: "select", label: "Выбор" },
  { value: "multiselect", label: "Несколько вариантов" },
  { value: "boolean", label: "Да / Нет" },
  { value: "phone", label: "Телефон" },
  { value: "email", label: "Email" },
  { value: "file", label: "Файл" },
  { value: "photo", label: "Фото" },
];

const KIND_COLORS: Record<string, string> = {
  intake: "bg-blue-500/10 border-blue-500/30",
  active: "bg-card border-border",
  terminal_won: "bg-emerald-500/10 border-emerald-500/30",
  terminal_lost: "bg-red-500/10 border-red-500/30",
};

export function SaasFunnel() {
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedStage, setExpandedStage] = useState<number | null>(null);
  const [addingStage, setAddingStage] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [newStage, setNewStage] = useState({
    slug: "",
    displayName: "",
    stageType: "form_fill" as StageType,
    kind: "active" as "intake" | "active" | "terminal_won" | "terminal_lost",
    supportMode: false,
  });

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
      .getFunnel()
      .then(setFunnel)
      .catch((err) => {
        if (!onAuthError(err)) setError("Не удалось загрузить воронку");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, []);

  async function handleCreateStage() {
    if (!funnel?.funnel || !newStage.slug || !newStage.displayName) return;
    try {
      await saas.createStage({
        funnelId: funnel.funnel.id,
        slug: newStage.slug,
        displayName: newStage.displayName,
        stageType: newStage.stageType,
        kind: newStage.kind,
        supportMode: newStage.supportMode,
        position: (funnel.stages.length) * 10,
      });
      setNewStage({ slug: "", displayName: "", stageType: "form_fill", kind: "active", supportMode: false });
      setAddingStage(false);
      reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleDeleteStage(stageId: number) {
    if (!confirm("Удалить стадию? Все лиды на этой стадии потеряют привязку.")) return;
    try {
      await saas.deleteStage(stageId);
      reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  function handleDragStart(stageId: number) {
    setDraggedId(stageId);
  }

  function handleDragOver(e: DragEvent, stageId: number) {
    e.preventDefault();
    if (stageId !== draggedId) setDragOverId(stageId);
  }

  function handleDrop(e: DragEvent, targetId: number) {
    e.preventDefault();
    if (!draggedId || draggedId === targetId || !funnel) return;

    const stages = [...funnel.stages];
    const fromIdx = stages.findIndex((s) => s.id === draggedId);
    const toIdx = stages.findIndex((s) => s.id === targetId);
    const [moved] = stages.splice(fromIdx, 1);
    stages.splice(toIdx, 0, moved);

    const order = stages.map((s, i) => ({ id: s.id, position: i * 10 }));

    setDraggedId(null);
    setDragOverId(null);
    setFunnel((f) => f ? { ...f, stages: stages.map((s, i) => ({ ...s, position: i * 10 })) } : f);
    saas.reorderStages(order).catch(() => reload());
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDragOverId(null);
  }

  async function handleUpdateStage(stageId: number, patch: Partial<StageDefinition>) {
    try {
      await saas.updateStage(stageId, patch);
      reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleSeed(template: string) {
    if (funnel?.stages && funnel.stages.length > 0) {
      if (!confirm(`Это заменит все ${funnel.stages.length} стадий воронки на шаблон «${template}». Продолжить?`)) return;
    }
    setSeeding(true);
    try {
      await saas.seedFunnel(template);
      reload();
    } catch (err) {
      onAuthError(err);
    } finally {
      setSeeding(false);
    }
  }

  if (loading) return <p className="p-6 text-muted-foreground text-sm">Загрузка…</p>;
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Воронка"
          description="Настройка стадий и полей данных"
        />
        <Button variant="outline" size="sm" asChild>
          <Link to="/leads">← Лиды</Link>
        </Button>
      </div>

      {/* Шаблоны воронки */}
      <div className="rounded-md border p-4">
        <div className="flex items-center gap-2 mb-3">
          <LayersIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Загрузить шаблон воронки</span>
          {funnel?.stages && funnel.stages.length > 0 && (
            <span className="text-xs text-muted-foreground">(заменит текущие стадии)</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { id: "visa", label: "Виза / иммиграция", icon: "🛂" },
            { id: "real_estate", label: "Недвижимость", icon: "🏠" },
            { id: "modeling", label: "Модельное агентство", icon: "✨" },
            { id: "recruitment", label: "Рекрутинг", icon: "👔" },
          ].map((tpl) => (
            <Button
              key={tpl.id}
              variant="outline"
              size="sm"
              disabled={seeding}
              onClick={() => handleSeed(tpl.id)}
            >
              {tpl.icon} {tpl.label}
            </Button>
          ))}
        </div>
      </div>

      {!funnel?.funnel && (
        <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
          Выберите шаблон выше или воронка будет создана при загрузке шаблона.
        </div>
      )}

      {funnel?.funnel && (
        <div className="flex flex-col gap-3">
          {funnel.stages.map((stage) => (
            <StageCard
              key={stage.id}
              stage={stage}
              isExpanded={expandedStage === stage.id}
              isDragging={draggedId === stage.id}
              isDragOver={dragOverId === stage.id}
              onToggle={() => setExpandedStage(expandedStage === stage.id ? null : stage.id)}
              onDragStart={() => handleDragStart(stage.id)}
              onDragOver={(e) => handleDragOver(e, stage.id)}
              onDrop={(e) => handleDrop(e, stage.id)}
              onDragEnd={handleDragEnd}
              onDelete={() => handleDeleteStage(stage.id)}
              onUpdate={(patch) => handleUpdateStage(stage.id, patch)}
              onReload={reload}
            />
          ))}

          {/* Добавить стадию */}
          {!addingStage ? (
            <Button
              variant="outline"
              className="border-dashed"
              onClick={() => setAddingStage(true)}
            >
              <PlusIcon className="mr-1.5 size-4" />
              Добавить стадию
            </Button>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Новая стадия</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Slug</Label>
                    <Input
                      value={newStage.slug}
                      onChange={(e) =>
                        setNewStage((p) => ({
                          ...p,
                          slug: e.target.value.toLowerCase().replace(/\s+/g, "_"),
                        }))
                      }
                      placeholder="qualification"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Название</Label>
                    <Input
                      value={newStage.displayName}
                      onChange={(e) => setNewStage((p) => ({ ...p, displayName: e.target.value }))}
                      placeholder="Квалификация"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Тип стадии</Label>
                    <Select
                      value={newStage.stageType}
                      onValueChange={(v) => setNewStage((p) => ({ ...p, stageType: v as StageType }))}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STAGE_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Вид</Label>
                    <Select
                      value={newStage.kind}
                      onValueChange={(v) => setNewStage((p) => ({ ...p, kind: v as typeof p.kind }))}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="intake">Заявка</SelectItem>
                        <SelectItem value="active">Рабочая</SelectItem>
                        <SelectItem value="terminal_won">Успех</SelectItem>
                        <SelectItem value="terminal_lost">Отказ</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="support-mode-new"
                    checked={newStage.supportMode}
                    onCheckedChange={(v) => setNewStage((p) => ({ ...p, supportMode: v }))}
                  />
                  <Label htmlFor="support-mode-new" className="text-sm">
                    Support mode (бот не продаёт)
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleCreateStage} disabled={!newStage.slug || !newStage.displayName}>
                    Создать
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddingStage(false)}>
                    Отмена
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function StageCard({
  stage,
  isExpanded,
  isDragging,
  isDragOver,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onDelete,
  onUpdate,
  onReload,
}: {
  stage: StageDefinition;
  isExpanded: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDelete: () => void;
  onUpdate: (patch: Partial<StageDefinition>) => void;
  onReload: () => void;
}) {
  const [addingField, setAddingField] = useState(false);
  const [newField, setNewField] = useState({
    slug: "",
    displayName: "",
    fieldType: "text" as FieldType,
    required: false,
    aiExtractable: false,
  });

  async function handleCreateField() {
    if (!newField.slug || !newField.displayName) return;
    try {
      await saas.createStageField(stage.id, {
        ...newField,
        position: stage.fields.length * 10,
      });
      setNewField({ slug: "", displayName: "", fieldType: "text", required: false, aiExtractable: false });
      setAddingField(false);
      onReload();
    } catch {
      // ignore
    }
  }

  async function handleDeleteField(fieldId: number) {
    try {
      await saas.deleteStageField(stage.id, fieldId);
      onReload();
    } catch {
      // ignore
    }
  }

  return (
    <Card
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={[
        "border transition-opacity",
        KIND_COLORS[stage.kind] ?? "",
        isDragging ? "opacity-40" : "",
        isDragOver ? "ring-2 ring-primary ring-offset-1" : "",
      ].join(" ")}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <GripVerticalIcon className="size-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />

          <button
            type="button"
            className="flex flex-1 items-center gap-3 text-left"
            onClick={onToggle}
          >
            <div>
              <p className="text-sm font-semibold">{stage.displayName}</p>
              <p className="text-xs text-muted-foreground font-mono">{stage.slug}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="secondary" className="text-xs capitalize">
                {STAGE_TYPES.find((t) => t.value === stage.stageType)?.label ?? stage.stageType}
              </Badge>
              {stage.supportMode && (
                <Badge variant="outline" className="text-xs text-muted-foreground">support</Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {stage.fields.length} полей
              </Badge>
            </div>
          </button>

          <button
            type="button"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2Icon className="size-4" />
          </button>
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-4 pt-0">
          {/* Support mode toggle */}
          <div className="flex items-center gap-2">
            <Switch
              id={`support-${stage.id}`}
              checked={stage.supportMode}
              onCheckedChange={(v) => onUpdate({ supportMode: v })}
            />
            <Label htmlFor={`support-${stage.id}`} className="text-sm">
              Support mode
            </Label>
          </div>

          {/* Fields list */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Поля</p>
            {stage.fields.length === 0 && (
              <p className="text-xs text-muted-foreground">Полей пока нет.</p>
            )}
            <div className="flex flex-col gap-1.5">
              {stage.fields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  onDelete={() => handleDeleteField(field.id)}
                />
              ))}
            </div>
          </div>

          {/* Add field */}
          {!addingField ? (
            <Button variant="outline" size="sm" className="border-dashed" onClick={() => setAddingField(true)}>
              <PlusIcon className="mr-1 size-3.5" />
              Добавить поле
            </Button>
          ) : (
            <div className="rounded-md border p-3 space-y-2.5">
              <p className="text-xs font-semibold">Новое поле</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Slug</Label>
                  <Input
                    value={newField.slug}
                    onChange={(e) => setNewField((p) => ({ ...p, slug: e.target.value.toLowerCase().replace(/\s+/g, "_") }))}
                    placeholder="full_name"
                    className="text-sm h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Название</Label>
                  <Input
                    value={newField.displayName}
                    onChange={(e) => setNewField((p) => ({ ...p, displayName: e.target.value }))}
                    placeholder="Полное имя"
                    className="text-sm h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Тип</Label>
                  <Select
                    value={newField.fieldType}
                    onValueChange={(v) => setNewField((p) => ({ ...p, fieldType: v as FieldType }))}
                  >
                    <SelectTrigger className="text-sm h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex items-center gap-1.5">
                  <Switch
                    id={`req-${stage.id}`}
                    checked={newField.required}
                    onCheckedChange={(v) => setNewField((p) => ({ ...p, required: v }))}
                  />
                  <Label htmlFor={`req-${stage.id}`} className="text-xs">Обязательное</Label>
                </div>
                <div className="flex items-center gap-1.5">
                  <Switch
                    id={`ai-${stage.id}`}
                    checked={newField.aiExtractable}
                    onCheckedChange={(v) => setNewField((p) => ({ ...p, aiExtractable: v }))}
                  />
                  <Label htmlFor={`ai-${stage.id}`} className="text-xs">AI извлечение</Label>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleCreateField} disabled={!newField.slug || !newField.displayName}>
                  Добавить
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddingField(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function FieldRow({ field, onDelete }: { field: StageField; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{field.displayName}</span>
        <Badge variant="outline" className="text-xs capitalize">{field.fieldType}</Badge>
        {field.required && <span className="text-xs text-destructive">*</span>}
        {field.aiExtractable && <Badge variant="secondary" className="text-xs">AI</Badge>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">{field.slug}</span>
        <button type="button" onClick={onDelete} className="text-muted-foreground hover:text-destructive">
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
