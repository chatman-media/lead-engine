import {
  BellIcon,
  CheckIcon,
  ClipboardCopyIcon,
  FlaskConicalIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, clearToken, saas, type NotificationRule, type NotificationTemplate } from "@/api/saas";

interface Settings {
  adminId: number;
  telegramChatId: string | null;
  notifyOnAssignedOnly: boolean;
  botUsername: string | null;
}

const EVENT_TYPES: Record<string, string> = {
  stage_changed: "Смена стадии",
  lead_intake_complete: "Анкета заполнена",
  human_takeover: "Запрос оператора",
  document_uploaded: "Документ загружен",
  high_value_deal: "Сделка VIP",
  lead_stale: "Лид без активности",
};

const PLACEHOLDERS = "{{leadId}}, {{fromStage}}, {{toStage}}, {{displayName}}";

export function SaasNotifications() {
  const navigate = useNavigate();

  // ── Personal settings ──────────────────────────────────────────────────
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  // ── Rules ──────────────────────────────────────────────────────────────
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loadingRules, setLoadingRules] = useState(true);
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRuleEvent, setNewRuleEvent] = useState("stage_changed");
  const [newRuleTarget, setNewRuleTarget] = useState("");
  const [savingRule, setSavingRule] = useState(false);
  const [testingRuleId, setTestingRuleId] = useState<number | null>(null);
  const [groupLinkToken, setGroupLinkToken] = useState<string | null>(null);
  const [groupLinkEvent, setGroupLinkEvent] = useState("stage_changed");
  const [generatingGroupToken, setGeneratingGroupToken] = useState(false);
  const [addMode, setAddMode] = useState<"bot" | "manual" | null>(null);

  // ── Templates ─────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [newTplSlug, setNewTplSlug] = useState("stage_changed");
  const [savingTemplate, setSavingTemplate] = useState(false);

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function reloadSettings() {
    try {
      const s = await saas.getNotificationSettings();
      setSettings(s as Settings);
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось загрузить настройки");
    } finally {
      setLoadingSettings(false);
    }
  }

  async function reloadRules() {
    try {
      const { items } = await saas.getNotificationRules();
      setRules(items);
    } catch {
      // ignore
    } finally {
      setLoadingRules(false);
    }
  }

  async function reloadTemplates() {
    try {
      const { items } = await saas.getNotificationTemplates();
      setTemplates(items);
    } catch {
      // ignore
    } finally {
      setLoadingTemplates(false);
    }
  }

  useEffect(() => {
    reloadSettings();
    reloadRules();
    reloadTemplates();
  }, []);

  // ── Personal ───────────────────────────────────────────────────────────

  async function handleGenerateLink() {
    setGenerating(true);
    try {
      const { token } = await saas.generateNotificationLinkToken();
      setLinkToken(token);
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось создать ссылку");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDisconnect() {
    setSavingToggle(true);
    try {
      await saas.updateNotificationSettings({ telegramChatId: null });
      toast.success("Telegram отключён");
      setLinkToken(null);
      await reloadSettings();
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось отключить");
    } finally {
      setSavingToggle(false);
    }
  }

  async function handleToggleAssigned(checked: boolean) {
    setSavingToggle(true);
    try {
      await saas.updateNotificationSettings({ notifyOnAssignedOnly: checked });
      setSettings((s) => (s ? { ...s, notifyOnAssignedOnly: checked } : s));
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось сохранить");
    } finally {
      setSavingToggle(false);
    }
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  async function handleGenerateGroupToken() {
    setGeneratingGroupToken(true);
    try {
      const { token } = await saas.generateGroupLinkToken(groupLinkEvent);
      setGroupLinkToken(token);
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось создать токен");
    } finally {
      setGeneratingGroupToken(false);
    }
  }

  function closeAddRule() {
    setAddMode(null);
    setShowAddRule(false);
    setGroupLinkToken(null);
    setNewRuleTarget("");
  }

  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    if (!newRuleTarget.trim()) return;
    setSavingRule(true);
    try {
      await saas.createNotificationRule({ eventType: newRuleEvent, targetId: newRuleTarget.trim() });
      closeAddRule();
      await reloadRules();
      toast.success("Правило добавлено");
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось добавить правило");
    } finally {
      setSavingRule(false);
    }
  }

  async function handleDeleteRule(id: number) {
    try {
      await saas.deleteNotificationRule(id);
      setRules((r) => r.filter((x) => x.id !== id));
      toast.success("Правило удалено");
    } catch {
      toast.error("Не удалось удалить");
    }
  }

  async function handleTestRule(id: number) {
    setTestingRuleId(id);
    try {
      const result = await saas.testNotificationRule(id);
      if (result.ok) {
        toast.success("Тестовое сообщение отправлено");
      } else {
        toast.error(result.error ?? "Ошибка отправки");
      }
    } catch {
      toast.error("Ошибка при тесте");
    } finally {
      setTestingRuleId(null);
    }
  }

  // ── Templates ─────────────────────────────────────────────────────────

  function startEditTemplate(tpl: NotificationTemplate) {
    setEditingSlug(tpl.slug);
    setEditBody(tpl.body);
  }

  function startNewTemplate() {
    setEditingSlug("__new__");
    setEditBody("");
    setNewTplSlug("stage_changed");
  }

  async function handleSaveTemplate(e: React.FormEvent) {
    e.preventDefault();
    const slug = editingSlug === "__new__" ? newTplSlug : editingSlug!;
    if (!slug || !editBody.trim()) return;
    setSavingTemplate(true);
    try {
      await saas.upsertNotificationTemplate(slug, editBody.trim());
      setEditingSlug(null);
      await reloadTemplates();
      toast.success("Шаблон сохранён");
    } catch {
      toast.error("Не удалось сохранить шаблон");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteTemplate(slug: string) {
    try {
      await saas.deleteNotificationTemplate(slug);
      setTemplates((t) => t.filter((x) => x.slug !== slug));
      toast.success("Шаблон удалён");
    } catch {
      toast.error("Не удалось удалить");
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success("Скопировано"));
  }

  const connected = !!settings?.telegramChatId;
  const botUsername = settings?.botUsername;
  const deepLink = linkToken && botUsername ? `https://t.me/${botUsername}?start=${linkToken}` : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Уведомления"
        description="Алерты о новых лидах и изменениях прямо в Telegram."
      />

      {/* ── Telegram личный аккаунт ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <SendIcon className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">Личные уведомления</CardTitle>
            </div>
            {loadingSettings ? null : connected ? (
              <Badge variant="success" className="gap-1">
                <CheckIcon className="size-3" /> Подключено
              </Badge>
            ) : (
              <Badge variant="warning">Не подключено</Badge>
            )}
          </div>
          <CardDescription>
            Привяжите свой Telegram — получайте уведомления о новых сообщениях и сменах стадии.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {loadingSettings ? (
            <Skeleton className="h-10 w-full" />
          ) : connected ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Chat ID:</span>
                <code className="font-mono text-xs">{settings?.telegramChatId}</code>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">Только назначенные мне лиды</Label>
                  <p className="text-xs text-muted-foreground">
                    Получать уведомления только по лидам, назначенным на вас
                  </p>
                </div>
                <Switch
                  checked={settings?.notifyOnAssignedOnly ?? true}
                  onCheckedChange={handleToggleAssigned}
                  disabled={savingToggle}
                />
              </div>

              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-destructive hover:text-destructive hover:border-destructive/50"
                onClick={handleDisconnect}
                disabled={savingToggle}
              >
                <Trash2Icon className="size-3.5" />
                Отключить Telegram
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {!linkToken ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Нажмите кнопку — получите ссылку для привязки, откройте её в Telegram и нажмите Start.
                  </p>
                  <Button onClick={handleGenerateLink} disabled={generating} className="gap-2">
                    <BellIcon className="size-4" />
                    {generating ? "Генерируем…" : "Подключить Telegram"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Ссылка действует 1 час.{" "}
                    {deepLink
                      ? <>Нажмите кнопку — откроется бот, нажмите <strong>Start</strong>.</>
                      : <>Отправьте команду ниже боту-оператору и нажмите <strong>Start</strong>.</>}
                    {" "}После этого нажмите «Проверить».
                  </p>

                  {deepLink ? (
                    <a href={deepLink} target="_blank" rel="noopener noreferrer">
                      <Button className="gap-2">
                        <SendIcon className="size-4" />
                        Открыть бота в Telegram
                      </Button>
                    </a>
                  ) : (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                        /start {linkToken}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 h-8 w-8"
                        onClick={() => copyToClipboard(`/start ${linkToken}`)}
                      >
                        <ClipboardCopyIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}

                  {!botUsername && (
                    <p className="text-xs text-muted-foreground">
                      Задайте <code>PLATFORM_OPERATOR_BOT_USERNAME</code> в конфиге API для прямой ссылки на бота.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleGenerateLink} disabled={generating}>
                      Обновить токен
                    </Button>
                    <Button variant="outline" size="sm" onClick={reloadSettings}>
                      Проверить
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Правила для групп ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BellIcon className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-base">Правила для групп</CardTitle>
                <CardDescription className="mt-0.5">
                  Отправлять уведомления в Telegram-группы по событиям
                </CardDescription>
              </div>
            </div>
            {addMode === null && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAddMode("bot")}>
                <PlusIcon className="size-3.5" />
                Добавить
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {loadingRules ? (
            <Skeleton className="h-10 w-full" />
          ) : rules.length === 0 && !showAddRule ? (
            <p className="text-sm text-muted-foreground">Нет правил. Добавьте первое.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {EVENT_TYPES[rule.eventType] ?? rule.eventType}
                  </Badge>
                  <code className="flex-1 truncate text-xs font-mono text-muted-foreground">
                    {rule.targetId}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-7 text-xs shrink-0"
                    disabled={testingRuleId === rule.id}
                    onClick={() => handleTestRule(rule.id)}
                  >
                    <FlaskConicalIcon className="size-3" />
                    {testingRuleId === rule.id ? "…" : "Тест"}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeleteRule(rule.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {addMode !== null && (
            <div className="rounded-md border p-3 space-y-3">
              {/* Переключатель режима */}
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => { setAddMode("bot"); setGroupLinkToken(null); }}
                  className={`px-2 py-1 rounded ${addMode === "bot" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  🤖 Через бота
                </button>
                <button
                  type="button"
                  onClick={() => setAddMode("manual")}
                  className={`px-2 py-1 rounded ${addMode === "manual" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  ⌨️ Вручную
                </button>
              </div>

              {/* Bot flow */}
              {addMode === "bot" && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Событие</Label>
                    <select
                      value={groupLinkEvent}
                      onChange={(e) => { setGroupLinkEvent(e.target.value); setGroupLinkToken(null); }}
                      className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                    >
                      {Object.entries(EVENT_TYPES).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>

                  {!groupLinkToken ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Добавьте бота в Telegram-группу, получите токен и отправьте его туда — бот сам создаст правило.
                      </p>
                      <Button size="sm" onClick={handleGenerateGroupToken} disabled={generatingGroupToken} className="gap-1.5">
                        <SendIcon className="size-3.5" />
                        {generatingGroupToken ? "Генерируем…" : "Получить токен"}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Отправьте эту команду в нужную Telegram-группу (токен действует 1 час):
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all">
                          /setup {groupLinkToken}
                        </code>
                        <Button
                          variant="ghost" size="icon" className="shrink-0 h-7 w-7"
                          onClick={() => copyToClipboard(`/setup ${groupLinkToken}`)}
                        >
                          <ClipboardCopyIcon className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={async () => { await reloadRules(); closeAddRule(); toast.success("Обновлено"); }}>
                          Готово — проверить
                        </Button>
                        <Button size="sm" variant="ghost" onClick={handleGenerateGroupToken} disabled={generatingGroupToken}>
                          Новый токен
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Manual flow */}
              {addMode === "manual" && (
                <form onSubmit={handleAddRule} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Событие</Label>
                    <select
                      value={newRuleEvent}
                      onChange={(e) => setNewRuleEvent(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                    >
                      {Object.entries(EVENT_TYPES).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">ID чата / группы Telegram</Label>
                    <Input
                      value={newRuleTarget}
                      onChange={(e) => setNewRuleTarget(e.target.value)}
                      placeholder="-100123456789"
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Отправьте <code>/setup</code> боту в группе — он ответит её ID.
                    </p>
                  </div>
                  <Button type="submit" size="sm" disabled={savingRule || !newRuleTarget.trim()}>
                    Сохранить
                  </Button>
                </form>
              )}

              <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={closeAddRule}>
                Отмена
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Шаблоны сообщений ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <PencilIcon className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-base">Шаблоны сообщений</CardTitle>
                <CardDescription className="mt-0.5">
                  Кастомный текст уведомлений вместо стандартного. Переменные: <code className="text-xs">{PLACEHOLDERS}</code>
                </CardDescription>
              </div>
            </div>
            {editingSlug === null && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={startNewTemplate}>
                <PlusIcon className="size-3.5" />
                Добавить
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {loadingTemplates ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <>
              {templates.length === 0 && editingSlug === null && (
                <p className="text-sm text-muted-foreground">
                  Шаблонов нет — используются сообщения по умолчанию.
                </p>
              )}
              <div className="space-y-2">
                {templates.map((tpl) => (
                  editingSlug === tpl.slug ? null : (
                    <div key={tpl.slug} className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm">
                      <Badge variant="secondary" className="mt-0.5 shrink-0 text-xs">
                        {EVENT_TYPES[tpl.slug] ?? tpl.slug}
                      </Badge>
                      <p className="flex-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {tpl.body}
                      </p>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() => startEditTemplate(tpl)}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeleteTemplate(tpl.slug)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  )
                ))}
              </div>
            </>
          )}

          {editingSlug !== null && (
            <form onSubmit={handleSaveTemplate} className="space-y-3 rounded-md border p-3">
              {editingSlug === "__new__" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Событие</Label>
                  <select
                    value={newTplSlug}
                    onChange={(e) => setNewTplSlug(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                  >
                    {Object.entries(EVENT_TYPES).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Текст сообщения</Label>
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={4}
                  placeholder={`Новая заявка #{{leadId}}: стадия {{toStage}}`}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Поддерживается HTML: <code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;code&gt;</code>
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={savingTemplate || !editBody.trim()}>
                  Сохранить
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditingSlug(null)}>
                  Отмена
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* ── In-app тосты ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <BellIcon className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">In-app уведомления</CardTitle>
          </div>
          <CardDescription>
            Всплывающие уведомления прямо в браузере — работают всегда, пока открыта вкладка.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
            <CheckIcon className="size-3.5 text-green-500 shrink-0" />
            <span className="text-muted-foreground">Активно — подключено через SSE</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
