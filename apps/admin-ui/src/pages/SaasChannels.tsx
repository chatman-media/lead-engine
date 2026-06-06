import {
  CheckIcon,
  CopyIcon,
  FacebookIcon,
  GlobeIcon,
  MessageCircleIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  type ChannelItem,
  type CreateFacebookChannelResult,
  type CreateWebChannelResult,
  type CreateWhatsAppChannelResult,
  clearToken,
  saas,
} from "../api/saas.ts";

type ChannelTab = "telegram" | "userbot" | "whatsapp" | "facebook" | "web";
type UserbotStep = "phone" | "code" | "2fa";

const KIND_META: Record<string, { icon: typeof SendIcon; label: string }> = {
  telegram_bot: { icon: SendIcon, label: "Telegram-бот" },
  telegram_userbot: { icon: UserIcon, label: "Личный аккаунт" },
  whatsapp: { icon: MessageCircleIcon, label: "WhatsApp" },
  facebook: { icon: FacebookIcon, label: "Facebook Messenger" },
  web: { icon: GlobeIcon, label: "Web-виджет" },
};

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}

function OkNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] px-3 py-2 text-sm text-[var(--success)]">
      {children}
    </p>
  );
}

/** Карточка «канал уже подключён»: статус + Переподключить/Отключить. */
function ConnectedChannelCard({
  title,
  statusText,
  reconnectLabel,
  onReconnect,
  confirmDelete,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  title: string;
  statusText: string;
  reconnectLabel: string;
  onReconnect: () => void;
  confirmDelete: boolean;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]">
            <CheckIcon className="size-5" />
          </span>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{statusText}</p>
          </div>
        </div>
        <span className="text-xs font-semibold text-[var(--success)]">активен</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onReconnect}>
          {reconnectLabel}
        </Button>
        {confirmDelete ? (
          <>
            <span className="self-center text-sm text-muted-foreground">Отключить?</span>
            <Button variant="destructive" onClick={onConfirmDelete}>
              Да, отключить
            </Button>
            <Button variant="ghost" onClick={onCancelDelete}>
              Отмена
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onAskDelete}
          >
            Отключить
          </Button>
        )}
      </div>
    </div>
  );
}

