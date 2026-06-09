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
  HistoryIcon,
  type LucideIcon,
  CheckIcon,
  PencilIcon,
  PenLineIcon,
  XIcon,
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
  type FunnelListItem,
  type FunnelTemplateInfo,
  type FunnelVersionDetail,
  type FunnelVersionItem,
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
import { Textarea } from "@/components/ui/textarea";
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

const FUNNELS_UPDATED_EVENT = "lead-engine:funnel-updated";

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

function stageTypeLabel(value: StageType | string): string {
  return STAGE_TYPES.find((item) => item.value === value)?.label ?? value;
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function fieldCountLabel(count: number): string {
  return `${count} ${pluralRu(count, "поле", "поля", "полей")}`;
}

const FUNNEL_VERSION_SOURCE_LABEL: Record<FunnelVersionItem["source"], string> = {
  ai_apply: "AI apply",
  template_apply: "Шаблон",
  manual_edit: "Ручная правка",
  rollback: "Откат",
};

function formatEpochDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function apiErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const violations = error.extra?.violations;
    if (Array.isArray(violations) && violations.length > 0) {
      return violations.map(String).join("\n");
    }
    return error.errorCode;
  }
  return "Не удалось выполнить действие";
}

function funnelLabel(item: Pick<FunnelListItem, "slug" | "verticalTemplateId">): string {
  const key = `${item.slug} ${item.verticalTemplateId ?? ""}`.toLowerCase();
  if (key.includes("exchange")) return "Обменка";
  if (key.includes("concierge")) return "Каталог услуг";
  if (key.includes("real_estate")) return "Продажа недвижимости";
  if (key.includes("partner")) return "Партнёры";
  if (key.includes("saas") || key.includes("product")) return "Продукт";
  return item.slug.replace(/_/g, " ");
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "");
}

