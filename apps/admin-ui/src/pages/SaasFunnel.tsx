import {
  AlertTriangleIcon,
  BarChart2Icon,
  ChevronDownIcon,
  GripVerticalIcon,
  LayersIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
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
import { toast } from "sonner";

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

const FUNNEL_TEMPLATES = [
  { id: "exchange", label: "Обменный пункт", icon: "💱", stages: 12 },
  { id: "visa", label: "Виза / иммиграция", icon: "🛂", stages: 7 },
  { id: "real_estate", label: "Недвижимость", icon: "🏠", stages: null },
  { id: "modeling", label: "Модельное агентство", icon: "✨", stages: null },
  { id: "recruitment", label: "Рекрутинг", icon: "👔", stages: null },
] as const;

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
  // Загрузчик шаблонов скрыт по умолчанию — он затирает текущую воронку.
  const [showTemplates, setShowTemplates] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [analytics, setAnalytics] = useState<FunnelAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [confirmSeedTemplate, setConfirmSeedTemplate] = useState<string | null>(null);
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

  async function handleSeed(template: string) {
    if (funnel?.stages && funnel.stages.length > 0 && confirmSeedTemplate !== template) {
      setConfirmSeedTemplate(template);
      return;
    }
    setConfirmSeedTemplate(null);
    setSeeding(true);
    try {
      const result = await saas.seedFunnel(template);
      toast.success(`Шаблон применён: ${result.stagesCreated} стадий`);
      reload();
    } catch (err) {
      onAuthError(err);
    } finally {
      setSeeding(false);
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

      {/* Шаблоны воронки — скрыты по умолчанию (затирают текущую воронку) */}
      <div className="rounded-md border p-4">
        <button
          type="button"
          onClick={() => setShowTemplates((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          <LayersIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Сменить шаблон воронки</span>
          <span className="text-xs text-muted-foreground">опционально · заменит воронку</span>
          <ChevronDownIcon
            className={`ml-auto size-4 text-muted-foreground transition-transform ${
              showTemplates ? "rotate-180" : ""
            }`}
          />
        </button>
        {showTemplates && (
          <div className="mt-3 space-y-3">
            {funnel?.stages && funnel.stages.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Сейчас {funnel.stages.length} стадий · выбор шаблона заменит текущую воронку.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {FUNNEL_TEMPLATES.map((tpl) => (
                <Button
                  key={tpl.id}
                  variant={confirmSeedTemplate === tpl.id ? "destructive" : "outline"}
                  size="sm"
                  disabled={seeding}
                  onClick={() => handleSeed(tpl.id)}
                >
                  {tpl.icon} {tpl.label}
                  {tpl.stages ? ` · ${tpl.stages}` : ""}
                </Button>
              ))}
            </div>
            {confirmSeedTemplate && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangleIcon className="size-4 shrink-0" />
            <span className="flex-1">
              Заменит {funnel?.stages?.length ?? 0} стадий на{" "}
              {FUNNEL_TEMPLATES.find((tpl) => tpl.id === confirmSeedTemplate)?.stages
                ? `${FUNNEL_TEMPLATES.find((tpl) => tpl.id === confirmSeedTemplate)?.stages} стадий`
                : "стадии"}{" "}
              выбранного шаблона. Продолжить?
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => handleSeed(confirmSeedTemplate)}
              disabled={seeding}
            >
              Да
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmSeedTemplate(null)}>
              Нет
            </Button>
          </div>
            )}
          </div>
        )}
      </div>

      {!funnel?.funnel && (
        <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground text-sm">
          Откройте «Сменить шаблон воронки» выше, чтобы создать воронку из шаблона.
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
              <Badge variant="secondary" className="text-xs">
                {STAGE_TYPES.find((t) => t.value === stage.stageType)?.label ?? stage.stageType}
              </Badge>
              {stage.supportMode && (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  поддержка
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {stage.fields.length} полей
              </Badge>
            </div>
          </button>

          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete();
                }}
              >
                Да
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Нет
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2Icon className="size-4" />
            </button>
          )}
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
                    onValueChange={(v) => setNewField((p) => ({ ...p, fieldType: v as FieldType }))}
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
