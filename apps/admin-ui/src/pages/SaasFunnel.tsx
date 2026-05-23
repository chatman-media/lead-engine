import { useEffect, useState } from "react";
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
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

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
  intake: "bg-blue-50 border-blue-200",
  active: "bg-white border-gray-200",
  terminal_won: "bg-emerald-50 border-emerald-200",
  terminal_lost: "bg-red-50 border-red-200",
};

export function SaasFunnel() {
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedStage, setExpandedStage] = useState<number | null>(null);
  const [addingStage, setAddingStage] = useState(false);
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

  async function handleMoveStage(stage: StageDefinition, dir: "up" | "down") {
    if (!funnel) return;
    const idx = funnel.stages.findIndex((s) => s.id === stage.id);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= funnel.stages.length) return;

    const order = funnel.stages.map((s, i) => {
      if (i === idx) return { id: s.id, position: funnel.stages[swapIdx].position };
      if (i === swapIdx) return { id: s.id, position: stage.position };
      return { id: s.id, position: s.position };
    });

    try {
      await saas.reorderStages(order);
      reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleUpdateStage(stageId: number, patch: Partial<StageDefinition>) {
    try {
      await saas.updateStage(stageId, patch);
      reload();
    } catch (err) {
      onAuthError(err);
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

      {!funnel?.funnel && (
        <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
          Воронка не найдена. Создайте тенанта с шаблоном или создайте воронку через API.
        </div>
      )}

      {funnel?.funnel && (
        <div className="flex flex-col gap-3">
          {funnel.stages.map((stage, idx) => (
            <StageCard
              key={stage.id}
              stage={stage}
              isExpanded={expandedStage === stage.id}
              isFirst={idx === 0}
              isLast={idx === funnel.stages.length - 1}
              onToggle={() => setExpandedStage(expandedStage === stage.id ? null : stage.id)}
              onMoveUp={() => handleMoveStage(stage, "up")}
              onMoveDown={() => handleMoveStage(stage, "down")}
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
  isFirst,
  isLast,
  onToggle,
  onMoveUp,
  onMoveDown,
  onDelete,
  onUpdate,
  onReload,
}: {
  stage: StageDefinition;
  isExpanded: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
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
    <Card className={`border ${KIND_COLORS[stage.kind] ?? ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={isFirst}
              className="size-4 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ChevronUpIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={isLast}
              className="size-4 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ChevronDownIcon className="size-4" />
            </button>
          </div>

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