function uniqueFunnelSlug(base: string, items: FunnelListItem[]): string {
  const normalized = normalizeSlug(base) || "funnel";
  const taken = new Set(items.map((item) => item.slug));
  if (!taken.has(normalized)) return normalized;
  for (let i = 2; i < 100; i++) {
    const candidate = `${normalized}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${normalized}_${Date.now()}`;
}

function templateAlreadyExists(template: FunnelTemplateInfo, items: FunnelListItem[]): boolean {
  if (template.key === "skeleton") return false;
  return items.some(
    (item) =>
      (template.verticalTemplateId && item.verticalTemplateId === template.verticalTemplateId) ||
      item.slug === template.key,
  );
}

function availableTemplates(
  templates: FunnelTemplateInfo[],
  items: FunnelListItem[],
): FunnelTemplateInfo[] {
  return templates.filter(
    (template) => template.isCreatable !== false && !templateAlreadyExists(template, items),
  );
}

export function SaasFunnel() {
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [funnels, setFunnels] = useState<FunnelListItem[]>([]);
  const [selectedFunnelId, setSelectedFunnelId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [funnelLoading, setFunnelLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedStage, setExpandedStage] = useState<number | null>(null);
  const [addingStage, setAddingStage] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [analytics, setAnalytics] = useState<FunnelAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [addingFunnel, setAddingFunnel] = useState(false);
  const [funnelTemplates, setFunnelTemplates] = useState<FunnelTemplateInfo[]>([]);
  const [newFunnelTemplate, setNewFunnelTemplate] = useState("exchange");
  const [newFunnelSlug, setNewFunnelSlug] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<FunnelVersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [versionPreview, setVersionPreview] = useState<FunnelVersionDetail | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<number | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackError, setRollbackError] = useState("");
  const [rollbackSuccess, setRollbackSuccess] = useState("");
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

  async function reload(
    nextFunnelId = selectedFunnelId,
    options: { refreshTemplates?: boolean } = {},
  ) {
    try {
      const list = await saas.listFunnels();
      setFunnels(list.items);
      if (options.refreshTemplates ?? funnelTemplates.length === 0) {
        const templates = await saas
          .listFunnelTemplates()
          .catch(() => ({ items: [] as FunnelTemplateInfo[] }));
        setFunnelTemplates(templates.items);
        if (
          templates.items.length > 0 &&
          !templates.items.some((t) => t.key === newFunnelTemplate)
        ) {
          setNewFunnelTemplate(templates.items[0]!.key);
        }
      }
      const targetId = nextFunnelId ?? list.items[0]?.id ?? null;
      setSelectedFunnelId(targetId);
      const data = targetId ? await saas.getFunnelById(targetId) : await saas.getFunnel();
      setFunnel(data);
      setAnalytics(null);
      setError("");
    } catch (err) {
      if (!onAuthError(err)) setError("Не удалось загрузить воронку");
    } finally {
      setLoading(false);
      setFunnelLoading(false);
    }
  }

  useEffect(() => {
    void reload(selectedFunnelId, { refreshTemplates: true });
  }, []);

  async function loadFunnelVersions(funnelId = selectedFunnelId) {
    if (!funnelId) return;
    setVersionsLoading(true);
    setVersionsError("");
    try {
      const result = await saas.listFunnelVersions(funnelId);
      setVersions(result.items);
      if (
        versionPreview &&
        !result.items.some((item) => item.id === versionPreview.version.id)
      ) {
        setVersionPreview(null);
      }
    } catch (err) {
      if (!onAuthError(err)) setVersionsError(apiErrorText(err));
    } finally {
      setVersionsLoading(false);
    }
  }

  async function handleOpenHistory() {
    if (!funnel?.funnel) return;
    const nextOpen = !historyOpen;
    setHistoryOpen(nextOpen);
    setRollbackConfirm(false);
    setRollbackError("");
    setRollbackSuccess("");
    if (nextOpen) await loadFunnelVersions(funnel.funnel.id);
  }

  async function handlePreviewVersion(versionId: number) {
    if (!funnel?.funnel) return;
    setPreviewLoadingId(versionId);
    setRollbackConfirm(false);
    setRollbackError("");
    setRollbackSuccess("");
    try {
      const result = await saas.getFunnelVersion(funnel.funnel.id, versionId);
      setVersionPreview(result);
    } catch (err) {
      if (!onAuthError(err)) setVersionsError(apiErrorText(err));
    } finally {
      setPreviewLoadingId(null);
    }
  }

  async function handleRollbackVersion() {
    if (!funnel?.funnel || !versionPreview) return;
    setRollbackLoading(true);
    setRollbackError("");
    setRollbackSuccess("");
    try {
      await saas.rollbackFunnelVersion(funnel.funnel.id, versionPreview.version.id);
      await reload(funnel.funnel.id, { refreshTemplates: false });
      await loadFunnelVersions(funnel.funnel.id);
      setRollbackConfirm(false);
      setRollbackSuccess("Воронка восстановлена из выбранной версии");
    } catch (err) {
      if (!onAuthError(err)) setRollbackError(apiErrorText(err));
    } finally {
      setRollbackLoading(false);
    }
  }

  async function handleSelectFunnel(id: number) {
    if (id === selectedFunnelId || funnelLoading) return;
    setSelectedFunnelId(id);
    setAddingFunnel(false);
    setNewFunnelSlug("");
    setHistoryOpen(false);
    setVersionPreview(null);
    setRollbackConfirm(false);
    setRollbackError("");
    setRollbackSuccess("");
    setFunnelLoading(true);
    setAnalytics(null);
    await reload(id, { refreshTemplates: false });
  }

  function handleOpenAddFunnel() {
    const options = availableTemplates(funnelTemplates, funnels);
    const templateKey = options.some((template) => template.key === newFunnelTemplate)
      ? newFunnelTemplate
      : (options[0]?.key ?? "skeleton");
    setNewFunnelTemplate(templateKey);
    if (!newFunnelSlug.trim()) {
      setNewFunnelSlug(uniqueFunnelSlug(templateKey, funnels));
    }
    setAddingFunnel(true);
  }

  function handleNewFunnelTemplateChange(key: string) {
    setNewFunnelTemplate(key);
    setNewFunnelSlug(uniqueFunnelSlug(key, funnels));
  }

  async function handleCreateFunnel() {
    const template = newFunnelTemplate || "skeleton";
    const slug = normalizeSlug(newFunnelSlug || uniqueFunnelSlug(template, funnels));
    if (!slug) return;
    try {
      const created = await saas.createFunnel({ slug, template });
      setNewFunnelSlug("");
      setAddingFunnel(false);
      await reload(created.funnelId, { refreshTemplates: false });
      window.dispatchEvent(new Event(FUNNELS_UPDATED_EVENT));
    } catch (err) {
      if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : "Не удалось создать процесс");
      }
    }
  }

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

  const selectableTemplates = availableTemplates(funnelTemplates, funnels);
  const selectedTemplate = funnelTemplates.find((t) => t.key === newFunnelTemplate);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Процессы обработки"
          description="Воронки, по которым система ведёт заявки после выбора услуги"
        />
        <div className="flex items-center gap-2">
          <Badge variant="outline">{funnel?.stages?.length ?? 0} стадий</Badge>
          <Button size="sm" onClick={() => setAiPanelOpen(true)}>
            <SparklesIcon className="mr-1.5 size-4" />
            Настроить с AI
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!funnel?.funnel}
            onClick={() => void handleOpenHistory()}
          >
            <HistoryIcon className="mr-1.5 size-4" />
            История
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/leads">← Лиды</Link>
          </Button>
        </div>
      </div>

      <AiWorkflowPanel open={aiPanelOpen} onOpenChange={setAiPanelOpen} onApplied={reload} />

      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Создание процесса
          </span>
          {addingFunnel ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Закрыть"
              onClick={() => setAddingFunnel(false)}
            >
              <XIcon className="size-4" />
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={handleOpenAddFunnel}>
              <PlusIcon className="size-4" />
              Создать процесс из шаблона
            </Button>
          )}
        </div>
        {addingFunnel && (
          <div className="mt-3 max-w-3xl">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
              <div className="space-y-1">
                <Label htmlFor="new-funnel-template" className="text-xs">
                  Предустановка
                </Label>
                <Select value={newFunnelTemplate} onValueChange={handleNewFunnelTemplateChange}>
                  <SelectTrigger id="new-funnel-template" className="h-8 text-sm">
                    <SelectValue placeholder="Выберите предустановку" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableTemplates.map((template) => (
                      <SelectItem key={template.key} value={template.key}>
                        {template.displayName} · {template.stagesCount} стадий
                      </SelectItem>
                    ))}
                    {funnelTemplates.length === 0 && (
                      <SelectItem value="skeleton">Пустой skeleton</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-funnel-slug" className="text-xs">
                  Код процесса
                </Label>
                <Input
                  id="new-funnel-slug"
                  value={newFunnelSlug}
                  onChange={(e) => setNewFunnelSlug(normalizeSlug(e.target.value))}
                  placeholder="partners"
                  className="h-8 text-sm"
                />
              </div>
            </div>
            {selectedTemplate && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{selectedTemplate.description}</span>
                <span className="font-medium text-foreground">
                  {selectedTemplate.stagesCount} стадий · {fieldCountLabel(selectedTemplate.fieldsCount)}
                </span>
              </div>
            )}
            {selectedTemplate && selectedTemplate.stages.length > 0 && (
              <div className="mt-3 max-h-56 overflow-auto rounded-md bg-background/70 p-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Предпросмотр стадий
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {selectedTemplate.stages.map((stage, idx) => {
                    const meta = kindMeta(stage.kind);
                    return (
                      <div
                        key={stage.slug}
                        className="flex min-h-10 items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted"
                      >
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                            meta.num,
                          )}
                        >
                          {idx + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">
                            {stage.displayName}
                          </span>
                          <span className="block truncate text-muted-foreground">
                            {stageTypeLabel(stage.stageType)}
                            {stage.phase ? ` · ${stage.phase}` : ""} · {fieldCountLabel(stage.fieldsCount)}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button size="sm" variant="ghost" onClick={() => setAddingFunnel(false)}>
                Отмена
              </Button>
              <Button size="sm" onClick={handleCreateFunnel} disabled={!newFunnelSlug.trim()}>
                Создать процесс
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-md border p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Процессы обработки
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {funnels.map((item) => {
            const active = item.id === selectedFunnelId;
            return (
              <button
                key={item.id}
                type="button"
                disabled={funnelLoading}
                onClick={() => void handleSelectFunnel(item.id)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-wait disabled:opacity-70",
                  active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted",
                )}
              >
                <span className="block font-medium">{funnelLabel(item)}</span>
                <span className="text-xs text-muted-foreground">
                  {item.stagesCount} стадий · {item.leadsCount} лидов
                </span>
              </button>
            );
          })}
          {funnels.length === 0 && (
            <span className="py-2 text-sm text-muted-foreground">Процессов пока нет</span>
          )}
        </div>
      </div>

      {historyOpen && funnel?.funnel && (
        <div className="grid gap-4 rounded-md border p-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">История версий</h2>
                <p className="text-xs text-muted-foreground">
                  {funnelLabel({
                    slug: funnel.funnel.slug,
                    verticalTemplateId: funnel.funnel.verticalTemplateId ?? null,
                  })}{" "}
                  · {versions.length} снимков
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={versionsLoading}
                onClick={() => void loadFunnelVersions(funnel.funnel?.id)}
              >
                {versionsLoading ? "…" : "Обновить"}
              </Button>
            </div>
            {versionsError && (
              <div className="mb-3 whitespace-pre-line rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {versionsError}
              </div>
            )}
            <div className="max-h-[28rem] overflow-auto rounded-md bg-muted/30 p-1">
              {versions.map((version) => {
                const active = versionPreview?.version.id === version.id;
                return (
                  <button
                    key={version.id}
                    type="button"
                    className={cn(
                      "mb-1 flex min-h-16 w-full items-start gap-2 rounded-sm border px-2 py-2 text-left text-sm last:mb-0",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-transparent bg-background hover:bg-muted",
                    )}
                    onClick={() => void handlePreviewVersion(version.id)}
                  >
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
                      {version.stageCount}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {FUNNEL_VERSION_SOURCE_LABEL[version.source] ?? version.source}
                        </span>
                        {previewLoadingId === version.id && (
                          <span className="text-xs text-muted-foreground">загрузка</span>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatEpochDate(version.createdAt)}
                      </span>
                      {version.note && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {version.note}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {!versionsLoading && versions.length === 0 && (
                <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                  Истории пока нет
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0">
            {versionPreview ? (
              <div className="space-y-4">
                <div className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {FUNNEL_VERSION_SOURCE_LABEL[versionPreview.version.source] ??
                          versionPreview.version.source}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatEpochDate(versionPreview.version.createdAt)}
                      </span>
                    </div>
                    <h2 className="mt-2 truncate text-base font-semibold">
                      {versionPreview.snapshot.funnel.slug}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {versionPreview.snapshot.stages.length} стадий ·{" "}
                      {versionPreview.snapshot.funnel.verticalTemplateId ?? "ручная воронка"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                    {!rollbackConfirm ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={
                          rollbackLoading || versionPreview.validation.errors.length > 0
                        }
                        onClick={() => setRollbackConfirm(true)}
                      >
                        Восстановить
                      </Button>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={rollbackLoading}
                          onClick={() => void handleRollbackVersion()}
                        >
                          {rollbackLoading ? "Откат…" : "Подтвердить"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={rollbackLoading}
                          onClick={() => setRollbackConfirm(false)}
                        >
                          Отмена
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {rollbackError && (
                  <div className="whitespace-pre-line rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                    {rollbackError}
                  </div>
                )}
                {rollbackSuccess && (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-700">
                    {rollbackSuccess}
                  </div>
                )}
                {versionPreview.validation.errors.length > 0 && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                    <div className="mb-1 text-xs font-semibold text-destructive">
                      Ошибки валидации
                    </div>
                    <ul className="space-y-1 text-xs text-destructive">
                      {versionPreview.validation.errors.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {versionPreview.validation.warnings.length > 0 && (
                  <div className="rounded-md border bg-muted/40 p-3">
                    <div className="mb-1 text-xs font-semibold text-muted-foreground">
                      Предупреждения
                    </div>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {versionPreview.validation.warnings.slice(0, 6).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="grid gap-2 md:grid-cols-2">
                  {versionPreview.snapshot.stages.map((stage, idx) => {
                    const meta = kindMeta(stage.kind);
                    return (
                      <div
                        key={`${stage.slug}-${idx}`}
                        className={cn(
                          "min-h-20 rounded-md border border-l-4 bg-background p-3",
                          meta.accent,
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={cn(
                              "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                              meta.num,
                            )}
                          >
                            {idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {stage.displayName}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {stage.slug} · {stageTypeLabel(stage.stageType)}
                              {stage.phase ? ` · ${stage.phase}` : ""}
                            </div>
                            <div className="mt-2 text-xs text-muted-foreground">
                              {fieldCountLabel(stage.fields.length)}
                              {stage.nextStages.length > 0
                                ? ` · → ${stage.nextStages.join(", ")}`
                                : ""}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex min-h-64 items-center justify-center rounded-md bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                Выберите версию слева, чтобы посмотреть снимок стадий
              </div>
            )}
          </div>
        </div>
      )}

      {funnel?.funnel && (
        <div
          className={cn(
            "flex flex-col gap-0 transition-opacity",
            funnelLoading ? "pointer-events-none opacity-60" : "",
          )}
        >
          {funnel.stages.map((stage, idx) => (
            <StageCard
              key={stage.id}
              stage={stage}
              allStages={funnel.stages}
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
                  setAnalytics(await saas.getFunnelAnalytics(funnel?.funnel?.id));
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
  allStages,
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
  allStages: StageDefinition[];
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
                {fieldCountLabel(stage.fields.length)}
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
          <CardContent className="space-y-3 border-t px-3 pb-3 pt-3">
            {/* Support mode toggle */}
            <div className="flex items-center gap-2">
              <Switch
                id={`support-${stage.id}`}
                checked={stage.supportMode}
                onCheckedChange={(v) => onUpdate({ supportMode: v })}
              />
              <Label htmlFor={`support-${stage.id}`} className="text-sm">
                Support mode (отвечает оператор, бот молчит)
              </Label>
            </div>

            {/* Поведение и логика стадии */}
            <StageBehaviourEditor stage={stage} allStages={allStages} onUpdate={onUpdate} />

            {/* Fields list */}
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Поля</p>
              {stage.fields.length === 0 && (
                <p className="text-xs text-muted-foreground">Полей пока нет.</p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-0">
                {stage.fields.map((field) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    onDelete={() => handleDeleteField(field.id)}
                    onEdit={(patch) => saas.updateStageField(stage.id, field.id, patch).then(onReload)}
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

const AUTO_ADVANCE_FILLED = '{"type":"all_required_fields_filled"}';

function StageBehaviourEditor({
  stage,
  allStages,
  onUpdate,
}: {
  stage: StageDefinition;
  allStages: StageDefinition[];
  onUpdate: (patch: Partial<StageDefinition>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState(stage.goal ?? "");
  const [guidance, setGuidance] = useState(stage.guidance ?? "");
  const [stale, setStale] = useState(stage.staleTimeoutDays?.toString() ?? "");
  const [checkin, setCheckin] = useState(stage.checkinIntervalDays?.toString() ?? "");
  const [partnerWebhookUrl, setPartnerWebhookUrl] = useState(stage.partnerWebhookUrl ?? "");
  const [partnerWebhookMode, setPartnerWebhookMode] = useState<"fire_and_forget" | "await_callback">(
    stage.partnerWebhookMode ?? "fire_and_forget",
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const autoAdvance = !!stage.autoAdvanceCondition;
  // краткая сводка для свёрнутого вида
  const summary = [
    stage.goal ? "цель" : null,
    stage.guidance ? "поведение" : null,
    autoAdvance ? "авто-переход" : null,
    stage.partnerWebhookUrl ? "webhook" : null,
    (stage.nextStages?.length ?? 0) > 0 ? `${stage.nextStages.length} перех.` : null,
  ].filter(Boolean);
  const dirty =
    goal !== (stage.goal ?? "") ||
    guidance !== (stage.guidance ?? "") ||
    stale !== (stage.staleTimeoutDays?.toString() ?? "") ||
    checkin !== (stage.checkinIntervalDays?.toString() ?? "") ||
    partnerWebhookUrl !== (stage.partnerWebhookUrl ?? "") ||
    partnerWebhookMode !== (stage.partnerWebhookMode ?? "fire_and_forget");

  async function save() {
    setSaving(true);
    try {
      await onUpdate({
        goal: goal.trim() || null,
        guidance: guidance.trim() || null,
        staleTimeoutDays: stale ? Number(stale) : null,
        checkinIntervalDays: checkin ? Number(checkin) : null,
        partnerWebhookUrl: partnerWebhookUrl.trim() || null,
        partnerWebhookMode,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  function toggleNext(slug: string, on: boolean) {
    const set = new Set(stage.nextStages ?? []);
    if (on) set.add(slug);
    else set.delete(slug);
    onUpdate({ nextStages: [...set] });
  }

  return (
    <div className="rounded-md border border-dashed">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2"
      >
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          ⚙ Поведение и логика
        </span>
        <span className="flex items-center gap-1.5">
          {!open &&
            summary.map((s) => (
              <Badge key={s} variant="outline" className="text-[10px] font-normal">
                {s}
              </Badge>
            ))}
          <ChevronDownIcon
            className={cn("size-4 text-muted-foreground transition-transform", open ? "rotate-180" : "")}
          />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 pb-3 pt-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">🎯 Цель (что достичь боту)</Label>
          <Textarea
            rows={2}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="выяснить сумму и сеть, подтвердить курс"
            className="text-sm resize-none"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">🧠 Поведение (тон, что можно/нельзя)</Label>
          <Textarea
            rows={2}
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="дружелюбно, не называй курс без инструмента"
            className="text-sm resize-none"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">⏰ Завис через</Label>
          <Input
            type="number"
            min={0}
            value={stale}
            onChange={(e) => setStale(e.target.value)}
            placeholder="—"
            className="h-7 w-16 text-sm"
          />
          <span className="text-xs text-muted-foreground">дн.</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">🔁 Автопинг каждые</Label>
          <Input
            type="number"
            min={0}
            value={checkin}
            onChange={(e) => setCheckin(e.target.value)}
            placeholder="—"
            className="h-7 w-16 text-sm"
          />
          <span className="text-xs text-muted-foreground">дн.</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Switch
            id={`auto-${stage.id}`}
            checked={autoAdvance}
            onCheckedChange={(v) => onUpdate({ autoAdvanceCondition: v ? AUTO_ADVANCE_FILLED : null })}
          />
          <Label htmlFor={`auto-${stage.id}`} className="text-xs text-muted-foreground">
            Авто-переход по полям
          </Label>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">🔀 Переходы дальше (next stages)</Label>
        <div className="flex flex-wrap gap-1.5">
          {allStages
            .filter((s) => s.id !== stage.id)
            .map((s) => {
              const on = (stage.nextStages ?? []).includes(s.slug);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleNext(s.slug, !on)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s.displayName}
                </button>
              );
            })}
        </div>
      </div>

      <details className="rounded-md border border-dashed bg-muted/20">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-medium marker:text-muted-foreground">
          <span>Внешняя передача</span>
          {partnerWebhookUrl ? (
            <Badge variant="outline" className="text-[10px] font-normal">
              настроено
            </Badge>
          ) : (
            <span className="text-xs font-normal text-muted-foreground">опционально</span>
          )}
        </summary>
        <div className="grid gap-2 border-t px-3 pb-3 pt-2.5 sm:grid-cols-[1fr_220px]">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Webhook / Telegram</Label>
            <Input
              value={partnerWebhookUrl}
              onChange={(e) => setPartnerWebhookUrl(e.target.value)}
              placeholder="https://provider.example/webhook или tg://123456789"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Режим ответа</Label>
            <Select
              value={partnerWebhookMode}
              onValueChange={(v) => setPartnerWebhookMode(v as typeof partnerWebhookMode)}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fire_and_forget">Отправить и продолжить</SelectItem>
                <SelectItem value="await_callback">Ждать callback</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </details>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? "…" : "Сохранить"}
        </Button>
        {saved && <span className="text-xs text-emerald-500">✓ сохранено</span>}
      </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field,
  onDelete,
  onEdit,
}: {
  field: StageField;
  onDelete: () => void;
  onEdit: (patch: Partial<StageField>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(field.displayName);
  const [type, setType] = useState<FieldType>(field.fieldType);
  const [required, setRequired] = useState(field.required);
  const [ai, setAi] = useState(field.aiExtractable);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onEdit({ displayName: name, fieldType: type, required, aiExtractable: ai });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 flex-wrap">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-6 w-32 text-xs px-1.5"
          autoFocus
        />
        <Select value={type} onValueChange={(v) => setType(v as FieldType)}>
          <SelectTrigger className="h-6 w-24 text-xs px-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="size-3" />
          обяз.
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} className="size-3" />
          AI
        </label>
        <button type="button" onClick={save} disabled={saving || !name} className="text-emerald-500 hover:text-emerald-400 transition-colors">
          <CheckIcon className="size-3.5" />
        </button>
        <button type="button" onClick={() => setEditing(false)} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-1.5 py-0.5 text-sm">
      <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
      <span className="font-medium">{field.displayName}</span>
      <span className="text-xs text-muted-foreground/60">·</span>
      <span className="text-xs text-muted-foreground">{field.fieldType}</span>
      {field.required && <span className="text-xs text-destructive font-bold">*</span>}
      {field.aiExtractable && (
        <Badge variant="secondary" className="text-[10px] px-1 py-0">AI</Badge>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-muted-foreground/40 hover:text-muted-foreground transition-colors ml-1"
      >
        <PencilIcon className="size-3" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="text-muted-foreground/40 hover:text-destructive transition-colors"
      >
        <Trash2Icon className="size-3" />
      </button>
    </div>
  );
}
