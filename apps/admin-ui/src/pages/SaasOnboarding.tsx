import {
  ArrowRightIcon,
  CheckIcon,
  RocketIcon,
  SendIcon,
  TriangleAlertIcon,
  UploadIcon,
  UserIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ModeToggle } from "@/components/mode-toggle";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ApiError,
  type ChannelItem,
  clearToken,
  type KbDoc,
  type LlmConfig,
  type LlmProvider,
  type LlmPurpose,
  type VerticalInfo,
  saas,
} from "../api/saas.ts";

/**
 * Пошаговый мастер первичной настройки: канал → API-ключи → база знаний →
 * готово. Порядок не случаен: эмбеддинги базы требуют ключ embed-провайдера.
 */

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama (local)" },
];

const STEP_LABELS = ["Канал", "Провайдер", "База знаний", "Готово"];

interface KeyForm {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  embedDim: string;
}

const EMPTY_KEY_FORM: KeyForm = { provider: "openai", model: "", apiKey: "", baseUrl: "", embedDim: "" };

const OLLAMA_PRESETS: Record<"chat" | "embed", { model: string; embedDim?: string }> = {
  chat: { model: "llama3.2" },
  embed: { model: "nomic-embed-text", embedDim: "768" },
};

function configReady(cfg: LlmConfig | undefined): boolean {
  if (!cfg) return false;
  return cfg.provider === "ollama" || cfg.hasSecret;
}

