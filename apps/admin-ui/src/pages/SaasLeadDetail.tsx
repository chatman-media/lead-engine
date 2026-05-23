import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, clearToken, saas, type LeadDetail, type StageField } from "@/api/saas";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeftIcon, SendIcon } from "lucide-react";

function formatDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

export function SaasLeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);

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
  }, [id]);

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

  if (loading) return <p className="p-6 text-muted-foreground text-sm">Загрузка…</p>;
  if (error) return <p className="p-6 text-destructive text-sm">{error}</p>;
  if (!data) return null;

  const { lead, stageDef, fields, fieldValues, events, notes, contact } = data;

  const valueMap = new Map(fieldValues.map((v) => [v.fieldId, v.valueJson]));

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
        {/* Основная карточка */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Текущая стадия */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Текущая стадия</CardTitle>
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
            </CardContent>
          </Card>

          {/* Поля стадии */}
          {fields.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Данные · {stageDef?.displayName}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y">
                  {fields.map((field) => (
                    <div key={field.id} className="flex justify-between py-2 text-sm">
                      <span className="text-muted-foreground flex items-center gap-1">
                        {field.displayName}
                        {field.required && (
                          <span className="text-destructive text-xs">*</span>
                        )}
                      </span>
                      <span className="font-medium text-right max-w-[60%] break-words">
                        {renderFieldValue(field, valueMap.get(field.id) ?? "null")}
                      </span>
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

        {/* Правая колонка — заметки + мета */}
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
