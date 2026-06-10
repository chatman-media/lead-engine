import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  CheckIcon,
  EditIcon,
  HandshakeIcon,
  ListChecksIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  clearToken,
  type FunnelData,
  type LeadDetail,
  type LeadKbGuidance,
  type StageField,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const STAGE_TYPE_RU: Record<string, string> = {
  form_fill: "Сбор данных",
  document_upload: "Загрузка документов",
  document_signature: "Подписание",
  rate_confirmation: "Подтверждение курса",
  external_approval: "Внешнее одобрение",
  payment: "Оплата",
  waiting: "Ожидание",
  awaiting_operator: "Ожидание оператора",
  interaction: "Встреча / звонок",
  assessment: "Оценка",
  milestone: "Контрольная точка",
};

const KIND_RU: Record<string, string> = {
  intake: "входящий",
  active: "активный",
  terminal_won: "закрыт ✓",
  terminal_lost: "закрыт ✗",
};

const ORDER_STATUS: Record<string, { label: string; dot: string }> = {
  quote: { label: "котировка", dot: "bg-muted-foreground/40" },
  awaiting_payment: { label: "ждёт оплаты", dot: "bg-amber-400" },
  paid: { label: "оплачено", dot: "bg-blue-400" },
  payout: { label: "выдача", dot: "bg-blue-400" },
  completed: { label: "завершено", dot: "bg-emerald-500" },
  cancelled: { label: "отменено", dot: "bg-red-400" },
  expired: { label: "просрочено", dot: "bg-muted-foreground/40" },
};

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseValue(valueJson: string): unknown {
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

function renderFieldValue(field: StageField, valueJson: string): string {
  try {
    const v = JSON.parse(valueJson);
    if (v === null || v === undefined || v === "") return "—";
    if (field.fieldType === "boolean") return v ? "Да" : "Нет";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  } catch {
    return valueJson;
  }
}

function marketplaceSourceLabel(notes: string | null | undefined): string | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as { source?: string };
    if (parsed.source === "provider_marketplace") return "Marketplace";
    if (parsed.source === "provider_marketplace_custom") return "Custom provider";
  } catch {
    return null;
  }
  return null;
}

interface FieldEditorProps {
  field: StageField;
  initialJson: string;
  onChange: (value: unknown) => void;
}

function FieldEditor({ field, initialJson, onChange }: FieldEditorProps) {
  const initial = parseValue(initialJson);
  const [val, setVal] = useState<unknown>(initial);

  function update(v: unknown) {
    setVal(v);
    onChange(v);
  }

  if (field.fieldType === "boolean") {
    return <Switch checked={Boolean(val)} onCheckedChange={(checked) => update(checked)} />;
  }

  if (field.fieldType === "select") {
    let options: Array<{ value: string; label: string }> = [];
    try {
      options = JSON.parse(field.optionsJson) as typeof options;
    } catch {
      // ignore
    }
    return (
      <Select value={String(val ?? "")} onValueChange={(v) => update(v)}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder="Выбрать…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (field.fieldType === "multiselect") {
    let options: Array<{ value: string; label: string }> = [];
    try {
      options = JSON.parse(field.optionsJson) as typeof options;
    } catch {
      // ignore
    }
    const selected: string[] = Array.isArray(val) ? (val as string[]) : [];
    return (
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                const next = active
                  ? selected.filter((v) => v !== opt.value)
                  : [...selected, opt.value];
                update(next);
              }}
              className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted-foreground/30 text-muted-foreground hover:border-foreground"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (field.fieldType === "textarea") {
    return (
      <Textarea
        value={String(val ?? "")}
        onChange={(e) => update(e.target.value)}
        className="min-h-[60px] resize-none text-sm"
      />
    );
  }

  if (field.fieldType === "number") {
    return (
      <Input
        type="number"
        value={val === null || val === undefined ? "" : String(val)}
        onChange={(e) => update(e.target.value === "" ? null : Number(e.target.value))}
        className="h-8 text-sm"
      />
    );
  }

  if (field.fieldType === "date") {
    const dateStr = val ? new Date(String(val)).toISOString().slice(0, 10) : "";
    return (
      <Input
        type="date"
        value={dateStr}
        onChange={(e) => update(e.target.value || null)}
        className="h-8 text-sm"
      />
    );
  }

  if (field.fieldType === "file" || field.fieldType === "photo" || field.fieldType === "video") {
    return (
      <span className="text-xs text-muted-foreground italic">
        {renderFieldValue(field, JSON.stringify(val))}
      </span>
    );
  }

  // text, phone, email
  return (
    <Input
      type={field.fieldType === "email" ? "email" : field.fieldType === "phone" ? "tel" : "text"}
      value={String(val ?? "")}
      onChange={(e) => update(e.target.value)}
      className="h-8 text-sm"
      placeholder={field.hint ?? undefined}
    />
  );
}

