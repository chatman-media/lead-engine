import {
  DownloadIcon,
  KanbanIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  UploadIcon,
} from "lucide-react";
import React, { type DragEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ApiError,
  type ContactItem,
  clearToken,
  type FunnelData,
  type LeadListItem,
  type PhaseStats,
  saas,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { type FunnelPhase, groupStagesByPhase, PHASE_ACCENT, PHASE_LABEL } from "@/lib/phases";

const KIND_COLOR: Record<string, string> = {
  intake: "border-blue-300",
  active: "border-green-300",
  terminal_won: "border-emerald-400",
  terminal_lost: "border-red-300",
};

const STAGE_TYPE_RU: Record<string, string> = {
  form_fill: "Сбор данных",
  document_upload: "Загрузка документов",
  document_signature: "Подписание",
  external_approval: "Внешнее одобрение",
  payment: "Оплата",
  waiting: "Ожидание",
  interaction: "Встреча / звонок",
  assessment: "Оценка",
  milestone: "Контрольная точка",
};


export function SaasLeads() {
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Drag-and-drop state
  const [draggedLeadId, setDraggedLeadId] = useState<number | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<number | null>(null);

  // View mode
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  // -1 = вкладка «Все» (по умолчанию), иначе id стадии
  const [listStageId, setListStageId] = useState<number | null>(-1);

  // Lead search
  const [leadSearch, setLeadSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Outreach state
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [outreachText, setOutreachText] = useState("");
  const [outreachTarget, setOutreachTarget] = useState<"all" | "stage">("all");
  const [outreachStageSlug, setOutreachStageSlug] = useState("");
  const [outreachSending, setOutreachSending] = useState(false);
  const [outreachResult, setOutreachResult] = useState<{
    enqueued: number;
    skipped: number;
  } | null>(null);

  // Create lead dialog
  const [creating, setCreating] = useState(false);
  const [walking, setWalking] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>("");
  const [selectedStageId, setSelectedStageId] = useState<string>("");
  const [creatingLead, setCreatingLead] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phaseStats, setPhaseStats] = useState<PhaseStats | null>(null);

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
      .getPhaseStats()
      .then(setPhaseStats)
      .catch(() => {});
    Promise.all([saas.getFunnel(), saas.listLeads({ limit: 200 })])
      .then(([f, l]) => {
        setFunnel(f);
        setLeads(l.items);
        // auto-switch to list if many stages
        if (f.stages.length > 6) setViewMode("list");
        // листинг по умолчанию открывается на вкладке «Все» (listStageId=-1)
      })
      .catch((err) => {
        if (!onAuthError(err)) setError("Не удалось загрузить данные");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      saas
        .listContacts({ q: contactSearch, limit: 20 })
        .then((r) => setContacts(r.items))
        .catch(() => {});
    }, 250);
  }, [contactSearch]);

  async function handleCreateLead() {
    if (!selectedContactId) return;
    setCreatingLead(true);
    try {
      const result = await saas.createLead(
        Number(selectedContactId),
        selectedStageId ? Number(selectedStageId) : undefined,
      );
      setCreating(false);
      setContactSearch("");
      setSelectedContactId("");
      setSelectedStageId("");
      reload();
      navigate(`/leads/${result.id}`);
    } catch (err) {
      onAuthError(err);
    } finally {
      setCreatingLead(false);
    }
  }

  async function handleSendOutreach() {
    const text = outreachText.trim();
    if (!text) return;
    setOutreachSending(true);
    setOutreachResult(null);
    try {
      const body: Parameters<typeof saas.sendOutreach>[0] =
        outreachTarget === "stage" && outreachStageSlug
          ? { text, stageSlug: outreachStageSlug }
          : { text, leadIds: leads.map((l) => l.id) };
      const result = await saas.sendOutreach(body);
      setOutreachResult(result);
      setOutreachText("");
    } catch (err) {
      onAuthError(err);
    } finally {
      setOutreachSending(false);
    }
  }

  async function handleImportCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true);
    setImportResult(null);
    try {
      const res = await saas.importLeadsCsv(file);
      setImportResult(res);
      toast.success(`Импорт завершён: ${res.imported} лидов добавлено`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка импорта");
    } finally {
      setImporting(false);
    }
  }

  function handleLeadDrop(e: DragEvent, targetStageId: number) {
    e.preventDefault();
    if (!draggedLeadId) return;
    const lead = leads.find((l) => l.id === draggedLeadId);
    if (!lead || lead.stageDefinitionId === targetStageId) return;

    // Optimistic update
    setLeads((prev) =>
      prev.map((l) => (l.id === draggedLeadId ? { ...l, stageDefinitionId: targetStageId } : l)),
    );
    setDraggedLeadId(null);
    setDragOverStageId(null);

    saas.moveLeadStage(draggedLeadId, targetStageId).catch(() => reload());
  }

  if (loading)
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 flex-1 max-w-xs" />
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="flex gap-4 overflow-x-auto pb-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="min-w-[220px] space-y-2 rounded-lg border p-3">
              <Skeleton className="h-4 w-32" />
              {[0, 1, 2].map((j) => (
                <div key={j} className="rounded-md border p-2.5 space-y-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;

  // Группируем лидов по stageDefinitionId или state
  const stages = funnel?.stages ?? [];
  const leadsByStage = new Map<string, LeadListItem[]>();

  const q = leadSearch.trim().toLowerCase();
  const filteredLeads = q
    ? leads.filter((l) => (l.contactName ?? "").toLowerCase().includes(q))
    : leads;

  // legacy leads (no stageDefinitionId) → group by state
  const legacyLeads = filteredLeads.filter((l) => !l.stageDefinitionId);
  for (const lead of legacyLeads) {
    const key = `state:${lead.state}`;
    (leadsByStage.get(key) ?? leadsByStage.set(key, []).get(key))!.push(lead);
  }

  // dynamic leads → group by stageDefinitionId
  for (const lead of filteredLeads.filter((l) => l.stageDefinitionId)) {
    const key = `stage:${lead.stageDefinitionId}`;
    (leadsByStage.get(key) ?? leadsByStage.set(key, []).get(key))!.push(lead);
  }

  // Если воронки нет или стадий нет — показываем просто список
  const hasStages = stages.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <PageHeader
          title="Лиды"
          description={`${filteredLeads.length}${q ? ` из ${leads.length}` : ""} лидов · ${stages.length} стадий`}
        />
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Поиск по имени…"
              value={leadSearch}
              onChange={(e) => setLeadSearch(e.target.value)}
              className="h-8 pl-8 text-sm w-48"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={exporting || leads.length === 0}
            onClick={async () => {
              setExporting(true);
              try {
                await saas.exportLeadsCsv();
              } catch {
                /* ignore */
              } finally {
                setExporting(false);
              }
            }}
          >
            <DownloadIcon className="mr-1.5 size-3.5" />
            {exporting ? "Экспорт…" : "CSV ↓"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            <UploadIcon className="mr-1.5 size-3.5" />
            {importing ? "Импорт…" : "CSV ↑"}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleImportCsv}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOutreachOpen(true);
              setOutreachResult(null);
            }}
          >
            <SendIcon className="mr-1.5 size-3.5" />
            Рассылка
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={walking}
            onClick={async () => {
              setWalking(true);
              try {
                await saas.walkSim(1);
                reload();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setWalking(false);
              }
            }}
            title="Создать лида и провести по всей воронке (демо)"
          >
            {walking ? "…" : "▶ Прогон по воронке"}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setContacts([]);
              setContactSearch("");
            }}
          >
            <PlusIcon className="mr-1.5 size-3.5" />
            Новый лид
          </Button>
          {hasStages && (
            <div className="flex rounded-md border overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`px-2 py-1.5 text-xs flex items-center gap-1 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                title="Список"
              >
                <ListIcon className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("kanban")}
                className={`px-2 py-1.5 text-xs flex items-center gap-1 transition-colors border-l ${viewMode === "kanban" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                title="Канбан"
              >
                <KanbanIcon className="size-3.5" />
              </button>
            </div>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="/funnel">
              <SettingsIcon className="mr-1.5 size-3.5" />
              Воронка
            </Link>
          </Button>
        </div>
      </div>

      {/* CSV import result */}
      {importResult && (
        <div className="rounded-md border bg-muted px-4 py-3 text-sm flex items-center gap-4">
          <span>
            Импортировано:{" "}
            <span className="font-semibold text-green-600">{importResult.imported}</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            Пропущено:{" "}
            <span className="font-semibold text-muted-foreground">{importResult.skipped}</span>
          </span>
          {importResult.errors.length > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-destructive text-xs">
                {importResult.errors.slice(0, 3).join("; ")}
              </span>
            </>
          )}
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground text-xs"
            onClick={() => setImportResult(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Outreach — рассылка сообщений */}
      {outreachOpen && (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <SendIcon className="size-4" />
              Массовая рассылка
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Кому отправить</Label>
              <Select
                value={outreachTarget}
                onValueChange={(v) => setOutreachTarget(v as "all" | "stage")}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Всем загруженным лидам ({leads.length})</SelectItem>
                  <SelectItem value="stage">По стадии воронки</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {outreachTarget === "stage" && stages.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Стадия</Label>
                <Select value={outreachStageSlug} onValueChange={setOutreachStageSlug}>
                  <SelectTrigger className="text-sm">
                    <SelectValue placeholder="Выберите стадию…" />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => (
                      <SelectItem key={s.id} value={s.slug}>
                        {s.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Текст сообщения</Label>
              <Textarea
                placeholder="Введите текст сообщения…"
                value={outreachText}
                onChange={(e) => setOutreachText(e.target.value)}
                rows={4}
                className="text-sm resize-none"
              />
              <p className="text-xs text-muted-foreground text-right">{outreachText.length}/4000</p>
            </div>
            {outreachResult && (
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                Отправлено:{" "}
                <span className="font-medium text-green-600">{outreachResult.enqueued}</span>
                {" · "}
                Пропущено (нет канала):{" "}
                <span className="font-medium text-muted-foreground">{outreachResult.skipped}</span>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                disabled={
                  !outreachText.trim() ||
                  outreachText.length > 4000 ||
                  (outreachTarget === "stage" && !outreachStageSlug) ||
                  outreachSending
                }
                onClick={handleSendOutreach}
              >
                {outreachSending ? "Отправка…" : "Отправить"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOutreachOpen(false);
                  setOutreachResult(null);
                  setOutreachText("");
                }}
                disabled={outreachSending}
              >
                Закрыть
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Создать лида */}
      {creating && (
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Новый лид</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Контакт</Label>
              <Input
                placeholder="Поиск по имени…"
                value={contactSearch}
                onChange={(e) => {
                  setContactSearch(e.target.value);
                  setSelectedContactId("");
                }}
                className="text-sm"
              />
              {contacts.length > 0 && (
                <div className="rounded-md border bg-popover p-1 shadow-sm">
                  {contacts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${selectedContactId === String(c.id) ? "bg-accent font-medium" : ""}`}
                      onClick={() => {
                        setSelectedContactId(String(c.id));
                        setContactSearch(c.displayName ?? `#${c.id}`);
                      }}
                    >
                      {c.displayName ?? `Контакт #${c.id}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {stages.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Начальная стадия (опционально)</Label>
                <Select value={selectedStageId} onValueChange={setSelectedStageId}>
                  <SelectTrigger className="text-sm">
                    <SelectValue placeholder="Первая стадия воронки" />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                disabled={!selectedContactId || creatingLead}
                onClick={handleCreateLead}
              >
                {creatingLead ? "Создание…" : "Создать"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCreating(false)}
                disabled={creatingLead}
              >
                Отмена
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!hasStages && legacyLeads.length > 0 && (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          Воронка не настроена. Лиды сгруппированы по legacy-стадиям.{" "}
          <Link to="/funnel" className="text-primary underline">
            Настроить воронку →
          </Link>
        </div>
      )}

      {/* List view — вкладки стадий + вертикальный список */}
      {hasStages &&
        viewMode === "list" &&
        (() => {
          const isAll = (listStageId ?? -1) === -1;
          const recencyOf = (l: LeadListItem) => l.lastMessageAt ?? l.updatedAt ?? 0;
          const activeStage = isAll ? null : (stages.find((s) => s.id === listStageId) ?? stages[0]);
          const activeLeads = isAll
            ? [...filteredLeads].sort((a, b) => recencyOf(b) - recencyOf(a))
            : (leadsByStage.get(`stage:${activeStage?.id}`) ?? []);
          return (
            <div className="flex flex-col gap-3">
              {/* Stage tabs */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                <button
                  type="button"
                  onClick={() => setListStageId(-1)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                    isAll
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-transparent bg-muted text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  Все
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${isAll ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20"}`}
                  >
                    {filteredLeads.length}
                  </span>
                </button>
                {stages.map((stage) => {
                  const count = (leadsByStage.get(`stage:${stage.id}`) ?? []).length;
                  const isActive = stage.id === (listStageId ?? stages[0]?.id);
                  return (
                    <button
                      key={stage.id}
                      type="button"
                      onClick={() => setListStageId(stage.id)}
                      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-transparent bg-muted text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${KIND_COLOR[stage.kind]?.replace("border-", "bg-") ?? "bg-gray-300"}`}
                      />
                      {stage.displayName}
                      {count > 0 && (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${isActive ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20"}`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Stage info bar */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {isAll ? "Все лиды" : activeStage?.displayName}
                </span>
                {!isAll && activeStage && (
                  <>
                    <span>·</span>
                    <span>{STAGE_TYPE_RU[activeStage.stageType] ?? activeStage.stageType}</span>
                  </>
                )}
                <span>·</span>
                <span>{activeLeads.length} лидов</span>
              </div>

              {/* Leads list — плотные строки */}
              <div className="space-y-1.5">
                {activeLeads.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
                {activeLeads.length === 0 && (
                  <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    {isAll ? "Лидов пока нет" : "Нет лидов в этой стадии"}
                  </p>
                )}
              </div>
            </div>
          );
        })()}

      {/* Kanban — колонки сгруппированы по фазам костяка */}
      {hasStages && viewMode === "kanban" && (
        <>
          {phaseStats && phaseStats.phases.some((p) => p.leads > 0) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">Лиды по фазам:</span>
              {phaseStats.phases
                .filter((p) => p.leads > 0)
                .map((p) => (
                  <Badge key={p.phase} variant="secondary" className="gap-1.5">
                    <span
                      className={`size-2 rounded-full ${PHASE_ACCENT[p.phase as FunnelPhase] ?? "bg-gray-400"}`}
                    />
                    {PHASE_LABEL[p.phase as FunnelPhase] ?? p.phase}: {p.leads}
                  </Badge>
                ))}
              {phaseStats.unassigned > 0 && (
                <Badge variant="outline">Прочее: {phaseStats.unassigned}</Badge>
              )}
            </div>
          )}
          <div className="flex gap-6 overflow-x-auto pb-4">
            {groupStagesByPhase(stages).map((group) => (
              <div key={group.key} className="flex shrink-0 flex-col gap-2">
                <div className="flex items-center gap-2 px-1">
                  <span className={`size-2 rounded-full ${group.accent}`} />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                <div className="flex gap-4">
                  {group.stages.map((stage) => {
                    const stageLeads = leadsByStage.get(`stage:${stage.id}`) ?? [];
                    const isOver = dragOverStageId === stage.id;
                    return (
                      <div
                        key={stage.id}
                        className="flex w-72 shrink-0 flex-col gap-2"
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverStageId(stage.id);
                        }}
                        onDragLeave={() => setDragOverStageId(null)}
                        onDrop={(e) => handleLeadDrop(e, stage.id)}
                      >
                        <div
                          className={`flex items-center justify-between rounded-lg border-l-4 bg-card px-3 py-2 shadow-sm transition-colors ${KIND_COLOR[stage.kind] ?? "border-gray-300"} ${isOver ? "bg-accent" : ""}`}
                        >
                          <div>
                            <p className="text-sm font-semibold">{stage.displayName}</p>
                            <p className="text-xs text-muted-foreground">
                              {STAGE_TYPE_RU[stage.stageType] ?? stage.stageType}
                            </p>
                          </div>
                          <Badge variant="secondary" className="text-xs">
                            {stageLeads.length}
                          </Badge>
                        </div>

                        <div
                          className={`flex flex-col gap-2 rounded-lg transition-colors ${isOver ? "bg-accent/30 p-1" : ""}`}
                        >
                          {stageLeads.map((lead) => (
                            <LeadCard
                              key={lead.id}
                              lead={lead}
                              isDragging={draggedLeadId === lead.id}
                              onDragStart={() => setDraggedLeadId(lead.id)}
                              onDragEnd={() => {
                                setDraggedLeadId(null);
                                setDragOverStageId(null);
                              }}
                            />
                          ))}
                          {stageLeads.length === 0 && (
                            <p
                              className={`rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground ${isOver ? "border-primary" : ""}`}
                            >
                              {isOver ? "Перетащить сюда" : "Нет лидов"}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Fallback — таблица если нет воронки */}
      {!hasStages && (
        <div className="flex flex-col gap-2">
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} />
          ))}
          {leads.length === 0 && <p className="text-muted-foreground text-sm">Лидов пока нет.</p>}
        </div>
      )}
    </div>
  );
}

const SOURCE_SHORT: Record<string, string> = {
  bot: "Telegram",
  userbot: "Telegram",
  whatsapp: "WhatsApp",
  web: "Web",
  self_play: "SIM",
};

const DEFAULT_ACCENT = "#6366f1";

function leadView(lead: LeadListItem) {
  const accent = lead.stageColor || DEFAULT_ACCENT;
  const name = lead.contactName ?? `Контакт #${lead.contactId}`;
  const fields = (lead.keyFields ?? [])
    .map((f) => ({ label: f.label, value: parseFieldValue(f.value) }))
    .filter((f) => f.value);
  const total = lead.funnelStageCount ?? 0;
  const pos = lead.stagePosition ?? null;
  return {
    accent,
    name,
    fields,
    total,
    pos,
    awaiting: lead.stageType === "awaiting_operator",
    recency: relTime(lead.lastMessageAt ?? lead.updatedAt),
  };
}

function leadInitials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return (((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "#").slice(0, 2);
}

function LeadAvatar({ name, accent, size = 32 }: { name: string; accent: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: `${accent}1f`,
        color: accent,
        boxShadow: `inset 0 0 0 1px ${accent}55`,
      }}
    >
      {leadInitials(name)}
    </span>
  );
}

/** Сегментный индикатор воронки: точка на каждую стадию, пройденные — в цвете. */
function FunnelSteps({ pos, total, accent }: { pos: number; total: number; accent: string }) {
  if (total <= 0 || pos === null) return null;
  return (
    <div className="flex items-center gap-[3px]" title={`Этап ${pos + 1} из ${total}`}>
      {Array.from({ length: Math.min(total, 14) }).map((_, i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: accent, opacity: i <= pos ? 1 : 0.22 }}
        />
      ))}
    </div>
  );
}