export function SaasChannels() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ChannelTab>("telegram");
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [botToken, setBotToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ username: string } | null>(null);

  const [ubStep, setUbStep] = useState<UserbotStep>("phone");
  const [ubPhone, setUbPhone] = useState("");
  const [ubApiId, setUbApiId] = useState("");
  const [ubApiHash, setUbApiHash] = useState("");
  const [ubCode, setUbCode] = useState("");
  const [ubPassword, setUbPassword] = useState("");
  const [ubLoginId, setUbLoginId] = useState("");
  const [ubSubmitting, setUbSubmitting] = useState(false);
  const [ubError, setUbError] = useState("");
  const [ubDone, setUbDone] = useState<{ username: string | null } | null>(null);
  // Если личный аккаунт уже подключён — показываем статус, а не мастер заново.
  // ubReconnect=true принудительно открывает мастер для переподключения.
  const [ubReconnect, setUbReconnect] = useState(false);
  // Для bot/whatsapp/web: какая вкладка принудительно показывает форму
  // (переподключение / добавить), несмотря на уже подключённый канал.
  const [reconnectKind, setReconnectKind] = useState<ChannelTab | null>(null);

  const [waPhoneId, setWaPhoneId] = useState("");
  const [waAccessToken, setWaAccessToken] = useState("");
  const [waBizId, setWaBizId] = useState("");
  const [waVerifyToken, setWaVerifyToken] = useState("");
  const [waAppSecret, setWaAppSecret] = useState("");
  const [waSubmitting, setWaSubmitting] = useState(false);
  const [waResult, setWaResult] = useState<CreateWhatsAppChannelResult | null>(null);

  const [fbPageToken, setFbPageToken] = useState("");
  const [fbVerifyToken, setFbVerifyToken] = useState("");
  const [fbAppSecret, setFbAppSecret] = useState("");
  const [fbSubmitting, setFbSubmitting] = useState(false);
  const [fbResult, setFbResult] = useState<CreateFacebookChannelResult | null>(null);

  const [webBrand, setWebBrand] = useState("");
  const [webColor, setWebColor] = useState("");
  const [webSubmitting, setWebSubmitting] = useState(false);
  const [webResult, setWebResult] = useState<CreateWebChannelResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDeleteChannelId, setConfirmDeleteChannelId] = useState<number | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh() {
    try {
      const { items } = await saas.listChannels();
      setChannels(items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLastCreated(null);
    const trimmed = botToken.trim();
    if (!trimmed) {
      setError("Вставьте Telegram bot token из @BotFather");
      return;
    }
    setSubmitting(true);
    try {
      const res = await saas.createTelegramChannel(trimmed);
      setLastCreated({ username: res.username });
      setBotToken("");
      setReconnectKind(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          if (err.errorCode.toLowerCase().includes("telegram")) {
            setError("Telegram отверг токен — проверьте, что вставили правильно из @BotFather");
          } else {
            clearToken();
            navigate("/login", { replace: true });
            return;
          }
        } else if (err.status === 400) {
          setError(`Ошибка: ${err.errorCode}`);
        } else if (err.status === 409) {
          setError("Этот бот уже подключён к аккаунту");
        } else if (err.status === 502) {
          setError("Telegram недоступен — попробуйте позже");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    setConfirmDeleteChannelId(null);
    try {
      await saas.deleteChannel(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleWebSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setWebResult(null);
    setWebSubmitting(true);
    try {
      const res = await saas.createWebChannel({
        ...(webBrand.trim() ? { brandName: webBrand.trim() } : {}),
        ...(/^#[0-9a-fA-F]{3,8}$/.test(webColor) ? { primaryColor: webColor } : {}),
      });
      setWebResult(res);
      setReconnectKind(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 402) {
          setError("Лимит каналов исчерпан — обновите план для добавления web-виджета");
        } else if (err.status === 401) {
          clearToken();
          navigate("/login", { replace: true });
          return;
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setWebSubmitting(false);
    }
  }

  async function copySnippet(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard может быть недоступен
    }
  }

  async function handleWhatsAppSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setWaResult(null);
    const phoneNumberId = waPhoneId.trim();
    const accessToken = waAccessToken.trim();
    if (!phoneNumberId || !accessToken) {
      setError("phone_number_id и access_token обязательны");
      return;
    }
    setWaSubmitting(true);
    try {
      const res = await saas.createWhatsAppChannel({
        phoneNumberId,
        accessToken,
        ...(waBizId.trim() ? { businessAccountId: waBizId.trim() } : {}),
        ...(waVerifyToken.trim() ? { verifyToken: waVerifyToken.trim() } : {}),
        ...(waAppSecret.trim() ? { appSecret: waAppSecret.trim() } : {}),
      });
      setWaResult(res);
      setWaAccessToken("");
      setReconnectKind(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          if (err.errorCode.toLowerCase().includes("meta")) {
            setError("Meta отвергла access_token — проверьте permissions и срок действия");
          } else {
            clearToken();
            navigate("/login", { replace: true });
            return;
          }
        } else if (err.status === 404) {
          setError("phone_number_id не найден — проверьте Meta dashboard → WhatsApp → API Setup");
        } else if (err.status === 502) {
          setError("Meta Graph недоступен — попробуйте позже");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setWaSubmitting(false);
    }
  }

  async function handleFacebookSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setFbResult(null);
    const pageAccessToken = fbPageToken.trim();
    if (!pageAccessToken) {
      setError("Page Access Token обязателен");
      return;
    }
    setFbSubmitting(true);
    try {
      const res = await saas.createFacebookChannel({
        pageAccessToken,
        ...(fbVerifyToken.trim() ? { verifyToken: fbVerifyToken.trim() } : {}),
        ...(fbAppSecret.trim() ? { appSecret: fbAppSecret.trim() } : {}),
      });
      setFbResult(res);
      setFbPageToken("");
      setReconnectKind(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          if (err.errorCode.toLowerCase().includes("meta")) {
            setError("Meta отвергла Page Access Token — проверьте permissions и срок действия");
          } else {
            clearToken();
            navigate("/login", { replace: true });
            return;
          }
        } else if (err.status === 502) {
          setError("Meta Graph недоступен — попробуйте позже");
        } else {
          setError(`Ошибка ${err.status}: ${err.errorCode}`);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setFbSubmitting(false);
    }
  }

  function userbotErrMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return "";
      }
      if (err.errorCode === "userbot_creds_required" || err.errorCode === "userbot_creds_invalid") {
        return (
          (err.extra?.message as string | undefined) ??
          "Укажите API ID и API Hash (my.telegram.org → API development tools)"
        );
      }
      if (err.status === 503) return "Userbot временно недоступен — попробуйте позже";
      if (err.status === 403) return "Доступно только для superadmin";
      const msg = err.extra?.message as string | undefined;
      const retry = err.extra?.retryAfterSec as number | undefined;
      if (err.errorCode === "flood_wait") {
        return `Слишком много попыток — подождите ${retry ?? "?"} сек`;
      }
      return msg ?? `Ошибка: ${err.errorCode}`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  function resetUserbot() {
    setUbStep("phone");
    setUbPhone("");
    setUbApiId("");
    setUbApiHash("");
    setUbCode("");
    setUbPassword("");
    setUbLoginId("");
    setUbError("");
  }

  async function handleUbPhone(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbDone(null);
    const phone = ubPhone.trim();
    if (!/^\+?\d{7,15}$/.test(phone)) {
      setUbError("Укажите номер в формате +79991234567");
      return;
    }
    setUbSubmitting(true);
    try {
      const res = await saas.startUserbotLogin(phone, ubApiId, ubApiHash);
      setUbLoginId(res.loginId);
      setUbStep("code");
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleUbCode(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbSubmitting(true);
    try {
      const res = await saas.verifyUserbotCode(ubLoginId, ubCode.trim());
      if ("awaiting" in res) {
        setUbStep("2fa");
      } else {
        setUbDone({ username: res.username });
        resetUserbot();
        setUbReconnect(false);
        await refresh();
      }
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleUb2fa(e: FormEvent) {
    e.preventDefault();
    setUbError("");
    setUbSubmitting(true);
    try {
      const res = await saas.submitUserbot2fa(ubLoginId, ubPassword);
      if (!("awaiting" in res)) setUbDone({ username: res.username });
      resetUserbot();
      setUbReconnect(false);
      await refresh();
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="space-y-2">
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <Skeleton key={i} className="h-9 w-24 rounded-md" />
            ))}
          </div>
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  const existingUserbot = channels.find((c) => c.kind === "telegram_userbot");
  const existingBot = channels.find((c) => c.kind === "telegram_bot");
  const existingWa = channels.find((c) => c.kind === "whatsapp");
  const existingFb = channels.find((c) => c.kind === "facebook");
  const existingWeb = channels.find((c) => c.kind === "web");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Каналы"
        description="Подключите источники сообщений: Telegram-бот, личный аккаунт, WhatsApp или web-виджет."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {lastCreated && (
        <OkNote>✓ Бот @{lastCreated.username} подключён — webhook настроен, канал работает.</OkNote>
      )}
      {ubDone && (
        <OkNote>
          ✓ Личный аккаунт{ubDone.username ? ` @${ubDone.username}` : ""} подключён — входящие
          обрабатываются ассистентом.
        </OkNote>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as ChannelTab)}>
        <TabsList>
          <TabsTrigger value="telegram">
            <SendIcon /> Telegram
          </TabsTrigger>
          <TabsTrigger value="userbot">
            <UserIcon /> Личный
          </TabsTrigger>
          <TabsTrigger value="whatsapp">
            <MessageCircleIcon /> WhatsApp
          </TabsTrigger>
          <TabsTrigger value="facebook">
            <FacebookIcon /> Facebook
          </TabsTrigger>
          <TabsTrigger value="web">
            <GlobeIcon /> Web
          </TabsTrigger>
        </TabsList>

        <TabsContent value="telegram">
          <Card>
            <CardHeader>
              <CardTitle>
                {existingBot && reconnectKind !== "telegram"
                  ? "Telegram-бот"
                  : "Подключить Telegram-бота"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Создайте бота в{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  @BotFather
                </a>{" "}
                и вставьте токен. Webhook настроится автоматически.
              </p>
            </CardHeader>
            <CardContent>
              {existingBot && reconnectKind !== "telegram" ? (
                <ConnectedChannelCard
                  title={
                    existingBot.username
                      ? `@${existingBot.username}`
                      : `Бот ${existingBot.externalId}`
                  }
                  statusText="Бот подключён — webhook активен"
                  reconnectLabel="Заменить токен"
                  onReconnect={() => {
                    setReconnectKind("telegram");
                    setBotToken("");
                    setLastCreated(null);
                  }}
                  confirmDelete={confirmDeleteChannelId === existingBot.id}
                  onAskDelete={() => setConfirmDeleteChannelId(existingBot.id)}
                  onConfirmDelete={() => handleDelete(existingBot.id)}
                  onCancelDelete={() => setConfirmDeleteChannelId(null)}
                />
              ) : (
                <form onSubmit={handleSubmit} className="space-y-3">
                  {existingBot && reconnectKind === "telegram" && (
                    <p className="text-xs text-muted-foreground">
                      Новый токен заменит текущего бота{" "}
                      {existingBot.username ? `@${existingBot.username}` : ""}.
                    </p>
                  )}
                  <div className="space-y-1.5">
                    <Label>Токен бота</Label>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder="123456789:AAEhBP…"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={submitting || !botToken.trim()}>
                      {submitting ? "Проверяем…" : "Подключить"}
                    </Button>
                    {existingBot && reconnectKind === "telegram" && (
                      <Button type="button" variant="ghost" onClick={() => setReconnectKind(null)}>
                        Отмена
                      </Button>
                    )}
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="userbot">
          <Card>
            <CardHeader>
              <CardTitle>
                {existingUserbot && !ubReconnect
                  ? "Личный Telegram-аккаунт"
                  : "Подключить личный Telegram-аккаунт"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Для случаев, когда лиды пишут вам в личку (а не боту). Подключается через MTProto:
                ассистент анализирует входящие и отвечает от вашего имени.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Уже подключён — показываем статус, без повторного мастера. */}
              {existingUserbot && !ubReconnect ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[var(--success)]">
                        <CheckIcon className="size-5" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">
                          {existingUserbot.username
                            ? `@${existingUserbot.username}`
                            : `TG ${existingUserbot.externalId}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {existingUserbot.status === "active"
                            ? "Подключён — входящие в личку обрабатывает ассистент"
                            : `Статус: ${existingUserbot.status}`}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-[var(--success)]">активен</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        resetUserbot();
                        setUbDone(null);
                        setUbReconnect(true);
                      }}
                    >
                      Переподключить
                    </Button>
                    {confirmDeleteChannelId === existingUserbot.id ? (
                      <>
                        <span className="self-center text-sm text-muted-foreground">
                          Отключить?
                        </span>
                        <Button
                          variant="destructive"
                          onClick={() => handleDelete(existingUserbot.id)}
                        >
                          Да, отключить
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmDeleteChannelId(null)}>
                          Отмена
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmDeleteChannelId(existingUserbot.id)}
                      >
                        Отключить
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <p className="flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                    Это автоматизация личного аккаунта. Подключайте только свой аккаунт и для
                    ответов своим лидам — массовая рассылка нарушает правила Telegram.
                  </p>
                  {existingUserbot && ubReconnect && (
                    <p className="text-xs text-muted-foreground">
                      Переподключение заменит текущий аккаунт{" "}
                      {existingUserbot.username ? `@${existingUserbot.username}` : ""}.
                    </p>
                  )}
                  {ubError && <ErrorNote>{ubError}</ErrorNote>}

                  {ubStep === "phone" && (
                    <form onSubmit={handleUbPhone} className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label>API ID</Label>
                          <Input
                            inputMode="numeric"
                            autoComplete="off"
                            value={ubApiId}
                            onChange={(e) => setUbApiId(e.target.value)}
                            placeholder="1234567"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>API Hash</Label>
                          <Input
                            autoComplete="off"
                            value={ubApiHash}
                            onChange={(e) => setUbApiHash(e.target.value)}
                            placeholder="abcd1234ef…"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Получите на{" "}
                        <a
                          href="https://my.telegram.org/apps"
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          my.telegram.org → API development tools
                        </a>
                        . Можно оставить пустым, если платформа предоставляет общие ключи.
                      </p>
                      <div className="space-y-1.5">
                        <Label>Номер телефона аккаунта</Label>
                        <Input
                          type="tel"
                          autoComplete="off"
                          value={ubPhone}
                          onChange={(e) => setUbPhone(e.target.value)}
                          placeholder="+79991234567"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" disabled={ubSubmitting || !ubPhone.trim()}>
                          {ubSubmitting ? "Отправляем код…" : "Получить код"}
                        </Button>
                        {existingUserbot && ubReconnect && (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setUbReconnect(false);
                              resetUserbot();
                            }}
                          >
                            Отмена
                          </Button>
                        )}
                      </div>
                    </form>
                  )}

                  {ubStep === "code" && (
                    <form onSubmit={handleUbCode} className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Telegram отправил код на {ubPhone}. Введите его.
                      </p>
                      <div className="space-y-1.5">
                        <Label>Код подтверждения</Label>
                        <Input
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          value={ubCode}
                          onChange={(e) => setUbCode(e.target.value)}
                          placeholder="12345"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" disabled={ubSubmitting || !ubCode.trim()}>
                          {ubSubmitting ? "Проверяем…" : "Подтвердить"}
                        </Button>
                        <Button type="button" variant="ghost" onClick={resetUserbot}>
                          Изменить номер
                        </Button>
                      </div>
                    </form>
                  )}

                  {ubStep === "2fa" && (
                    <form onSubmit={handleUb2fa} className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        У аккаунта включён облачный пароль (2FA). Введите его.
                      </p>
                      <div className="space-y-1.5">
                        <Label>Пароль 2FA</Label>
                        <Input
                          type="password"
                          autoComplete="off"
                          value={ubPassword}
                          onChange={(e) => setUbPassword(e.target.value)}
                          placeholder="••••••••"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button type="submit" disabled={ubSubmitting || !ubPassword}>
                          {ubSubmitting ? "Проверяем…" : "Войти"}
                        </Button>
                        <Button type="button" variant="ghost" onClick={resetUserbot}>
                          Начать заново
                        </Button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="whatsapp">
          <Card>
            <CardHeader>
              <CardTitle>
                {existingWa && reconnectKind !== "whatsapp"
                  ? "WhatsApp Business"
                  : "Подключить WhatsApp Business"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Из{" "}
                <a
                  href="https://developers.facebook.com/apps/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Meta for Developers
                </a>{" "}
                → API Setup: <code className="font-mono">Phone number ID</code> + system user{" "}
                <code className="font-mono">Access token</code>.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {existingWa && reconnectKind !== "whatsapp" ? (
                <ConnectedChannelCard
                  title={`WhatsApp #${existingWa.externalId}`}
                  statusText="Подключён — входящие обрабатывает ассистент"
                  reconnectLabel="Переподключить"
                  onReconnect={() => {
                    setReconnectKind("whatsapp");
                    setWaResult(null);
                  }}
                  confirmDelete={confirmDeleteChannelId === existingWa.id}
                  onAskDelete={() => setConfirmDeleteChannelId(existingWa.id)}
                  onConfirmDelete={() => handleDelete(existingWa.id)}
                  onCancelDelete={() => setConfirmDeleteChannelId(null)}
                />
              ) : (
                <form onSubmit={handleWhatsAppSubmit} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Phone number ID</Label>
                    <Input
                      value={waPhoneId}
                      onChange={(e) => setWaPhoneId(e.target.value)}
                      placeholder="123456789012345"
                      pattern="\d{10,20}"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Access token</Label>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={waAccessToken}
                      onChange={(e) => setWaAccessToken(e.target.value)}
                      placeholder="EAAJZBxxxxxxx…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Business account ID (опционально)</Label>
                    <Input
                      value={waBizId}
                      onChange={(e) => setWaBizId(e.target.value)}
                      placeholder="123456789012345"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Verify Token (опц.)</Label>
                      <Input
                        autoComplete="off"
                        value={waVerifyToken}
                        onChange={(e) => setWaVerifyToken(e.target.value)}
                        placeholder="любая строка для Meta webhook"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>App Secret (опц.)</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={waAppSecret}
                        onChange={(e) => setWaAppSecret(e.target.value)}
                        placeholder="Meta → App settings → Basic"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Verify Token — придумайте строку и впишите её же в Meta dashboard при настройке
                    webhook. App Secret включает проверку подписи входящих вебхуков. Оставьте
                    пустыми для общих ключей платформы.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      disabled={waSubmitting || !waPhoneId.trim() || !waAccessToken.trim()}
                    >
                      {waSubmitting ? "Проверяем у Meta…" : "Подключить"}
                    </Button>
                    {existingWa && reconnectKind === "whatsapp" && (
                      <Button type="button" variant="ghost" onClick={() => setReconnectKind(null)}>
                        Отмена
                      </Button>
                    )}
                  </div>
                </form>
              )}
              {waResult && (
                <OkNote>
                  ✓ WhatsApp {waResult.displayPhoneNumber ?? waResult.phoneNumberId} подключён.
                  {waResult.webhookSetupHint && (
                    <span className="mt-2 block font-mono text-xs">
                      Webhook URL: {waResult.webhookSetupHint.url}
                      <br />
                      Verify token: {waResult.webhookSetupHint.verifyToken}
                    </span>
                  )}
                </OkNote>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="facebook">
          <Card>
            <CardHeader>
              <CardTitle>
                {existingFb && reconnectKind !== "facebook"
                  ? "Facebook Messenger"
                  : "Подключить Facebook Messenger"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Из{" "}
                <a
                  href="https://developers.facebook.com/apps/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Meta for Developers
                </a>{" "}
                → Messenger → Settings: сгенерируйте{" "}
                <code className="font-mono">Page Access Token</code> для вашей Страницы. Page ID
                определится автоматически.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {existingFb && reconnectKind !== "facebook" ? (
                <ConnectedChannelCard
                  title={`Facebook #${existingFb.externalId}`}
                  statusText="Подключён — входящие обрабатывает ассистент"
                  reconnectLabel="Переподключить"
                  onReconnect={() => {
                    setReconnectKind("facebook");
                    setFbResult(null);
                  }}
                  confirmDelete={confirmDeleteChannelId === existingFb.id}
                  onAskDelete={() => setConfirmDeleteChannelId(existingFb.id)}
                  onConfirmDelete={() => handleDelete(existingFb.id)}
                  onCancelDelete={() => setConfirmDeleteChannelId(null)}
                />
              ) : (
                <form onSubmit={handleFacebookSubmit} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Page Access Token</Label>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={fbPageToken}
                      onChange={(e) => setFbPageToken(e.target.value)}
                      placeholder="EAAJZBxxxxxxx…"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Verify Token (опц.)</Label>
                      <Input
                        autoComplete="off"
                        value={fbVerifyToken}
                        onChange={(e) => setFbVerifyToken(e.target.value)}
                        placeholder="любая строка для Meta webhook"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>App Secret (опц.)</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={fbAppSecret}
                        onChange={(e) => setFbAppSecret(e.target.value)}
                        placeholder="Meta → App settings → Basic"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Verify Token — придумайте строку и впишите её же в Meta dashboard при настройке
                    webhook. App Secret включает проверку подписи входящих вебхуков. Оставьте
                    пустыми для общих ключей платформы.
                  </p>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={fbSubmitting || !fbPageToken.trim()}>
                      {fbSubmitting ? "Проверяем у Meta…" : "Подключить"}
                    </Button>
                    {existingFb && reconnectKind === "facebook" && (
                      <Button type="button" variant="ghost" onClick={() => setReconnectKind(null)}>
                        Отмена
                      </Button>
                    )}
                  </div>
                </form>
              )}
              {fbResult && (
                <OkNote>
                  ✓ Facebook {fbResult.pageName ?? fbResult.pageId} подключён.
                  {fbResult.webhookSetupHint && (
                    <span className="mt-2 block font-mono text-xs">
                      Webhook URL: {fbResult.webhookSetupHint.url}
                      <br />
                      Verify token: {fbResult.webhookSetupHint.verifyToken}
                    </span>
                  )}
                </OkNote>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="web">
          <Card>
            <CardHeader>
              <CardTitle>
                {existingWeb && reconnectKind !== "web" ? "Web-виджет" : "Web-виджет на сайт"}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Плавающий чат для вашего сайта. После включения покажем готовый snippet.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {existingWeb && reconnectKind !== "web" && !webResult ? (
                <ConnectedChannelCard
                  title={`Web (${existingWeb.externalId})`}
                  statusText="Виджет включён — встроен на сайт"
                  reconnectLabel="Настроить заново"
                  onReconnect={() => setReconnectKind("web")}
                  confirmDelete={confirmDeleteChannelId === existingWeb.id}
                  onAskDelete={() => setConfirmDeleteChannelId(existingWeb.id)}
                  onConfirmDelete={() => handleDelete(existingWeb.id)}
                  onCancelDelete={() => setConfirmDeleteChannelId(null)}
                />
              ) : (
                <form onSubmit={handleWebSubmit} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Название бренда (опц.)</Label>
                      <Input
                        value={webBrand}
                        onChange={(e) => setWebBrand(e.target.value)}
                        placeholder="Acme Support"
                        maxLength={64}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Цвет акцента (hex)</Label>
                      <Input
                        value={webColor}
                        onChange={(e) => setWebColor(e.target.value)}
                        placeholder="#6aa6ff"
                        pattern="#[0-9a-fA-F]{3,8}"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={webSubmitting}>
                      {webSubmitting ? "Создаём…" : webResult ? "Обновить" : "Включить виджет"}
                    </Button>
                    {existingWeb && reconnectKind === "web" && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setReconnectKind(null);
                          setWebResult(null);
                        }}
                      >
                        Отмена
                      </Button>
                    )}
                  </div>
                </form>
              )}

              {webResult?.snippet && (
                <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
                  <p className="text-sm font-medium">Код для вставки</p>
                  <pre className="overflow-x-auto rounded-md bg-background p-3 font-mono text-xs">
                    {webResult.snippet.html}
                  </pre>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => webResult.snippet && copySnippet(webResult.snippet.html)}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? "Скопировано" : "Копировать"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Подключённые каналы</CardTitle>
          <Badge variant="secondary">{channels.length}</Badge>
        </CardHeader>
        <CardContent>
          {channels.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Пока ничего не подключено.
            </p>
          ) : (
            <ul className="divide-y">
              {channels.map((ch) => {
                const meta = KIND_META[ch.kind] ?? { icon: GlobeIcon, label: ch.kind };
                const Icon = meta.icon;
                const title =
                  ch.kind === "telegram_userbot"
                    ? `${ch.username ? `@${ch.username}` : `TG ${ch.externalId}`} · личный`
                    : ch.kind === "telegram_bot"
                      ? `@${ch.externalId}`
                      : ch.kind === "whatsapp"
                        ? `WhatsApp #${ch.externalId}`
                        : ch.kind === "web"
                          ? `Web (${ch.externalId})`
                          : ch.externalId;
                return (
                  <li key={ch.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{title}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant={ch.status === "error" ? "warning" : "secondary"}>
                          {ch.status === "active"
                            ? "активен"
                            : ch.status === "paused"
                              ? "на паузе"
                              : ch.status === "error"
                                ? "ошибка"
                                : ch.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(ch.createdAt * 1000).toLocaleDateString("ru")}
                        </span>
                      </div>
                    </div>
                    {ch.kind === "telegram_userbot" && ch.status === "error" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          resetUserbot();
                          setUbDone(null);
                          setTab("userbot");
                        }}
                      >
                        Авторизовать заново
                      </Button>
                    )}
                    {confirmDeleteChannelId === ch.id ? (
                      <div className="flex items-center gap-1">
                        <TriangleAlertIcon className="size-3.5 text-destructive shrink-0" />
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(ch.id)}>
                          Да
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteChannelId(null)}
                        >
                          Нет
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmDeleteChannelId(ch.id)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Нужна расширенная настройка?{" "}
        <Link to="/onboarding" className="text-primary hover:underline">
          Мастер онбординга →
        </Link>
      </p>
    </div>
  );
}