export function SaasLeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<LeadDetail | null>(null);
  const [kbGuidance, setKbGuidance] = useState<LeadKbGuidance | null>(null);
  const [kbGuidanceLoading, setKbGuidanceLoading] = useState(false);
  const [kbGuidanceError, setKbGuidanceError] = useState("");
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [recentMessages, setRecentMessages] = useState<import("@/api/saas").MessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Stage move state
  const [movingStage, setMovingStage] = useState(false);
  const [advancingLead, setAdvancingLead] = useState(false);

  // Field editing state
  const [editing, setEditing] = useState(false);
  const [fieldEdits, setFieldEdits] = useState<Record<number, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Delete state
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Send-photo (QR) state
  const [photoRef, setPhotoRef] = useState("");
  const [photoCaption, setPhotoCaption] = useState("");
  const [sendingPhoto, setSendingPhoto] = useState(false);
  const [photoMsg, setPhotoMsg] = useState("");

  // Send-offer state (concierge: оператор шлёт гостю оффер, AI продолжает вести)
  const [offerText, setOfferText] = useState("");
  const [sendingOffer, setSendingOffer] = useState(false);
  const [offerMsg, setOfferMsg] = useState("");

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  function reload() {
    if (!id) return;
    saas
      .getLead(Number(id))
      .then(setData)
      .catch((err) => {
        if (!onAuthError(err)) setError("Не удалось загрузить лида");
      })
      .finally(() => setLoading(false));
    reloadKbGuidance();
  }

  function reloadKbGuidance() {
    if (!id) return;
    setKbGuidanceLoading(true);
    setKbGuidanceError("");
    saas
      .getLeadKbGuidance(Number(id))
      .then(setKbGuidance)
      .catch((err) => {
        if (!onAuthError(err)) setKbGuidanceError("Не удалось загрузить подсказки");
      })
      .finally(() => setKbGuidanceLoading(false));
  }

  useEffect(() => {
    reload();
    saas
      .getFunnel()
      .then(setFunnel)
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!data?.contact) return;
    saas
      .listConversations({ contactId: data.contact.id, limit: 1 })
      .then((r) => {
        const cid = r.items[0]?.id ?? null;
        setConversationId(cid);
        if (cid) {
          saas
            .getConversation(cid)
            .then((d) => setRecentMessages(d.messages))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [data?.contact?.id]);

  async function handleAddNote() {
    if (!id || !noteText.trim()) return;
    setAddingNote(true);
    try {
      await saas.addLeadNote(Number(id), noteText.trim());
      setNoteText("");
      reload();
    } catch (err) {
      onAuthError(err);
    } finally {
      setAddingNote(false);
    }
  }

  async function handleSendPhoto() {
    if (!id || !photoRef.trim()) return;
    setSendingPhoto(true);
    setPhotoMsg("");
    try {
      await saas.sendLeadPhoto(Number(id), photoRef.trim(), photoCaption.trim() || undefined);
      setPhotoRef("");
      setPhotoCaption("");
      setPhotoMsg("Отправлено клиенту ✓");
    } catch (err) {
      if (!onAuthError(err)) {
        setPhotoMsg(err instanceof Error ? err.message : "Не удалось отправить");
      }
    } finally {
      setSendingPhoto(false);
    }
  }

  // Составить текст оффера из заполненных полей текущей стадии (без boolean-флагов).
  function composeOfferFromFields(): string {
    if (!data) return "";
    const parts: string[] = [];
    for (const f of data.fields) {
      if (f.fieldType === "boolean") continue;
      let raw = fieldEdits[f.id];
      if (raw === undefined) {
        const vj = data.fieldValues.find((v) => v.fieldId === f.id)?.valueJson;
        try {
          raw = vj ? JSON.parse(vj) : null;
        } catch {
          raw = null;
        }
      }
      if (raw === null || raw === undefined || raw === "") continue;
      parts.push(`${f.displayName}: ${String(raw)}`);
    }
    return parts.length ? `${parts.join(", ")}. Подтвердить?` : "";
  }

  async function handleSendOffer() {
    if (!id || !offerText.trim()) return;
    setSendingOffer(true);
    setOfferMsg("");
    try {
      await saas.sendLeadOffer(Number(id), offerText.trim());
      setOfferMsg("Отправлено гостю ✓ — AI продолжает вести");
    } catch (err) {
      if (!onAuthError(err)) {
        setOfferMsg(err instanceof Error ? err.message : "Не удалось отправить");
      }
    } finally {
      setSendingOffer(false);
    }
  }

  function startEditing() {
    if (!data) return;
    const initial: Record<number, unknown> = {};
    for (const field of data.fields) {
      const vJson = data.fieldValues.find((v) => v.fieldId === field.id)?.valueJson ?? "null";
      try {
        initial[field.id] = JSON.parse(vJson);
      } catch {
        initial[field.id] = vJson;
      }
    }
    setFieldEdits(initial);
    setEditing(true);
    setSaveMsg("");
  }

  function cancelEditing() {
    setEditing(false);
    setFieldEdits({});
    setSaveMsg("");
  }

  async function handleDelete() {
    if (!id) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await saas.deleteLead(Number(id));
      navigate("/leads", { replace: true });
    } catch (err) {
      onAuthError(err);
      setDeleting(false);
    }
  }

  async function handleSave() {
    if (!id || !data) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const values = data.fields
        .filter((f) => f.fieldType !== "file" && f.fieldType !== "photo")
        .map((f) => ({ fieldId: f.id, value: fieldEdits[f.id] ?? null }));
      const res = await saas.upsertLeadFieldValues(Number(id), values);
      if (res.advanced && res.newStageSlug) {
        setSaveMsg(`✓ Сохранено · автопродвижение → ${res.newStageSlug}`);
      } else {
        setSaveMsg("✓ Сохранено");
      }
      setEditing(false);
      reload();
    } catch (err) {
      onAuthError(err);
      setSaveMsg("Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return (
      <div className="flex flex-col gap-6 p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8" />
          <div className="space-y-1">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="rounded-lg border p-4 space-y-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-6 w-32" />
            </div>
            <div className="rounded-lg border p-4 space-y-3">
              <Skeleton className="h-4 w-24" />
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="py-2 space-y-1">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-2">
              <Skeleton className="h-4 w-24" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex justify-between">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-28" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;
  if (!data) return null;

  const { lead, stageDef, fields, fieldValues, events, notes, contact } = data;

  const valueMap = new Map(fieldValues.map((v) => [v.fieldId, v.valueJson]));

  const editableFields = fields.filter((f) => f.fieldType !== "file" && f.fieldType !== "photo");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/leads">
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <PageHeader
          title={contact?.displayName ?? `Лид #${lead.id}`}
          description={lead.applicationId ? `ID: ${lead.applicationId}` : undefined}
        />
        <div className="ml-auto">
          {confirmDelete ? (
            <div className="flex items-center gap-1 text-sm">
              <AlertTriangleIcon className="size-3.5 text-destructive shrink-0" />
              <span className="text-destructive text-xs">Удалить лида?</span>
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
                Да
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Нет
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={deleting}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Сводка: сумма переведённого + последние сообщения (в первую очередь) */}
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="overflow-hidden">
          <CardContent className="flex h-full flex-col gap-2 py-4">
            <div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Переведено всего
              </span>
              <div className="font-mono text-3xl font-semibold leading-none">
                {(data.transferredThb ?? 0).toLocaleString("ru")}{" "}
                <span className="text-base text-muted-foreground">THB</span>
              </div>
              <span className="text-xs text-muted-foreground">
                завершённых сделок: {data.ordersCompleted ?? 0}
              </span>
            </div>

            {(data.orders ?? []).length > 0 && (
              <div className="mt-1 space-y-1 border-t pt-2">
                {(data.orders ?? []).slice(0, 6).map((o) => (
                  <div key={o.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate">
                      <span className="font-mono font-medium">
                        {Math.round(Number(o.amountFrom ?? 0))} {o.assetFrom?.toUpperCase()}
                      </span>
                      <span className="text-muted-foreground">
                        {" → "}
                        {Math.round(Number(o.amountToThb ?? 0)).toLocaleString("ru")} ฿
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`size-1.5 rounded-full ${ORDER_STATUS[o.status]?.dot ?? "bg-muted-foreground/40"}`}
                      />
                      <span className="text-muted-foreground">
                        {ORDER_STATUS[o.status]?.label ?? o.status}
                      </span>
                    </span>
                  </div>
                ))}
                {(data.orders ?? []).length > 6 && (
                  <p className="text-[10px] text-muted-foreground">
                    и ещё {(data.orders ?? []).length - 6}…
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between py-2.5">
            <CardTitle className="text-sm">Последние сообщения</CardTitle>
            {conversationId !== null && (
              <Link
                to={`/conversations/${conversationId}`}
                className="text-xs text-primary hover:underline"
              >
                открыть диалог →
              </Link>
            )}
          </CardHeader>
          <CardContent className="space-y-1.5 pb-3">
            {recentMessages.length === 0 && (
              <p className="text-xs text-muted-foreground">Сообщений пока нет</p>
            )}
            {recentMessages.slice(-5).map((m) => (
              <div key={m.id} className="flex gap-2 text-[13px]">
                <span
                  className={`mt-0.5 w-12 shrink-0 text-[10px] font-medium uppercase ${
                    m.role === "user"
                      ? "text-foreground"
                      : m.role === "human"
                        ? "text-amber-400"
                        : "text-primary"
                  }`}
                >
                  {m.role === "user" ? "клиент" : m.role === "human" ? "оператор" : "бот"}
                </span>
                <span className="min-w-0 flex-1 break-words text-muted-foreground">{m.text}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Pipeline stepper */}
      {funnel?.stages && funnel.stages.length > 0 && (
        <PipelineStepper
          stages={funnel.stages}
          currentStageId={lead.stageDefinitionId ?? null}
          movingStage={movingStage}
          onMove={async (stageId) => {
            setMovingStage(true);
            try {
              await saas.moveLeadStage(Number(id), stageId);
              reload();
            } catch (err) {
              onAuthError(err);
            } finally {
              setMovingStage(false);
            }
          }}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Основная колонка */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Текущая стадия — инфо */}
          {(stageDef || lead.rejectedReason) && (
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-3">
                  <Badge variant="secondary" className="text-sm">
                    {stageDef?.displayName ?? KIND_RU[lead.state] ?? lead.state}
                  </Badge>
                  {stageDef && (
                    <span className="text-xs text-muted-foreground">
                      {STAGE_TYPE_RU[stageDef.stageType] ?? stageDef.stageType}
                    </span>
                  )}
                  {stageDef && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      disabled={advancingLead}
                      onClick={async () => {
                        setAdvancingLead(true);
                        setError("");
                        try {
                          await saas.advanceLead(Number(id));
                          reload();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setAdvancingLead(false);
                        }
                      }}
                    >
                      {advancingLead ? "…" : "✅ Подтвердить · дальше"}
                    </Button>
                  )}
                </div>
                {lead.rejectedReason && (
                  <p className="mt-2 text-sm text-destructive">
                    Причина отказа: {lead.rejectedReason}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {(data.partnerDeals ?? []).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <HandshakeIcon className="size-4 text-muted-foreground" />
                  Партнёрские сделки
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {(data.partnerDeals ?? []).map((deal) => {
                  const sourceLabel = marketplaceSourceLabel(deal.partnerServiceNotes);
                  return (
                    <div key={deal.id} className="rounded-md border p-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          #{deal.id} · {deal.partnerName ?? "Партнёр не выбран"}
                        </span>
                        <div className="flex items-center gap-2">
                          {sourceLabel && <Badge variant="secondary">{sourceLabel}</Badge>}
                          <Badge variant={deal.status === "completed" ? "secondary" : "outline"}>
                            {deal.status}
                          </Badge>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {deal.serviceName ?? "Услуга"} · {deal.handoffUrl ?? "ручная сделка"} ·{" "}
                        {deal.handoffMode}
                      </div>
                      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                        <span>
                          Оборот:{" "}
                          {deal.grossAmount == null
                            ? "—"
                            : `${Number(deal.grossAmount).toLocaleString("ru")} ${deal.currency}`}
                        </span>
                        <span>Комиссия: {deal.commissionPct}%</span>
                        <span>
                          {deal.commissionAmount == null
                            ? "—"
                            : `${Number(deal.commissionAmount).toLocaleString("ru")} ${deal.currency}`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Сообщить гостю оффер (concierge — оператор вписал цену/время) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Сообщить гостю (оффер)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => setOfferText(composeOfferFromFields())}
              >
                Составить из полей
              </Button>
              <Textarea
                value={offerText}
                onChange={(e) => setOfferText(e.target.value)}
                placeholder="Например: Трансфер: 800 THB, подача в 9:00. Подтвердить?"
                rows={3}
                className="text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!offerText.trim() || sendingOffer}
                  onClick={handleSendOffer}
                >
                  <SendIcon className="size-3.5 mr-1" />
                  {sendingOffer ? "Отправка…" : "Отправить гостю"}
                </Button>
                {offerMsg && <span className="text-xs text-muted-foreground">{offerMsg}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                Отправит гостю текст в его канал. AI продолжает вести — когда гость подтвердит
                («да»), стадия двинется автоматически.
              </p>
            </CardContent>
          </Card>

          {/* Отправить QR / фото клиенту */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Отправить QR / фото клиенту</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input
                value={photoRef}
                onChange={(e) => setPhotoRef(e.target.value)}
                placeholder="Ссылка на изображение (https://…) или Telegram file_id"
                className="h-8 text-sm"
              />
              <Input
                value={photoCaption}
                onChange={(e) => setPhotoCaption(e.target.value)}
                placeholder="Подпись (необязательно)"
                className="h-8 text-sm"
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!photoRef.trim() || sendingPhoto}
                  onClick={handleSendPhoto}
                >
                  <SendIcon className="size-3.5 mr-1" />
                  {sendingPhoto ? "Отправка…" : "Отправить клиенту"}
                </Button>
                {photoMsg && <span className="text-xs text-muted-foreground">{photoMsg}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                Бот отправит изображение клиенту в его канал. Для обменок — cardless-withdrawal QR
                для снятия THB.
              </p>
            </CardContent>
          </Card>

          {/* Поля стадии */}
          {fields.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Данные · {stageDef?.displayName}</CardTitle>
                  <div className="flex items-center gap-2">
                    {saveMsg && <span className="text-xs text-muted-foreground">{saveMsg}</span>}
                    {editing ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={cancelEditing}
                          disabled={saving}
                        >
                          <XIcon className="size-3 mr-1" />
                          Отмена
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleSave}
                          disabled={saving}
                        >
                          <CheckIcon className="size-3 mr-1" />
                          {saving ? "Сохранение…" : "Сохранить"}
                        </Button>
                      </>
                    ) : (
                      editableFields.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={startEditing}
                        >
                          <EditIcon className="size-3 mr-1" />
                          Редактировать
                        </Button>
                      )
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="divide-y">
                  {fields.map((field) => (
                    <div key={field.id} className="flex flex-col gap-1.5 py-2.5">
                      <div className="flex items-center gap-1">
                        <Label className="text-xs text-muted-foreground">{field.displayName}</Label>
                        {field.required && <span className="text-destructive text-xs">*</span>}
                        {field.aiExtractable && <span className="text-xs text-primary/60">✦</span>}
                      </div>
                      {editing && field.fieldType !== "file" && field.fieldType !== "photo" ? (
                        <FieldEditor
                          field={field}
                          initialJson={valueMap.get(field.id) ?? "null"}
                          onChange={(v) => setFieldEdits((prev) => ({ ...prev, [field.id]: v }))}
                        />
                      ) : (
                        <span className="text-sm font-medium">
                          {renderFieldValue(field, valueMap.get(field.id) ?? "null")}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* История переходов */}
          {events.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">История стадий</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2">
                  {events.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-2 text-sm">
                      <span className="text-xs text-muted-foreground w-32 shrink-0">
                        {formatDate(ev.createdAt)}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {ev.fromState && (
                          <>
                            <Badge variant="outline" className="text-xs">
                              {ev.fromState}
                            </Badge>
                            <span className="text-muted-foreground">→</span>
                          </>
                        )}
                        <Badge variant="secondary" className="text-xs">
                          {ev.toState}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Правая колонка */}
        <div className="flex flex-col gap-4">
          <LeadKbGuidanceCard
            guidance={kbGuidance}
            loading={kbGuidanceLoading}
            error={kbGuidanceError}
            onRefresh={reloadKbGuidance}
          />

          {/* Мета-инфо */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Информация</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Создан</span>
                <span>{formatDate(lead.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Обновлён</span>
                <span>{formatDate(lead.updatedAt)}</span>
              </div>
              {contact?.displayName && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Контакт</span>
                  <span>{contact.displayName}</span>
                </div>
              )}
              {conversationId !== null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Диалог</span>
                  <Link
                    to={`/conversations/${conversationId}`}
                    className="text-primary underline text-sm"
                  >
                    Открыть →
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Заметки */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Заметки</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {notes.map((note) => (
                <div key={note.id} className="rounded-md bg-muted/50 p-2.5 text-sm">
                  <p>{note.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDate(note.createdAt)}</p>
                </div>
              ))}
              {notes.length === 0 && (
                <p className="text-xs text-muted-foreground">Заметок пока нет.</p>
              )}

              <div className="flex gap-2 pt-1">
                <Textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Добавить заметку…"
                  className="min-h-[60px] resize-none text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      handleAddNote();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleAddNote}
                  disabled={addingNote || !noteText.trim()}
                  className="self-end"
                >
                  <SendIcon className="size-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function kbScopeLabel(scopeType: LeadKbGuidance["hits"][number]["scopeType"]) {
  if (scopeType === "stage") return "стадия";
  if (scopeType === "funnel") return "воронка";
  return "общая";
}

function LeadKbGuidanceCard({
  guidance,
  loading,
  error,
  onRefresh,
}: {
  guidance: LeadKbGuidance | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const totalRequired = guidance?.requiredFields.length ?? 0;
  const filledRequired = guidance?.requiredFields.filter((field) => field.filled).length ?? 0;
  const firstHits = guidance?.hits.slice(0, 3) ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpenIcon className="size-4 text-muted-foreground" />
          Подсказки из БЗ
        </CardTitle>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={onRefresh}
          disabled={loading}
          title="Обновить"
        >
          <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !guidance && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {guidance && (
          <>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Обязательные поля</span>
                <Badge variant={filledRequired === totalRequired ? "secondary" : "outline"}>
                  {filledRequired}/{totalRequired}
                </Badge>
              </div>
              {guidance.missingRequiredFields.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {guidance.missingRequiredFields.map((field) => (
                    <Badge key={field.id} variant="outline" className="max-w-full truncate">
                      {field.displayName}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Все обязательные поля текущей стадии заполнены
                </p>
              )}
            </div>

            {guidance.warning && (
              <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                {guidance.warning}
              </div>
            )}

            {guidance.nextActions.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <ListChecksIcon className="size-3.5 text-muted-foreground" />
                  Что сделать
                </div>
                <div className="space-y-1.5">
                  {guidance.nextActions.map((action) => (
                    <div key={action} className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                      {action}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">Фрагменты БЗ</span>
                {guidance.stage && (
                  <Badge variant="secondary" className="max-w-[140px] truncate">
                    {guidance.stage.displayName}
                  </Badge>
                )}
              </div>
              {firstHits.length > 0 ? (
                <div className="space-y-2">
                  {firstHits.map((hit) => (
                    <div key={hit.chunkId} className="rounded-md border p-2 text-xs">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{hit.title}</span>
                        <Badge variant="outline" className="shrink-0">
                          {kbScopeLabel(hit.scopeType)}
                        </Badge>
                      </div>
                      <p className="max-h-16 overflow-hidden text-muted-foreground leading-relaxed">
                        {hit.text}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Подходящих фрагментов для текущей стадии пока нет.
                </p>
              )}
            </div>

            <Link to="/admin/faq" className="inline-flex text-xs text-primary hover:underline">
              Открыть базу знаний →
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PipelineStepper({
  stages,
  currentStageId,
  movingStage,
  onMove,
}: {
  stages: { id: number; displayName: string; kind: string; stageType: string }[];
  currentStageId: number | null;
  movingStage: boolean;
  onMove: (stageId: number) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<number | null>(null);
  const currentIdx = stages.findIndex((s) => s.id === currentStageId);

  async function handleClick(stageId: number) {
    if (stageId === currentStageId || movingStage) return;
    setPendingId(stageId);
    await onMove(stageId);
    setPendingId(null);
  }

  const total = stages.length;
  const donePct = currentIdx >= 0 ? Math.round(((currentIdx + 1) / total) * 100) : 0;

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Пайплайн · клик по стадии — перевести лида</p>
        <span className="text-xs font-medium">
          Пройдено <span className="text-foreground">{Math.max(currentIdx + 1, 0)}</span>/{total}
          <span className="ml-1 text-muted-foreground">· {donePct}%</span>
        </span>
      </div>
      <div className="flex items-stretch overflow-x-auto pb-1 scrollbar-none">
        {stages.map((stage, idx) => {
          const isCurrent = stage.id === currentStageId;
          const isPast = currentIdx >= 0 && idx < currentIdx;
          const isDone = isPast; // пройдено
          const reached = currentIdx >= 0 && idx <= currentIdx;
          const isPending = pendingId === stage.id;
          const isTerminalWon = stage.kind === "terminal_won";

          return (
            <button
              key={stage.id}
              type="button"
              disabled={movingStage}
              onClick={() => handleClick(stage.id)}
              title={stage.displayName}
              className={`group relative flex min-w-[84px] flex-1 shrink-0 flex-col items-center gap-1.5 px-1 ${
                isCurrent
                  ? "cursor-default"
                  : movingStage
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer"
              }`}
            >
              {/* connector behind the node */}
              {idx > 0 && (
                <span
                  className={`absolute left-0 top-[11px] h-[2px] w-1/2 -translate-x-1/2 ${
                    reached ? "bg-emerald-500/70" : "bg-muted-foreground/15"
                  }`}
                />
              )}
              {idx < total - 1 && (
                <span
                  className={`absolute right-0 top-[11px] h-[2px] w-1/2 translate-x-1/2 ${
                    isPast ? "bg-emerald-500/70" : "bg-muted-foreground/15"
                  }`}
                />
              )}
              <span
                className={`relative z-10 flex size-6 items-center justify-center rounded-full text-[11px] font-semibold transition-all ${
                  isCurrent
                    ? `ring-2 ring-offset-2 ring-offset-card ${isTerminalWon ? "bg-emerald-500 text-white ring-emerald-500" : "bg-primary text-primary-foreground ring-primary"} ${!movingStage ? "animate-pulse" : ""}`
                    : isDone
                      ? "bg-emerald-500/90 text-white"
                      : isPending
                        ? "bg-primary/20 text-primary animate-pulse"
                        : "bg-muted text-muted-foreground/60 group-hover:bg-muted-foreground/20"
                }`}
              >
                {isDone ? <CheckIcon className="size-3.5" /> : idx + 1}
              </span>
              <span
                className={`max-w-[88px] overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] leading-tight ${
                  isCurrent
                    ? "font-semibold text-foreground"
                    : isDone
                      ? "text-foreground/70"
                      : "text-muted-foreground/60"
                }`}
              >
                {stage.displayName}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
