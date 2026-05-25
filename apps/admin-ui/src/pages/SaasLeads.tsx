import React, { type DragEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, clearToken, saas, type ContactItem, type FunnelData, type LeadListItem } from "@/api/saas";
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
import { DownloadIcon, PlusIcon, SearchIcon, SendIcon, SettingsIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const STATE_RU: Record<string, string> = {
  active: "активен",
  won: "выигран",
  lost: "проигран",
  intake: "входящий",
  terminal_won: "закрыт ✓",
  terminal_lost: "закрыт ✗",
};

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

function progressPct(filled: number, total: number) {
  if (total === 0) return null;
  return Math.round((filled / total) * 100);
}

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
  });
}

export function SaasLeads() {
  const navigate = useNavigate();
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Drag-and-drop state
  const [draggedLeadId, setDraggedLeadId] = useState<number | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<number | null>(null);

  // Lead search
  const [leadSearch, setLeadSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Outreach state
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [outreachText, setOutreachText] = useState("");
  const [outreachTarget, setOutreachTarget] = useState<"all" | "stage">("all");
  const [outreachStageSlug, setOutreachStageSlug] = useState("");
  const [outreachSending, setOutreachSending] = useState(false);
  const [outreachResult, setOutreachResult] = useState<{ enqueued: number; skipped: number } | null>(null);

  // Create lead dialog
  const [creating, setCreating] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>("");
  const [selectedStageId, setSelectedStageId] = useState<string>("");
  const [creatingLead, setCreatingLead] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  function reload() {
    Promise.all([saas.getFunnel(), saas.listLeads({ limit: 200 })])
      .then(([f, l]) => {
        setFunnel(f);
        setLeads(l.items);
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
      saas.listContacts({ q: contactSearch, limit: 20 })
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
      prev.map((l) => l.id === draggedLeadId ? { ...l, stageDefinitionId: targetStageId } : l),
    );
    setDraggedLeadId(null);
    setDragOverStageId(null);

    saas.moveLeadStage(draggedLeadId, targetStageId).catch(() => reload());
  }

  if (loading) return (
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
              try { await saas.exportLeadsCsv(); } catch { /* ignore */ } finally { setExporting(false); }
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
            onClick={() => { setOutreachOpen(true); setOutreachResult(null); }}
          >
            <SendIcon className="mr-1.5 size-3.5" />
            Рассылка
          </Button>
          <Button size="sm" onClick={() => { setCreating(true); setContacts([]); setContactSearch(""); }}>
            <PlusIcon className="mr-1.5 size-3.5" />
            Новый лид
          </Button>
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
          <span>Импортировано: <span className="font-semibold text-green-600">{importResult.imported}</span></span>
          <span className="text-muted-foreground">·</span>
          <span>Пропущено: <span className="font-semibold text-muted-foreground">{importResult.skipped}</span></span>
          {importResult.errors.length > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-destructive text-xs">{importResult.errors.slice(0, 3).join("; ")}</span>
            </>
          )}
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground text-xs" onClick={() => setImportResult(null)}>✕</button>
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
                Отправлено: <span className="font-medium text-green-600">{outreachResult.enqueued}</span>
                {" · "}
                Пропущено (нет канала): <span className="font-medium text-muted-foreground">{outreachResult.skipped}</span>
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
                onClick={() => { setOutreachOpen(false); setOutreachResult(null); setOutreachText(""); }}
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
                onChange={(e) => { setContactSearch(e.target.value); setSelectedContactId(""); }}
                className="text-sm"
              />
              {contacts.length > 0 && (
                <div className="rounded-md border bg-popover p-1 shadow-sm">
                  {contacts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${selectedContactId === String(c.id) ? "bg-accent font-medium" : ""}`}
                      onClick={() => { setSelectedContactId(String(c.id)); setContactSearch(c.displayName ?? `#${c.id}`); }}
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

      {/* Kanban — горизонтальный скролл по стадиям */}
      {hasStages && (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {stages.map((stage) => {
            const stageLeads = leadsByStage.get(`stage:${stage.id}`) ?? [];
            const isOver = dragOverStageId === stage.id;
            return (
              <div
                key={stage.id}
                className="flex w-72 shrink-0 flex-col gap-2"
                onDragOver={(e) => { e.preventDefault(); setDragOverStageId(stage.id); }}
                onDragLeave={() => setDragOverStageId(null)}
                onDrop={(e) => handleLeadDrop(e, stage.id)}
              >
                <div
                  className={`flex items-center justify-between rounded-lg border-l-4 bg-card px-3 py-2 shadow-sm transition-colors ${KIND_COLOR[stage.kind] ?? "border-gray-300"} ${isOver ? "bg-accent" : ""}`}
                >
                  <div>
                    <p className="text-sm font-semibold">{stage.displayName}</p>
                    <p className="text-xs text-muted-foreground">{STAGE_TYPE_RU[stage.stageType] ?? stage.stageType}</p>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {stageLeads.length}
                  </Badge>
                </div>

                <div className={`flex flex-col gap-2 rounded-lg transition-colors ${isOver ? "bg-accent/30 p-1" : ""}`}>
                  {stageLeads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      isDragging={draggedLeadId === lead.id}
                      onDragStart={() => setDraggedLeadId(lead.id)}
                      onDragEnd={() => { setDraggedLeadId(null); setDragOverStageId(null); }}
                    />
                  ))}
                  {stageLeads.length === 0 && (
                    <p className={`rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground ${isOver ? "border-primary" : ""}`}>
                      {isOver ? "Перетащить сюда" : "Нет лидов"}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fallback — таблица если нет воронки */}
      {!hasStages && (
        <div className="flex flex-col gap-2">
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} />
          ))}
          {leads.length === 0 && (
            <p className="text-muted-foreground text-sm">Лидов пока нет.</p>
          )}
        </div>
      )}
    </div>
  );
}

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
  const pct = progressPct(lead.requiredFieldsFilled, lead.requiredFieldsTotal);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={isDragging ? "opacity-40" : ""}
    >
    <Link to={`/leads/${lead.id}`}>
      <Card className="cursor-pointer transition-colors hover:bg-accent/30">
        <CardHeader className="pb-1 pt-3">
          <CardTitle className="text-sm font-medium">
            {lead.contactName ?? `Контакт #${lead.contactId}`}
          </CardTitle>
          {lead.applicationId && (
            <p className="text-xs text-muted-foreground font-mono">{lead.applicationId}</p>
          )}
        </CardHeader>
        <CardContent className="pb-3">
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="text-xs">
              {STATE_RU[lead.state] ?? lead.state}
            </Badge>
            <span className="text-xs text-muted-foreground">{formatDate(lead.updatedAt)}</span>
          </div>

          {pct !== null && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-0.5">
                <span>Заполнено</span>
                <span>{pct}%</span>
              </div>
              <div className="h-1 w-full rounded-full bg-secondary">
                <div
                  className="h-1 rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
    </div>
  );
}
