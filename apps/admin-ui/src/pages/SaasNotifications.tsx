import { BellIcon, CheckIcon, ClipboardCopyIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError, clearToken, saas } from "@/api/saas";

interface Settings {
  adminId: number;
  telegramChatId: string | null;
  notifyOnAssignedOnly: boolean;
  botUsername: string | null;
}

export function SaasNotifications() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [error, setError] = useState("");

  function onAuthError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function reload() {
    try {
      const s = await saas.getNotificationSettings();
      setSettings(s);
    } catch (err) {
      if (!onAuthError(err)) setError("Не удалось загрузить настройки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  async function handleGenerateLink() {
    setGenerating(true);
    setError("");
    try {
      const { token } = await saas.generateNotificationLinkToken();
      setLinkToken(token);
    } catch (err) {
      if (!onAuthError(err)) setError("Не удалось создать ссылку");
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
      await reload();
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
      setSettings((s) => s ? { ...s, notifyOnAssignedOnly: checked } : s);
    } catch (err) {
      if (!onAuthError(err)) toast.error("Не удалось сохранить");
    } finally {
      setSavingToggle(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success("Скопировано"));
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-32 rounded-lg" />
      </div>
    );
  }

  const connected = !!settings?.telegramChatId;
  const botUsername = settings?.botUsername;
  const deepLink = linkToken && botUsername ? `https://t.me/${botUsername}?start=${linkToken}` : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Уведомления"
        description="Получайте алерты о новых лидах и изменениях прямо в Telegram."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ── Telegram личный аккаунт ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <SendIcon className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">Telegram — личные уведомления</CardTitle>
            </div>
            {connected ? (
              <Badge variant="success" className="gap-1">
                <CheckIcon className="size-3" /> Подключено
              </Badge>
            ) : (
              <Badge variant="warning">Не подключено</Badge>
            )}
          </div>
          <CardDescription>
            Привяжите свой Telegram-аккаунт чтобы получать уведомления о новых сообщениях и
            смене стадии лида.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {connected ? (
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
                    Нажмите кнопку ниже — получите ссылку для привязки, откройте её в Telegram
                    и нажмите Start.
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
                    {deepLink ? (
                      <>Нажмите кнопку ниже — откроется бот в Telegram, нажмите <strong>Start</strong>.</>
                    ) : (
                      <>Отправьте команду ниже боту оператора и нажмите <strong>Start</strong>.</>
                    )}
                    {" "}После этого нажмите «Проверить подключение».
                  </p>

                  {deepLink ? (
                    <a href={deepLink} target="_blank" rel="noopener noreferrer">
                      <Button className="gap-2 w-full sm:w-auto">
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
                      Задайте <code>PLATFORM_OPERATOR_BOT_USERNAME</code> в конфиге API, чтобы здесь появилась прямая ссылка на бота.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleGenerateLink} disabled={generating}>
                      Обновить токен
                    </Button>
                    <Button variant="outline" size="sm" onClick={reload}>
                      Проверить подключение
                    </Button>
                  </div>
                </div>
              )}
            </div>
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