export function SaasOnboarding() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");

  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [docs, setDocs] = useState<KbDoc[]>([]);

  const [channelMode, setChannelMode] = useState<"userbot" | "bot">("userbot");
  const [botToken, setBotToken] = useState("");
  const [tgSubmitting, setTgSubmitting] = useState(false);

  const [ubStep, setUbStep] = useState<"phone" | "code" | "2fa">("phone");
  const [ubPhone, setUbPhone] = useState("");
  const [ubApiId, setUbApiId] = useState("");
  const [ubApiHash, setUbApiHash] = useState("");
  const [ubCode, setUbCode] = useState("");
  const [ubPassword, setUbPassword] = useState("");
  const [ubLoginId, setUbLoginId] = useState("");
  const [ubSubmitting, setUbSubmitting] = useState(false);
  const [ubError, setUbError] = useState("");

  const [keyForms, setKeyForms] = useState<Record<"chat" | "embed", KeyForm>>({
    chat: { ...EMPTY_KEY_FORM },
    embed: { ...EMPTY_KEY_FORM },
  });
  const [savingPurpose, setSavingPurpose] = useState<LlmPurpose | null>(null);

  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteTopic, setPasteTopic] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [uploading, setUploading] = useState(false);
  const [lastIndexed, setLastIndexed] = useState<number | null>(null);

  const [verticals, setVerticals] = useState<VerticalInfo[]>([]);
  const [installingVertical, setInstallingVertical] = useState<string | null>(null);
  const [installedVertical, setInstalledVertical] = useState<string | null>(null);

  const chatCfg = configs.find((c) => c.purpose === "chat");
  const embedCfg = configs.find((c) => c.purpose === "embed");

  const channelDone = channels.length > 0;
  const keysDone = configReady(chatCfg) && configReady(embedCfg);
  const kbDone = docs.length > 0;
  const stepDone = [channelDone, keysDone, kbDone, false];

  function reachable(target: number): boolean {
    if (target <= 0) return true;
    if (target === 1) return channelDone;
    return channelDone && keysDone;
  }

  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      navigate("/login", { replace: true });
      return true;
    }
    return false;
  }

  async function loadState() {
    const [ch, cfg, verts] = await Promise.all([
      saas.listChannels(),
      saas.listLlmConfigs(),
      saas.listVerticals().catch(() => ({ items: [] as VerticalInfo[] })),
    ]);
    setVerticals(verts.items);
    let docItems: KbDoc[] = [];
    try {
      docItems = (await saas.listDocs()).items;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
    }
    setChannels(ch.items);
    setConfigs(cfg.items);
    setDocs(docItems);
    for (const c of cfg.items) {
      if (c.purpose === "chat" || c.purpose === "embed") {
        setKeyForms((prev) => ({
          ...prev,
          [c.purpose]: {
            provider: c.provider,
            model: c.model,
            apiKey: "",
            baseUrl: c.baseUrl ?? "",
            embedDim: c.embedDim?.toString() ?? "",
          },
        }));
      }
    }
    return { ch: ch.items, cfg: cfg.items, kb: docItems };
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ch, cfg, kb } = await loadState();
        if (cancelled) return;
        const cDone = ch.length > 0;
        const kDone =
          configReady(cfg.find((c) => c.purpose === "chat")) &&
          configReady(cfg.find((c) => c.purpose === "embed"));
        const dDone = kb.length > 0;
        setStep(!cDone ? 0 : !kDone ? 1 : !dDone ? 2 : 3);
      } catch (err) {
        if (cancelled) return;
        if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once
  }, []);

  function updateKeyForm(purpose: "chat" | "embed", patch: Partial<KeyForm>) {
    setKeyForms((prev) => ({ ...prev, [purpose]: { ...prev[purpose], ...patch } }));
  }

  async function handleTelegram(e: FormEvent) {
    e.preventDefault();
    setError("");
    const token = botToken.trim();
    if (!token) {
      setError("Вставьте Telegram bot token из @BotFather");
      return;
    }
    setTgSubmitting(true);
    try {
      await saas.createTelegramChannel(token);
      setBotToken("");
      const { ch } = await loadState();
      if (ch.length > 0) setStep(1);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.errorCode.toLowerCase().includes("telegram")) {
          setError("Telegram отверг токен — проверьте, что вставили правильно из @BotFather");
        } else if (handleAuthError(err)) {
          return;
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
      setTgSubmitting(false);
    }
  }

  function userbotErrMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (handleAuthError(err)) return "";
      if (err.errorCode === "userbot_creds_required" || err.errorCode === "userbot_creds_invalid") {
        return (
          (err.extra?.message as string | undefined) ??
          "Укажите API ID и API Hash (my.telegram.org → API development tools)"
        );
      }
      if (err.status === 503) return "Userbot временно недоступен — попробуйте позже";
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
        return;
      }
      resetUserbot();
      const { ch } = await loadState();
      if (ch.length > 0) setStep(1);
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
      await saas.submitUserbot2fa(ubLoginId, ubPassword);
      resetUserbot();
      const { ch } = await loadState();
      if (ch.length > 0) setStep(1);
    } catch (err) {
      setUbError(userbotErrMessage(err));
    } finally {
      setUbSubmitting(false);
    }
  }

  async function handleSaveKey(e: FormEvent, purpose: "chat" | "embed") {
    e.preventDefault();
    setError("");
    const f = keyForms[purpose];
    if (!f.model.trim()) {
      setError(`${purpose}: укажите модель`);
      return;
    }
    if (purpose === "embed" && !f.embedDim) {
      setError("embed: укажите размерность (например, 1536 для text-embedding-3-small)");
      return;
    }
    const existing = configs.find((c) => c.purpose === purpose);
    if (f.provider !== "ollama" && !f.apiKey && !existing?.hasSecret) {
      setError(`${purpose}: укажите API key`);
      return;
    }
    setSavingPurpose(purpose);
    try {
      await saas.upsertLlmConfig(purpose, {
        provider: f.provider,
        model: f.model.trim(),
        ...(f.apiKey ? { apiKey: f.apiKey } : {}),
        ...(f.baseUrl.trim() ? { baseUrl: f.baseUrl.trim() } : {}),
        ...(purpose === "embed" && f.embedDim ? { embedDim: Number.parseInt(f.embedDim, 10) } : {}),
      });
      updateKeyForm(purpose, { apiKey: "" });
      const { cfg } = await loadState();
      const ready =
        configReady(cfg.find((c) => c.purpose === "chat")) &&
        configReady(cfg.find((c) => c.purpose === "embed"));
      if (ready) setStep(2);
    } catch (err) {
      if (!handleAuthError(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPurpose(null);
    }
  }

  function handleKbError(err: unknown) {
    if (err instanceof ApiError && err.status === 402) {
      setError((err.extra?.upgradeHint as string) ?? "Лимит документов исчерпан — повысьте план");
    } else if (!handleAuthError(err)) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    setLastIndexed(null);
    try {
      const res = await saas.uploadFile(file);
      setLastIndexed(res.chunks);
      await loadState();
    } catch (err) {
      handleKbError(err);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handlePaste(e: FormEvent) {
    e.preventDefault();
    if (!pasteBody.trim()) return;
    setUploading(true);
    setError("");
    setLastIndexed(null);
    try {
      const res = await saas.uploadJson({
        title: pasteTitle.trim() || "untitled",
        body: pasteBody,
        ...(pasteTopic.trim() ? { topic: pasteTopic.trim() } : {}),
      });
      setLastIndexed(res.chunks);
      setPasteTitle("");
      setPasteTopic("");
      setPasteBody("");
      await loadState();
    } catch (err) {
      handleKbError(err);
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Загрузка…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b px-4 md:px-8">
        <Link to="/dashboard" className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-chart-5 text-primary-foreground">
            <RocketIcon className="size-4" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            lead<span className="text-primary">·</span>engine
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link to="/dashboard">Пропустить →</Link>
          </Button>
          <ModeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Настройка кабинета</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Несколько шагов — и бот начнёт отвечать вашим клиентам.
          </p>
        </div>

        {/* Stepper */}
        <ol className="mb-8 flex items-center gap-2">
          {STEP_LABELS.map((label, i) => {
            const done = stepDone[i];
            const active = step === i;
            const canGo = reachable(i);
            return (
              <li key={label} className="flex flex-1 items-center gap-2">
                <button
                  type="button"
                  disabled={!canGo}
                  onClick={() => canGo && setStep(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                    active && "border-primary/50 bg-accent text-foreground",
                    !active && canGo && "text-muted-foreground hover:bg-muted/60",
                    !canGo && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                      done
                        ? "bg-[color-mix(in_oklch,var(--success)_22%,transparent)] text-[var(--success)]"
                        : active
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {done ? <CheckIcon className="size-3" /> : i + 1}
                  </span>
                  <span className="hidden font-medium sm:inline">{label}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {step === 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Шаг 1. Подключите канал</CardTitle>
              <p className="text-sm text-muted-foreground">
                Откуда приходят лиды? Подключите свой личный Telegram, чтобы ассистент отвечал в
                вашей личке, или отдельного бота.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {verticals.length > 0 && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">Шаблон воронки (опционально)</p>
                    {installedVertical && <Badge variant="success">установлен</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Автоматически настроит этапы воронки, навыки и стили продаж.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {verticals.map((v) => (
                      <Button
                        key={v.slug}
                        type="button"
                        variant={installedVertical === v.slug ? "default" : "outline"}
                        size="sm"
                        disabled={installingVertical !== null}
                        onClick={async () => {
                          setInstallingVertical(v.slug);
                          setError("");
                          try {
                            await saas.installVertical(v.slug);
                            setInstalledVertical(v.slug);
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setInstallingVertical(null);
                          }
                        }}
                      >
                        {installingVertical === v.slug ? "Устанавливаем…" : v.displayName}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {channelDone && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  Подключено каналов: <code className="font-mono">{channels.length}</code>
                  <Badge variant="success">готово</Badge>
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setChannelMode("userbot")}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    channelMode === "userbot"
                      ? "border-primary/50 bg-accent"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <UserIcon className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">Личный аккаунт</span>
                    <span className="block text-xs">Лиды пишут вам в личку</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setChannelMode("bot")}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    channelMode === "bot"
                      ? "border-primary/50 bg-accent"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <SendIcon className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-foreground">Telegram-бот</span>
                    <span className="block text-xs">Отдельный бот из @BotFather</span>
                  </span>
                </button>
              </div>

              {channelMode === "userbot" ? (
                <div className="space-y-3">
                  <p className="flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                    Подключайте только свой аккаунт и для ответов своим лидам — массовая рассылка
                    нарушает правила Telegram.
                  </p>
                  {ubError && (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {ubError}
                    </p>
                  )}

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
                      <Button type="submit" disabled={ubSubmitting || !ubPhone.trim()}>
                        {ubSubmitting ? "Отправляем код…" : "Получить код"}
                      </Button>
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
                </div>
              ) : (
                <div className="space-y-3">
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
                  <form onSubmit={handleTelegram} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label>Telegram bot token</Label>
                      <Input
                        type="text"
                        autoComplete="off"
                        value={botToken}
                        onChange={(e) => setBotToken(e.target.value)}
                        placeholder="123456789:AAEhBP…"
                      />
                    </div>
                    <Button type="submit" disabled={tgSubmitting || !botToken.trim()}>
                      {tgSubmitting ? "Проверяем…" : "Подключить"}
                    </Button>
                  </form>
                </div>
              )}

              <p className="text-sm text-muted-foreground">
                Нужен WhatsApp или web-виджет?{" "}
                <Link to="/channels" className="text-primary hover:underline">
                  Все типы каналов →
                </Link>
              </p>
              {channelDone && (
                <Button onClick={() => setStep(1)}>
                  Далее: LLM-провайдер <ArrowRightIcon />
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Шаг 2. LLM-провайдер</CardTitle>
              <p className="text-sm text-muted-foreground">
                Выберите AI-провайдер. Если Ollama уже запущена локально — API-ключ не нужен.
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {(["chat", "embed"] as const).map((purpose) => {
                const cfg = purpose === "chat" ? chatCfg : embedCfg;
                const f = keyForms[purpose];
                const isChat = purpose === "chat";
                return (
                  <div
                    key={purpose}
                    className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">
                        {isChat ? "Chat — ответы ассистента" : "Embeddings — поиск по базе"}
                      </h3>
                      {cfg &&
                        (configReady(cfg) ? (
                          <Badge variant="success">настроено</Badge>
                        ) : (
                          <Badge variant="warning">не настроено</Badge>
                        ))}
                    </div>
                    <form
                      onSubmit={(e) => handleSaveKey(e, purpose)}
                      className="grid gap-3 sm:grid-cols-2"
                    >
                      <div className="space-y-1.5">
                        <Label>Провайдер</Label>
                        <Select
                          value={f.provider}
                          onValueChange={(v) =>
                            updateKeyForm(purpose, { provider: v as LlmProvider })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PROVIDERS.map((p) => (
                              <SelectItem key={p.value} value={p.value}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Модель</Label>
                        <Input
                          value={f.model}
                          onChange={(e) => updateKeyForm(purpose, { model: e.target.value })}
                          placeholder={isChat ? "gpt-4o-mini" : "text-embedding-3-small"}
                        />
                      </div>
                      {f.provider !== "ollama" && (
                        <div className="space-y-1.5">
                          <Label>API-ключ {cfg?.hasSecret ? "(пусто — не менять)" : ""}</Label>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            value={f.apiKey}
                            onChange={(e) => updateKeyForm(purpose, { apiKey: e.target.value })}
                            placeholder={cfg?.hasSecret ? "•••••••• (сохранён)" : "sk-…"}
                          />
                        </div>
                      )}
                      {f.provider === "ollama" && (
                        <div className="space-y-1.5">
                          <Label>URL Ollama</Label>
                          <Input
                            value={f.baseUrl}
                            onChange={(e) => updateKeyForm(purpose, { baseUrl: e.target.value })}
                            placeholder="http://localhost:11434"
                          />
                        </div>
                      )}
                      {!isChat && (
                        <div className="space-y-1.5">
                          <Label>Размерность embed</Label>
                          <Input
                            type="number"
                            value={f.embedDim}
                            onChange={(e) => updateKeyForm(purpose, { embedDim: e.target.value })}
                            placeholder="1536"
                          />
                        </div>
                      )}
                      {f.provider === "ollama" && (
                        <p className="sm:col-span-2 text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
                          Ollama работает локально — API-ключ не нужен. Убедитесь, что{" "}
                          <code className="font-mono">ollama serve</code> запущен и модель загружена:{" "}
                          <code className="font-mono">ollama pull {OLLAMA_PRESETS[purpose].model}</code>
                        </p>
                      )}
                      <div className="sm:col-span-2 flex items-center gap-2">
                        <Button type="submit" disabled={savingPurpose !== null}>
                          {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
                        </Button>
                        {f.provider !== "ollama" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              updateKeyForm(purpose, {
                                provider: "ollama",
                                model: OLLAMA_PRESETS[purpose].model,
                                baseUrl: "http://localhost:11434",
                                apiKey: "",
                                ...(OLLAMA_PRESETS[purpose].embedDim
                                  ? { embedDim: OLLAMA_PRESETS[purpose].embedDim }
                                  : {}),
                              })
                            }
                          >
                            Использовать Ollama
                          </Button>
                        )}
                      </div>
                    </form>
                  </div>
                );
              })}
              <p className="text-sm text-muted-foreground">
                Timeout и другие параметры —{" "}
                <Link to="/settings" className="text-primary hover:underline">
                  расширенные настройки →
                </Link>
              </p>
              {keysDone && (
                <Button onClick={() => setStep(2)}>
                  Далее: база знаний <ArrowRightIcon />
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Шаг 3. База знаний (опционально)</CardTitle>
              <p className="text-sm text-muted-foreground">
                Загрузите документы — бот будет отвечать по вашей базе (RAG). Шаг можно пропустить.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {lastIndexed !== null && (
                <p className="rounded-md border border-[var(--success)]/40 bg-[color-mix(in_oklch,var(--success)_12%,transparent)] px-3 py-2 text-sm text-[var(--success)]">
                  ✓ Документ проиндексирован — {lastIndexed} фрагментов.
                </p>
              )}

              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-7 text-center transition-colors hover:border-primary/50 hover:bg-muted/50">
                <span className="grid size-9 place-items-center rounded-full bg-primary/15 text-primary">
                  <UploadIcon className="size-4" />
                </span>
                <span className="text-sm font-medium">Загрузить файл</span>
                <span className="text-xs text-muted-foreground">.txt, .md, .json, .pdf</span>
                <input
                  type="file"
                  accept=".txt,.md,.json,.pdf"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="sr-only"
                />
              </label>

              <form onSubmit={handlePaste} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder="Заголовок"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                  />
                  <Input
                    placeholder="Тема (опционально)"
                    value={pasteTopic}
                    onChange={(e) => setPasteTopic(e.target.value)}
                  />
                </div>
                <Textarea
                  placeholder="Текст документа…"
                  rows={5}
                  className="font-mono text-xs"
                  value={pasteBody}
                  onChange={(e) => setPasteBody(e.target.value)}
                />
                <Button type="submit" variant="outline" disabled={uploading || !pasteBody.trim()}>
                  {uploading ? "Загружаем…" : "Добавить текст"}
                </Button>
              </form>

              {docs.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Документов в базе: <code className="font-mono">{docs.length}</code>
                </p>
              )}

              <Button onClick={() => setStep(3)}>
                {kbDone ? "Далее" : "Пропустить"} <ArrowRightIcon />
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Готово!</CardTitle>
              <p className="text-sm text-muted-foreground">Можно переходить к работе.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {[
                  {
                    done: channelDone,
                    title: "Канал",
                    hint: channelDone ? `Подключено: ${channels.length}` : "Не подключён",
                  },
                  {
                    done: keysDone,
                    title: "LLM-провайдер",
                    hint: keysDone ? "chat + embed настроены" : "Не настроены",
                  },
                  {
                    done: kbDone,
                    title: "База знаний",
                    hint: kbDone ? `Документов: ${docs.length}` : "Пропущено (опционально)",
                  },
                ].map((s) => (
                  <li
                    key={s.title}
                    className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                  >
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full text-xs",
                        s.done
                          ? "bg-[color-mix(in_oklch,var(--success)_22%,transparent)] text-[var(--success)]"
                          : "border text-muted-foreground",
                      )}
                    >
                      {s.done ? <CheckIcon className="size-3.5" /> : "○"}
                    </span>
                    <div>
                      <p className="text-sm font-medium leading-tight">{s.title}</p>
                      <p className="text-xs text-muted-foreground">{s.hint}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <Button className="w-full" onClick={() => navigate("/dashboard", { replace: true })}>
                Перейти в кабинет <ArrowRightIcon />
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
