import {
  BellIcon,
  CalendarClockIcon,
  CheckIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  type AdminRow,
  ApiError,
  type AuditEntry,
  clearToken,
  type FunnelData,
  type MessageTemplate,
  type OperatorOutreachPriority,
  type OperatorOutreachResult,
  type OperatorOutreachRole,
  type OperatorOutreachTarget,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

function fmtDateTime(epoch: number) {
  return new Date(epoch * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const HISTORY_SKELETON_KEYS = ["history-skeleton-1", "history-skeleton-2", "history-skeleton-3"];

function OutreachHistoryItem({ entry }: { entry: AuditEntry }) {
  const d = entry.details ?? {};
  const text = typeof d.text === "string" ? d.text : "";
  const enqueued = typeof d.enqueued === "number" ? d.enqueued : 0;
  const skipped = typeof d.skipped === "number" ? d.skipped : 0;
  const stageSlug = typeof d.stageSlug === "string" ? d.stageSlug : null;
  const leadCount = typeof d.leadCount === "number" ? d.leadCount : null;

  return (
    <div className="flex flex-col gap-1 rounded-md border px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <p className="flex-1 text-muted-foreground line-clamp-2">{text || "—"}</p>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {fmtDateTime(entry.createdAt)}
        </span>
      </div>
      <div className="flex items-center gap-3 pt-0.5">
        {stageSlug && (
          <Badge variant="secondary" className="text-[10px]">
            Стадия: {stageSlug}
          </Badge>
        )}
        {leadCount !== null && (
          <Badge variant="secondary" className="text-[10px]">
            {leadCount} лид{leadCount !== 1 ? "ов" : ""}
          </Badge>
        )}
        <span className="text-xs text-green-600 font-medium">{enqueued} отправлено</span>
        {skipped > 0 && <span className="text-xs text-muted-foreground">{skipped} пропущено</span>}
        {entry.adminEmail && (
          <span className="ml-auto text-xs text-muted-foreground">{entry.adminEmail}</span>
        )}
      </div>
    </div>
  );
}

function roleLabel(role: AdminRow["role"]) {
  return role === "superadmin" ? "Админ" : "Менеджер";
}

function priorityLabel(priority: OperatorOutreachPriority) {
  if (priority === "critical") return "Критично";
  if (priority === "important") return "Важно";
  return "Обычно";
}

function OperatorOutreachHistoryItem({ entry }: { entry: AuditEntry }) {
  const d = entry.details ?? {};
  const text = typeof d.text === "string" ? d.text : "";
  const targets = typeof d.targets === "number" ? d.targets : 0;
  const inApp = typeof d.inAppDelivered === "number" ? d.inAppDelivered : 0;
  const telegram = typeof d.telegramDelivered === "number" ? d.telegramDelivered : 0;
  const skipped = typeof d.telegramSkipped === "number" ? d.telegramSkipped : 0;
  const priority =
    typeof d.priority === "string" ? (d.priority as OperatorOutreachPriority) : "normal";

  return (
    <div className="flex flex-col gap-1 rounded-md border px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <p className="flex-1 text-muted-foreground line-clamp-2">{text || "—"}</p>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {fmtDateTime(entry.createdAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        <Badge variant="secondary" className="text-[10px]">
          {priorityLabel(priority)}
        </Badge>
        <span className="text-xs text-muted-foreground">{targets} получателей</span>
        <span className="text-xs text-green-600 font-medium">{inApp} в ленту</span>
        <span className="text-xs text-green-600 font-medium">{telegram} в Telegram</span>
        {skipped > 0 && (
          <span className="text-xs text-muted-foreground">{skipped} без Telegram</span>
        )}
        {entry.adminEmail && (
          <span className="ml-auto text-xs text-muted-foreground">{entry.adminEmail}</span>
        )}
      </div>
    </div>
  );
}

export function SaasOutreach() {
  const navigate = useNavigate();
  const [audience, setAudience] = useState<"leads" | "operators">("leads");

  // Compose state
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [target, setTarget] = useState<"all" | "stage">("all");
  const [stageSlug, setStageSlug] = useState("");
  const [text, setText] = useState("");
  const [scheduledAt, setScheduledAt] = useState(""); // datetime-local string
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{
    enqueued: number;
    skipped: number;
    scheduledAt: number | null;
  } | null>(null);

  // Templates state
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [newTplName, setNewTplName] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);

  // History state
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Operator outreach state
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [operatorTarget, setOperatorTarget] = useState<OperatorOutreachTarget>("all");
  const [operatorRole, setOperatorRole] = useState<OperatorOutreachRole>("manager");
  const [operatorAdminIds, setOperatorAdminIds] = useState<number[]>([]);
  const [operatorChannel, setOperatorChannel] = useState<"both" | "in_app" | "telegram">("both");
  const [operatorPriority, setOperatorPriority] = useState<OperatorOutreachPriority>("normal");
  const [operatorText, setOperatorText] = useState("");
  const [operatorSending, setOperatorSending] = useState(false);
  const [operatorResult, setOperatorResult] = useState<OperatorOutreachResult | null>(null);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function refreshHistory() {
    const res = await saas.listAuditLog({ limit: 200 });
    setHistory(
      res.items.filter(
        (e) => e.action === "outreach.send" || e.action === "operator_outreach.send",
      ),
    );
  }

  useEffect(() => {
    saas
      .getFunnel()
      .then(setFunnel)
      .catch((err) => {
        onAuthError(err);
      });
    saas
      .listMessageTemplates()
      .then((r) => setTemplates(r.items))
      .catch(() => {});
    saas
      .listAdmins()
      .then((r) => setAdmins(r.items))
      .catch((err) => {
        onAuthError(err);
      });
    saas
      .listAuditLog({ limit: 200 })
      .then((res) =>
        setHistory(
          res.items.filter(
            (e) => e.action === "outreach.send" || e.action === "operator_outreach.send",
          ),
        ),
      )
      .catch((err) => {
        onAuthError(err);
      })
      .finally(() => setHistoryLoading(false));
  }, []);

  async function handleSaveTemplate() {
    if (!text.trim() || !newTplName.trim()) return;
    setSavingTpl(true);
    try {
      const tpl = await saas.createMessageTemplate({ name: newTplName.trim(), body: text.trim() });
      setTemplates((prev) => [...prev, tpl]);
      setNewTplName("");
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось сохранить шаблон");
    } finally {
      setSavingTpl(false);
    }
  }

  async function handleDeleteTemplate(id: number) {
    try {
      await saas.deleteMessageTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось удалить шаблон");
    }
  }

  async function handleSend() {
    if (!text.trim()) return;
    setSending(true);
    setSendResult(null);
    try {
      const body =
        target === "stage" && stageSlug
          ? { text: text.trim(), stageSlug }
          : { text: text.trim(), leadIds: [] as number[] };

      if (target === "all") {
        delete (body as { leadIds?: number[] }).leadIds;
        (body as { stageSlug?: string }).stageSlug = undefined;
      }

      const scheduledAtEpoch = scheduledAt
        ? Math.floor(new Date(scheduledAt).getTime() / 1000)
        : undefined;

      const res = await saas.sendOutreach({
        text: text.trim(),
        ...(target === "stage" && stageSlug ? { stageSlug } : {}),
        ...(scheduledAtEpoch && scheduledAtEpoch > Math.floor(Date.now() / 1000)
          ? { scheduledAt: scheduledAtEpoch }
          : {}),
      });
      setSendResult(res);
      // Refresh history
      await refreshHistory();
    } catch (err) {
      if (!onAuthError(err)) {
        setSendResult(null);
      }
    } finally {
      setSending(false);
    }
  }

  function toggleOperatorAdmin(id: number) {
    setOperatorAdminIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  async function handleOperatorSend() {
    if (!operatorText.trim()) return;
    setOperatorSending(true);
    setOperatorResult(null);
    try {
      const channels = operatorChannel === "both" ? ["in_app", "telegram"] : [operatorChannel];
      const res = await saas.sendOperatorOutreach({
        text: operatorText.trim(),
        target: operatorTarget,
        ...(operatorTarget === "role" ? { role: operatorRole } : {}),
        ...(operatorTarget === "admins" ? { adminIds: operatorAdminIds } : {}),
        channels,
        priority: operatorPriority,
      });
      setOperatorResult(res);
      toast.success("Рассылка операторам отправлена");
      await refreshHistory();
    } catch (err) {
      if (!onAuthError(err)) {
        toast.error("Не удалось отправить рассылку операторам");
      }
    } finally {
      setOperatorSending(false);
    }
  }

  const stages = funnel?.stages ?? [];
  const leadHistory = history.filter((e) => e.action === "outreach.send");
  const operatorHistory = history.filter((e) => e.action === "operator_outreach.send");
  const canSend =
    text.trim().length > 0 && text.length <= 4000 && !sending && (target === "all" || !!stageSlug);
  const canSendOperator =
    operatorText.trim().length > 0 &&
    operatorText.length <= 4000 &&
    !operatorSending &&
    (operatorTarget !== "admins" || operatorAdminIds.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Рассылка"
        description="Отправить сообщение лидам через их каналы (Telegram, WhatsApp, Web)"
      />

      <Tabs value={audience} onValueChange={(v) => setAudience(v as "leads" | "operators")}>
        <TabsList>
          <TabsTrigger value="leads" className="gap-2">
            <SendIcon className="size-4" />
            Лидам
          </TabsTrigger>
          <TabsTrigger value="operators" className="gap-2">
            <UsersIcon className="size-4" />
            Операторам
          </TabsTrigger>
        </TabsList>

        <TabsContent value="leads" className="space-y-6">
          {/* Compose card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <SendIcon className="size-4" />
                Новая рассылка
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Кому отправить</Label>
                <Select value={target} onValueChange={(v) => setTarget(v as "all" | "stage")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Всем лидам (у кого есть канал)</SelectItem>
                    <SelectItem value="stage">По стадии воронки</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {target === "stage" && stages.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Стадия</Label>
                  <Select value={stageSlug} onValueChange={setStageSlug}>
                    <SelectTrigger>
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

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Label>Текст сообщения</Label>
                  {templates.length > 0 && (
                    <Select
                      onValueChange={(id) => {
                        const tpl = templates.find((t) => String(t.id) === id);
                        if (tpl) setText(tpl.body);
                      }}
                    >
                      <SelectTrigger className="h-7 w-auto max-w-[200px] text-xs">
                        <SelectValue placeholder="Загрузить шаблон…" />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.map((t) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <Textarea
                  placeholder="Введите текст сообщения…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={5}
                  className="resize-none"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{text.length}/4000</p>
                  {text.trim() && (
                    <div className="flex items-center gap-1.5">
                      <Input
                        placeholder="Название шаблона…"
                        value={newTplName}
                        onChange={(e) => setNewTplName(e.target.value)}
                        className="h-7 text-xs w-40"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={!newTplName.trim() || savingTpl}
                        onClick={handleSaveTemplate}
                      >
                        <PlusIcon className="size-3 mr-1" />
                        Сохранить
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Saved templates list */}
              {templates.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Шаблоны</p>
                  <div className="flex flex-wrap gap-1.5">
                    {templates.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                      >
                        <button
                          type="button"
                          className="hover:underline cursor-pointer"
                          onClick={() => setText(t.body)}
                        >
                          {t.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTemplate(t.id)}
                          aria-label={`Удалить шаблон ${t.name}`}
                          title={`Удалить шаблон ${t.name}`}
                          className="text-muted-foreground/60 hover:text-destructive ml-1"
                        >
                          <Trash2Icon className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <CalendarClockIcon className="size-3.5" />
                  Отложенная отправка
                  <span className="text-muted-foreground font-normal">(опционально)</span>
                </Label>
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  className="w-auto"
                />
                {scheduledAt && (
                  <p className="text-xs text-muted-foreground">
                    Сообщения будут поставлены в очередь и отправлены в{" "}
                    {new Date(scheduledAt).toLocaleString("ru-RU")}
                  </p>
                )}
              </div>

              {sendResult && (
                <div className="rounded-md bg-muted px-4 py-3 text-sm flex items-center gap-4">
                  <span>
                    {sendResult.scheduledAt ? (
                      <>
                        Запланировано:{" "}
                        <span className="font-semibold text-blue-600">{sendResult.enqueued}</span>
                      </>
                    ) : (
                      <>
                        Отправлено:{" "}
                        <span className="font-semibold text-green-600">{sendResult.enqueued}</span>
                      </>
                    )}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    Пропущено:{" "}
                    <span className="font-semibold text-muted-foreground">
                      {sendResult.skipped}
                    </span>
                  </span>
                  {sendResult.scheduledAt && (
                    <>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">
                        Отправка в {fmtDateTime(sendResult.scheduledAt)}
                      </span>
                    </>
                  )}
                </div>
              )}

              <Button disabled={!canSend} onClick={handleSend} className="gap-2">
                {scheduledAt ? (
                  <CalendarClockIcon className="size-4" />
                ) : (
                  <SendIcon className="size-4" />
                )}
                {sending ? "Сохраняем…" : scheduledAt ? "Запланировать" : "Отправить"}
              </Button>
            </CardContent>
          </Card>

          {/* History */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              История рассылок
            </h2>
            {historyLoading ? (
              <div className="space-y-2">
                {HISTORY_SKELETON_KEYS.map((key) => (
                  <Skeleton key={key} className="h-16 w-full rounded-md" />
                ))}
              </div>
            ) : leadHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">Рассылок ещё не было.</p>
            ) : (
              <div className="space-y-2">
                {leadHistory.map((e) => (
                  <OutreachHistoryItem key={e.id} entry={e} />
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="operators" className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BellIcon className="size-4" />
                Новая рассылка операторам
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Кому отправить</Label>
                  <Select
                    value={operatorTarget}
                    onValueChange={(v) => setOperatorTarget(v as OperatorOutreachTarget)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Всем операторам</SelectItem>
                      <SelectItem value="role">По роли</SelectItem>
                      <SelectItem value="admins">Выбрать вручную</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Канал</Label>
                  <Select
                    value={operatorChannel}
                    onValueChange={(v) => setOperatorChannel(v as "both" | "in_app" | "telegram")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">Лента + Telegram</SelectItem>
                      <SelectItem value="in_app">Только лента</SelectItem>
                      <SelectItem value="telegram">Telegram с fallback</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Важность</Label>
                  <Select
                    value={operatorPriority}
                    onValueChange={(v) => setOperatorPriority(v as OperatorOutreachPriority)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Обычно</SelectItem>
                      <SelectItem value="important">Важно</SelectItem>
                      <SelectItem value="critical">Критично</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {operatorTarget === "role" && (
                <div className="space-y-1.5">
                  <Label>Роль</Label>
                  <Select
                    value={operatorRole}
                    onValueChange={(v) => setOperatorRole(v as OperatorOutreachRole)}
                  >
                    <SelectTrigger className="max-w-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Менеджеры</SelectItem>
                      <SelectItem value="superadmin">Админы</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {operatorTarget === "admins" && (
                <div className="space-y-2">
                  <Label>Операторы</Label>
                  {admins.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Операторы не найдены.</p>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {admins.map((admin) => {
                        const selected = operatorAdminIds.includes(admin.id);
                        return (
                          <button
                            key={admin.id}
                            type="button"
                            onClick={() => toggleOperatorAdmin(admin.id)}
                            className={`flex min-h-12 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                              selected
                                ? "border-primary bg-primary/5"
                                : "hover:border-muted-foreground/40"
                            }`}
                          >
                            <span
                              className={`flex size-5 shrink-0 items-center justify-center rounded border ${
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-muted-foreground/30"
                              }`}
                            >
                              <CheckIcon
                                className={`size-3 ${selected ? "opacity-100" : "opacity-0"}`}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{admin.email}</span>
                              <span className="text-xs text-muted-foreground">
                                {roleLabel(admin.role)}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>Текст сообщения</Label>
                <Textarea
                  placeholder="Что нужно сообщить операторам…"
                  value={operatorText}
                  onChange={(e) => setOperatorText(e.target.value)}
                  rows={5}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">{operatorText.length}/4000</p>
              </div>

              {operatorResult && (
                <div className="grid gap-2 rounded-md bg-muted px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
                  <span>
                    Получателей:{" "}
                    <span className="font-semibold text-foreground">{operatorResult.targets}</span>
                  </span>
                  <span>
                    В ленту:{" "}
                    <span className="font-semibold text-green-600">
                      {operatorResult.inAppDelivered}
                    </span>
                  </span>
                  <span>
                    Telegram:{" "}
                    <span className="font-semibold text-green-600">
                      {operatorResult.telegramDelivered}
                    </span>
                  </span>
                  <span>
                    Без Telegram:{" "}
                    <span className="font-semibold text-muted-foreground">
                      {operatorResult.telegramSkipped}
                    </span>
                  </span>
                  <span>
                    Ошибки:{" "}
                    <span className="font-semibold text-muted-foreground">
                      {operatorResult.telegramFailed}
                    </span>
                  </span>
                </div>
              )}

              <Button disabled={!canSendOperator} onClick={handleOperatorSend} className="gap-2">
                <SendIcon className="size-4" />
                {operatorSending ? "Отправляем…" : "Отправить операторам"}
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              История операторских рассылок
            </h2>
            {historyLoading ? (
              <div className="space-y-2">
                {HISTORY_SKELETON_KEYS.map((key) => (
                  <Skeleton key={key} className="h-16 w-full rounded-md" />
                ))}
              </div>
            ) : operatorHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">Операторских рассылок ещё не было.</p>
            ) : (
              <div className="space-y-2">
                {operatorHistory.map((e) => (
                  <OperatorOutreachHistoryItem key={e.id} entry={e} />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