function ChannelChip({ source }: { source?: string | null }) {
  if (!source) return null;
  return (
    <span className="text-[10px] font-medium text-muted-foreground">
      {SOURCE_SHORT[source] ?? source}
    </span>
  );
}

// ── Компактная карточка для канбана ──────────────────────────────────────────
function LeadCard({
  lead,
  isDragging,
  onDragStart,
  onDragEnd,
}: {
  lead: LeadListItem;
  isDragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const v = leadView(lead);
  const primary = v.fields[0];
  return (
    <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd} className={isDragging ? "opacity-40" : ""}>
      <Link to={`/leads/${lead.id}`} className="block">
        <div
          className="group rounded-lg border bg-card/60 p-2.5 transition-all hover:border-foreground/25 hover:bg-accent/30 hover:shadow-sm"
          style={{ borderLeft: `3px solid ${v.accent}` }}
        >
          <div className="flex items-center gap-2">
            <LeadAvatar name={v.name} accent={v.accent} size={30} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-semibold leading-tight">{v.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{v.recency}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <ChannelChip source={lead.source} />
                {v.awaiting && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400">
                    <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
                    ждёт
                  </span>
                )}
              </div>
            </div>
          </div>

          {primary && (
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{primary.label}</span>
              <span className="truncate font-mono text-[13px] font-semibold">{primary.value}</span>
            </div>
          )}

          {lead.lastMessageText && (
            <p className="mt-1.5 line-clamp-1 text-[11px] text-muted-foreground/80">{lead.lastMessageText}</p>
          )}

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate text-[10px] font-medium" style={{ color: v.accent }}>
              {lead.stageName ?? "—"}
            </span>
            <FunnelSteps pos={v.pos ?? -1} total={v.total} accent={v.accent} />
          </div>
        </div>
      </Link>
    </div>
  );
}

