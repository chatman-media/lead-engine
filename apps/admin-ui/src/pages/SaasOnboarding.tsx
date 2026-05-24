import { ArrowRightIcon, CheckIcon, RocketIcon, UploadIcon } from "lucide-react";
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

const STEP_LABELS = ["Канал", "API-ключи", "База знаний", "Готово"];

interface KeyForm {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  embedDim: string;
}

const EMPTY_KEY_FORM: KeyForm = { provider: "openai", model: "", apiKey: "", embedDim: "" };

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

  const [botToken, setBotToken] = useState("");
  const [tgSubmitting, setTgSubmitting] = useState(false);

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
    const [ch, cfg] = await Promise.all([saas.listChannels(), saas.listLlmConfigs()]);
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
            <CardContent className="space-y-4">
              {channelDone && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  Подключено каналов: <code className="font-mono">{channels.length}</code>
                  <Badge variant="success">готово</Badge>
                </p>
              )}
              <form onSubmit={handleTelegram} className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Telegram bot token</Label>
                  <Input
                    type="password"
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
              <p className="text-sm text-muted-foreground">
                Нужен WhatsApp или web-виджет?{" "}
                <Link to="/channels" className="text-primary hover:underline">
                  Все типы каналов →
                </Link>
              </p>
              {channelDone && (
                <Button onClick={() => setStep(1)}>
                  Далее: API-ключи <ArrowRightIcon />
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Шаг 2. API-ключи</CardTitle>
              <p className="text-sm text-muted-foreground">
                BYOK — ключи для ответов (chat) и поиска по базе (embed). Хранятся зашифрованными.
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
                          <Badge variant="success">ключ есть</Badge>
                        ) : (
                          <Badge variant="warning">без ключа</Badge>
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
                      <div className="sm:col-span-2">
                        <Button type="submit" disabled={savingPurpose !== null}>
                          {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
                        </Button>
                      </div>
                    </form>
                  </div>
                );
              })}
              <p className="text-sm text-muted-foreground">
                Base URL, timeout и др. —{" "}
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
                    title: "API-ключи",
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
