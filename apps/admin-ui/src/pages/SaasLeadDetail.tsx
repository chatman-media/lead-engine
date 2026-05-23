import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, clearToken, saas, type FunnelData, type LeadDetail, type StageField } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeftIcon, CheckIcon, EditIcon, RefreshCwIcon, SendIcon, XIcon } from "lucide-react";

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
    return (
      <Switch
        checked={Boolean(val)}
        onCheckedChange={(checked) => update(checked)}
      />
    );
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
    const dateStr = val
      ? new Date(String(val)).toISOString().slice(0, 10)
      : "";
    return (
      <Input
        type="date"
        value={dateStr}
        onChange={(e) => update(e.target.value || null)}
        className="h-8 text-sm"
      />
    );
  }

  if (field.fieldType === "file" || field.fieldType === "photo") {
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
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Stage change state
  const [stageChanging, setStageChanging] = useState(false);
  const [selectedStageId, setSelectedStageId] = useState<string>("");
  const [movingStage, setMovingStage] = useState(false);

  // Field editing state
  const [editing, setEditing] = useState(false);
  const [fieldEdits, setFieldEdits] = useState<Record<number, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

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
  }

  useEffect(() => {
    reload();
    saas.getFunnel().then(setFunnel).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!data?.contact) return;
    saas.listConversations({ contactId: data.contact.id, limit: 1 })
      .then((r) => setConversationId(r.items[0]?.id ?? null))
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

  async function handleMoveStage() {
    if (!id || !selectedStageId) return;
    setMovingStage(true);
    try {
      await saas.moveLeadStage(Number(id), Number(selectedStageId));
      setStageChanging(false);
      setSelectedStageId("");
      reload();
    } catch (err) {
      onAuthError(err);
    } finally {
      setMovingStage(false);
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

  if (loading) return <p className="p-6 text-muted-foreground text-sm">Загрузка…</p>;
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;
  if (!data) return null;

  const { lead, stageDef, fields, fieldValues, events, notes, contact } = data;

  const valueMap = new Map(fieldValues.map((v) => [v.fieldId, v.valueJson]));

  const editableFields = fields.filter(
    (f) => f.fieldType !== "file" && f.fieldType !== "photo",
  );

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
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Основная колонка */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Текущая стадия */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Текущая стадия</CardTitle>
                {funnel?.stages && funnel.stages.length > 0 && !stageChanging && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setSelectedStageId(String(lead.stageDefinitionId ?? ""));
                      setStageChanging(true);
                    }}
                  >
                    <RefreshCwIcon className="size-3 mr-1" />
                    Сменить стадию
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="text-sm">
                  {stageDef?.displayName ?? lead.state}
                </Badge>
                {stageDef && (
                  <span className="text-xs text-muted-foreground capitalize">
                    {stageDef.stageType.replace("_", " ")}
                  </span>
                )}
              </div>
              {lead.rejectedReason && (
                <p className="mt-2 text-sm text-destructive">
                  Причина отказа: {lead.rejectedReason}
                </p>
              )}
              {stageChanging && funnel?.stages && (
                <div className="mt-3 flex items-center gap-2">
                  <Select value={selectedStageId} onValueChange={setSelectedStageId}>
                    <SelectTrigger className="h-8 text-sm flex-1">
                      <SelectValue placeholder="Выбрать стадию…" />
                    </SelectTrigger>
                    <SelectContent>
                      {funnel.stages.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.displayName}
                          <span className="ml-1 text-xs text-muted-foreground">({s.kind})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8 px-2"
                    disabled={!selectedStageId || movingStage}
                    onClick={handleMoveStage}
                  >
                    <CheckIcon className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => setStageChanging(false)}
                    disabled={movingStage}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Поля стадии */}
          {fields.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">
                    Данные · {stageDef?.displayName}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {saveMsg && (
                      <span className="text-xs text-muted-foreground">{saveMsg}</span>
                    )}
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
                        <Label className="text-xs text-muted-foreground">
                          {field.displayName}
                        </Label>
                        {field.required && (
                          <span className="text-destructive text-xs">*</span>
                        )}
                        {field.aiExtractable && (
                          <span className="text-xs text-primary/60">✦</span>
                        )}
                      </div>
                      {editing &&
                      field.fieldType !== "file" &&
                      field.fieldType !== "photo" ? (
                        <FieldEditor
                          field={field}
                          initialJson={valueMap.get(field.id) ?? "null"}
                          onChange={(v) =>
                            setFieldEdits((prev) => ({ ...prev, [field.id]: v }))
                          }
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
                            <Badge variant="outline" className="text-xs">{ev.fromState}</Badge>
                            <span className="text-muted-foreground">→</span>
                          </>
                        )}
                        <Badge variant="secondary" className="text-xs">{ev.toState}</Badge>
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
