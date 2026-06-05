import {
  BadgePercentIcon,
  BarChart2Icon,
  ChevronDownIcon,
  ClipboardListIcon,
  ClockIcon,
  CreditCardIcon,
  FlagIcon,
  GaugeIcon,
  GripVerticalIcon,
  HeadphonesIcon,
  type LucideIcon,
  PenLineIcon,
  PhoneIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { type DragEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  clearToken,
  type FieldType,
  type FunnelAnalytics,
  type FunnelData,
  type StageDefinition,
  type StageField,
  type StageType,
  saas,
} from "@/api/saas";
import { AiWorkflowPanel } from "@/components/AiWorkflowPanel";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const STAGE_TYPES: { value: StageType; label: string }[] = [
  { value: "form_fill", label: "Сбор данных" },
  { value: "document_upload", label: "Загрузка документов" },
  { value: "document_signature", label: "Подписание" },
  { value: "rate_confirmation", label: "Подтверждение курса" },
  { value: "external_approval", label: "Внешнее одобрение" },
  { value: "payment", label: "Оплата" },
  { value: "waiting", label: "Ожидание" },
  { value: "awaiting_operator", label: "Ожидание оператора" },
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
  { value: "video", label: "Видео" },
];

/** Иконка по типу стадии (для визуальной читаемости шага). */
const STAGE_TYPE_ICON: Record<StageType, LucideIcon> = {
  form_fill: ClipboardListIcon,
  document_upload: UploadIcon,
  document_signature: PenLineIcon,
  rate_confirmation: BadgePercentIcon,
  external_approval: ShieldCheckIcon,
  payment: CreditCardIcon,
  waiting: ClockIcon,
  awaiting_operator: HeadphonesIcon,
  interaction: PhoneIcon,
  assessment: GaugeIcon,
  milestone: FlagIcon,
};

/** Вид стадии: подпись + цвет номера-кружка + левый акцент карточки. */
const KIND_META: Record<string, { label: string; num: string; accent: string }> = {
  intake: { label: "Заявка", num: "bg-blue-500 text-white", accent: "border-l-blue-500" },
  active: {
    label: "Рабочая",
    num: "bg-primary/15 text-primary",
    accent: "border-l-border",
  },
  terminal_won: {
    label: "Успех",
    num: "bg-emerald-500 text-white",
    accent: "border-l-emerald-500",
  },
  terminal_lost: { label: "Отказ", num: "bg-red-500 text-white", accent: "border-l-red-500" },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? KIND_META.active!;
}

export function SaasFunnel() {
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedStage, setExpandedStage] = useState<number | null>(null);
  const [addingStage, setAddingStage] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [analytics, setAnalytics] = useState<FunnelAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
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

  useEffect(() => {
    reload();
  }, []);

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
        position: funnel.stages.length * 10,
      });
      setNewStage({
        slug: "",
        displayName: "",
        stageType: "form_fill",
        kind: "active",
        supportMode: false,
      });
      setAddingStage(false);
      reload();
    } catch (err) {
      onAuthError(err);
    }
  }

  async function handleDeleteStage(stageId: number) {
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
    setFunnel((f) =>
      f ? { ...f, stages: stages.map((s, i) => ({ ...s, position: i * 10 })) } : f,
    );
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

  if (loading)
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-52" />
          </div>
        </div>
        <div className="rounded-md border p-4 space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-32" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-20 ml-auto" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <PageHeader title="Воронка" description="Настройка стадий и полей данных" />
        <div className="flex items-center gap-2">
          <Badge variant="outline">{funnel?.stages?.length ?? 0} стадий</Badge>
          <Button size="sm" onClick={() => setAiPanelOpen(true)}>
            <SparklesIcon className="mr-1.5 size-4" />
            Настроить с AI
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/leads">← Лиды</Link>
          </Button>
        </div>
      </div>

      <AiWorkflowPanel open={aiPanelOpen} onOpenChange={setAiPanelOpen} onApplied={reload} />

      {funnel?.funnel && (
        <div className="flex flex-col gap-0">
          {funnel.stages.map((stage, idx) => (
            <StageCard
              key={stage.id}
              stage={stage}
              index={idx + 1}
              isLast={idx === funnel.stages.length - 1}
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
              className="mt-3 border-dashed"
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
                      onValueChange={(v) =>
                        setNewStage((p) => ({ ...p, stageType: v as StageType }))
                      }
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
                      onValueChange={(v) =>
                        setNewStage((p) => ({ ...p, kind: v as typeof p.kind }))
                      }
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
                  <Button
                    size="sm"
                    onClick={handleCreateStage}
                    disabled={!newStage.slug || !newStage.displayName}
                  >
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

      {/* Аналитика воронки */}
      {funnel?.funnel && (
        <div className="rounded-md border p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <BarChart2Icon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Аналитика воронки</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={analyticsLoading}
              onClick={async () => {
                setAnalyticsLoading(true);
                try {
                  setAnalytics(await saas.getFunnelAnalytics());
                } catch {
                  // ignore
                } finally {
                  setAnalyticsLoading(false);
                }
              }}
            >
              {analyticsLoading ? "Загрузка…" : analytics ? "Обновить" : "Загрузить"}
            </Button>
          </div>
          {analytics && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left py-2 pr-4 font-medium">Стадия</th>
                    <th className="text-right py-2 px-3 font-medium">Сейчас</th>
                    <th className="text-right py-2 px-3 font-medium">Всего вошло</th>
                    <th className="text-right py-2 pl-3 font-medium">Ср. дней</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.stages.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          {s.color && (
                            <span
                              className="size-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: s.color }}
                            />
                          )}
                          <span className="font-medium">{s.displayName}</span>
                          <span className="text-xs text-muted-foreground">
                            {s.kind === "terminal_won"
                              ? "✓"
                              : s.kind === "terminal_lost"
                                ? "✗"
                                : ""}
                          </span>
                        </div>
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {s.leadsCurrent > 0 ? (
                          <span className="font-semibold">{s.leadsCurrent}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                        {s.leadsEntered || "—"}
                      </td>
                      <td className="text-right py-2 pl-3 tabular-nums text-muted-foreground">
                        {s.avgDaysInStage !== null ? `${s.avgDaysInStage} д` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!analytics && !analyticsLoading && (
            <p className="text-xs text-muted-foreground">
              Нажмите «Загрузить» чтобы увидеть конверсию по стадиям.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StageCard({
  stage,
  index,
  isLast,
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
  index: number;
  isLast: boolean;
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
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      setNewField({
        slug: "",
        displayName: "",
        fieldType: "text",
        required: false,
        aiExtractable: false,
      });
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

  const kind = kindMeta(stage.kind);
  const TypeIcon = STAGE_TYPE_ICON[stage.stageType] ?? ClipboardListIcon;
  const typeLabel = STAGE_TYPES.find((t) => t.value === stage.stageType)?.label ?? stage.stageType;

  return (
    <div className="relative flex gap-3">
      {/* Рельс таймлайна: номер шага + соединительная линия */}
      <div className="flex w-7 shrink-0 flex-col items-center">
        <div
          className={cn(
            "mt-3 grid size-7 place-items-center rounded-full text-xs font-bold tabular-nums",
            kind.num,
          )}
        >
          {index}
        </div>
        {!isLast && <div className="my-1 w-px flex-1 bg-border" />}
      </div>

      <Card
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        className={cn(
          "mb-3 flex-1 border-l-2 py-0 transition-all",
          kind.accent,
          isExpanded ? "ring-1 ring-primary/30" : "hover:bg-accent/40",
          isDragging ? "opacity-40" : "",
          isDragOver ? "ring-2 ring-primary ring-offset-1" : "",
        )}
      >
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <GripVerticalIcon className="size-4 shrink-0 cursor-grab text-muted-foreground/60 active:cursor-grabbing" />

          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md",
              "bg-muted text-muted-foreground",
            )}
          >
            <TypeIcon className="size-4" />
          </span>

          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={onToggle}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{stage.displayName}</p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{typeLabel}</span>
                <span className="opacity-40">·</span>
                <span className="font-mono">{stage.slug}</span>
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {stage.supportMode && (
                <Badge variant="outline" className="hidden text-xs text-muted-foreground sm:inline">
                  поддержка
                </Badge>
              )}
              {(stage.kind === "terminal_won" || stage.kind === "terminal_lost") && (
                <Badge variant="outline" className="text-xs">
                  {kind.label}
                </Badge>
              )}
              <span className="text-xs tabular-nums text-muted-foreground">
                {stage.fields.length} полей
              </span>
              <ChevronDownIcon
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  isExpanded ? "rotate-180" : "",
                )}
              />
            </div>
          </button>

          {confirmDelete ? (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
              >
                Да
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => setConfirmDelete(false)}
              >
                Нет
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="shrink-0 text-muted-foreground/60 hover:text-destructive"
            >
              <Trash2Icon className="size-4" />
            </button>
          )}
        </div>

        {isExpanded && (
          <CardContent className="space-y-4 border-t px-3 pb-4 pt-3">
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
              <Button
                variant="outline"
                size="sm"
                className="border-dashed"
                onClick={() => setAddingField(true)}
              >
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
                      onChange={(e) =>
                        setNewField((p) => ({
                          ...p,
                          slug: e.target.value.toLowerCase().replace(/\s+/g, "_"),
                        }))
                      }
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
                      onValueChange={(v) =>
                        setNewField((p) => ({ ...p, fieldType: v as FieldType }))
                      }
                    >
                      <SelectTrigger className="text-sm h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
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
                    <Label htmlFor={`req-${stage.id}`} className="text-xs">
                      Обязательное
                    </Label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch
                      id={`ai-${stage.id}`}
                      checked={newField.aiExtractable}
                      onCheckedChange={(v) => setNewField((p) => ({ ...p, aiExtractable: v }))}
                    />
                    <Label htmlFor={`ai-${stage.id}`} className="text-xs">
                      AI извлечение
                    </Label>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleCreateField}
                    disabled={!newField.slug || !newField.displayName}
                  >
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
    </div>
  );
}

function FieldRow({ field, onDelete }: { field: StageField; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{field.displayName}</span>
        <Badge variant="outline" className="text-xs capitalize">
          {field.fieldType}
        </Badge>
        {field.required && <span className="text-xs text-destructive">*</span>}
        {field.aiExtractable && (
          <Badge variant="secondary" className="text-xs">
            AI
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">{field.slug}</span>
        <button
          type="button"
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