// ── Плотная строка для списка (горизонтальная, без пустот) ────────────────────
function LeadRow({ lead }: { lead: LeadListItem }) {
  const v = leadView(lead);
  return (
    <Link to={`/leads/${lead.id}`} className="block">
      <div
        className="group flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-2 transition-all hover:border-foreground/25 hover:bg-accent/30"
        style={{ borderLeft: `3px solid ${v.accent}` }}
      >
        <LeadAvatar name={v.name} accent={v.accent} size={34} />

        {/* Имя + канал */}
        <div className="w-40 min-w-0 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{v.name}</span>
            {v.awaiting && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />}
          </div>
          <ChannelChip source={lead.source} />
        </div>

        {/* Ключевые поля + последнее сообщение */}
        <div className="hidden min-w-0 flex-1 md:block">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {v.fields.slice(0, 3).map((f) => (
              <span key={f.label} className="text-[11px] text-muted-foreground">
                {f.label}: <span className="font-mono font-medium text-foreground">{f.value}</span>
              </span>
            ))}
          </div>
          {lead.lastMessageText && (
            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/70">{lead.lastMessageText}</p>
          )}
        </div>

        {/* Стадия + прогресс */}
        <div className="hidden w-44 shrink-0 flex-col items-end gap-1 lg:flex">
          <span className="truncate text-[11px] font-medium" style={{ color: v.accent }}>
            {lead.stageName ?? "—"}
          </span>
          <div className="flex items-center gap-1.5">
            <FunnelSteps pos={v.pos ?? -1} total={v.total} accent={v.accent} />
            {v.pos !== null && v.total > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {v.pos + 1}/{v.total}
              </span>
            )}
          </div>
        </div>

        <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
          {v.recency}
        </span>
      </div>
    </Link>
  );
}

/** value_json → читаемая строка для карточки. */
function parseFieldValue(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") return Object.values(v).join(" ");
    return String(v);
  } catch {
    return raw;
  }
}

/** Относительное время: «5м», «2ч», «3д», иначе дата. */
function relTime(epoch: number | null | undefined): string {
  if (!epoch) return "";
  const diff = Math.floor(Date.now() / 1000) - epoch;
  if (diff < 60) return "только что";
  if (diff < 3600) return `${Math.floor(diff / 60)}м`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}ч`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}д`;
  return new Date(epoch * 1000).toLocaleDateString("ru", { day: "2-digit", month: "2-digit" });
}
