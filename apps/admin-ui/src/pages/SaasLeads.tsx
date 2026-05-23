import { useEffect, useRef, useState } from "react";
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
import { PlusIcon, SettingsIcon } from "lucide-react";

const KIND_COLOR: Record<string, string> = {
  intake: "border-blue-300",
  active: "border-green-300",
  terminal_won: "border-emerald-400",
  terminal_lost: "border-red-300",
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

  if (loading) return <p className="p-6 text-muted-foreground text-sm">Загрузка…</p>;
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;

  // Группируем лидов по stageDefinitionId или state
  const stages = funnel?.stages ?? [];
  const leadsByStage = new Map<string, LeadListItem[]>();

  // legacy leads (no stageDefinitionId) → group by state
  const legacyLeads = leads.filter((l) => !l.stageDefinitionId);
  for (const lead of legacyLeads) {
    const key = `state:${lead.state}`;
    (leadsByStage.get(key) ?? leadsByStage.set(key, []).get(key))!.push(lead);
  }

  // dynamic leads → group by stageDefinitionId
  for (const lead of leads.filter((l) => l.stageDefinitionId)) {
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
          description={`${leads.length} лидов · ${stages.length} стадий в воронке`}
        />
        <div className="flex items-center gap-2">
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
            return (
              <div
                key={stage.id}
                className="flex w-72 shrink-0 flex-col gap-2"
              >
                <div
                  className={`flex items-center justify-between rounded-lg border-l-4 bg-card px-3 py-2 shadow-sm ${KIND_COLOR[stage.kind] ?? "border-gray-300"}`}
                >
                  <div>
                    <p className="text-sm font-semibold">{stage.displayName}</p>
                    <p className="text-xs text-muted-foreground capitalize">{stage.stageType.replace("_", " ")}</p>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {stageLeads.length}
                  </Badge>
                </div>

                <div className="flex flex-col gap-2">
                  {stageLeads.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} />
                  ))}
                  {stageLeads.length === 0 && (
                    <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                      Нет лидов
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

function LeadCard({ lead }: { lead: LeadListItem }) {
  const pct = progressPct(lead.requiredFieldsFilled, lead.requiredFieldsTotal);

  return (
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
              {lead.state}
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
  );
}
