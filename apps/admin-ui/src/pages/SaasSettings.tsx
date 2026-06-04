import { CheckIcon, KeyRoundIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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
import {
  ApiError,
  clearToken,
  type LlmConfig,
  type LlmProvider,
  type LlmPurpose,
  saas,
} from "../api/saas.ts";

// Провайдеры, у которых нужен API-ключ
const KEYED_PROVIDERS: LlmProvider[] = ["openai", "openrouter", "anthropic", "jina", "cohere"];

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
  jina: "Jina AI",
  cohere: "Cohere",
};

const ALL_PROVIDERS: LlmProvider[] = [
  "openai",
  "openrouter",
  "anthropic",
  "ollama",
  "jina",
  "cohere",
];

// Дефолтный base URL провайдера (применяется на сервере, если поле пустое).
// Показываем как placeholder, чтобы было видно, куда пойдут запросы.
const DEFAULT_BASE_URL: Record<LlmProvider, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434",
  jina: "https://api.jina.ai/v1",
  cohere: "https://api.cohere.com/v2",
};

const PURPOSES: {
  value: LlmPurpose;
  label: string;
  hint: string;
  defaultProvider: LlmProvider;
  defaultModel: string;
}[] = [
  {
    value: "chat",
    label: "Chat — ответ ассистента",
    hint: "LLM для диалога с пользователем",
    defaultProvider: "openrouter",
    defaultModel: "google/gemini-2.5-flash",
  },
  {
    value: "embed",
    label: "Embeddings — поиск по базе",
    hint: "Модель для векторизации документов и запросов",
    defaultProvider: "openai",
    defaultModel: "text-embedding-3-small",
  },
  {
    value: "vision",
    label: "Зрение — анализ документов",
    hint: "Для OCR, анализа фото и сканов. Нужна для загрузки документов.",
    defaultProvider: "openrouter",
    defaultModel: "google/gemini-2.5-flash",
  },
  {
    value: "reranker",
    label: "Reranker — переранжирование KB",
    hint: "Jina или Cohere reranker: повышает точность RAG-ответов. Необязательно.",
    defaultProvider: "jina",
    defaultModel: "jina-reranker-v2-base-multilingual",
  },
  {
    value: "transcribe",
    label: "Расшифровка голоса",
    hint: "Распознавание голосовых. OpenRouter: модель google/chirp-3 или openai/whisper-1 (тем же ключом, что чат). OpenAI: whisper-1. Groq: выберите OpenAI + Base URL https://api.groq.com/openai/v1, модель whisper-large-v3. Если не задать — возьмётся ключ чата/эмбеддингов (если это OpenAI/OpenRouter).",
    defaultProvider: "openrouter",
    defaultModel: "google/chirp-3",
  },
];

interface PurposeForm {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  embedDim: string;
  timeoutMs: string;
}

export function SaasSettings() {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Ключи по провайдерам (вводятся один раз)
  const [providerKeys, setProviderKeys] = useState<Record<LlmProvider, string>>({
    openai: "",
    openrouter: "",
    anthropic: "",
    ollama: "",
    jina: "",
    cohere: "",
  });
  const [savingProvider, setSavingProvider] = useState<LlmProvider | null>(null);

  // Формы назначений (провайдер + модель + доп. поля)
  const defaultForms = Object.fromEntries(
    PURPOSES.map(({ value, defaultProvider, defaultModel }) => [
      value,
      { provider: defaultProvider, model: defaultModel, baseUrl: "", embedDim: "", timeoutMs: "" },
    ]),
  ) as Record<LlmPurpose, PurposeForm>;

  const [forms, setForms] = useState<Record<LlmPurpose, PurposeForm>>(defaultForms);
  // savedForms — последнее сохранённое состояние (для определения dirty)
  const [savedForms, setSavedForms] = useState<Record<LlmPurpose, PurposeForm>>(defaultForms);
  const [savingPurpose, setSavingPurpose] = useState<LlmPurpose | null>(null);
  const [confirmDeletePurpose, setConfirmDeletePurpose] = useState<LlmPurpose | null>(null);

  function applyConfigToForm(cfg: LlmConfig) {
    const data: PurposeForm = {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl ?? "",
      embedDim: cfg.embedDim?.toString() ?? "",
      timeoutMs: cfg.timeoutMs?.toString() ?? "",
    };
    setForms((prev) => ({ ...prev, [cfg.purpose]: data }));
    setSavedForms((prev) => ({ ...prev, [cfg.purpose]: data }));
  }

  function isPurposeDirty(purpose: LlmPurpose): boolean {
    const f = forms[purpose];
    const s = savedForms[purpose];
    return (
      f.provider !== s.provider ||
      f.model !== s.model ||
      f.baseUrl !== s.baseUrl ||
      f.embedDim !== s.embedDim ||
      f.timeoutMs !== s.timeoutMs
    );
  }

  async function refresh() {
    try {
      const { items } = await saas.listLlmConfigs();
      setConfigs(items);
      for (const cfg of items) applyConfigToForm(cfg);
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

  function updateForm(purpose: LlmPurpose, patch: Partial<PurposeForm>) {
    setForms((prev) => ({ ...prev, [purpose]: { ...prev[purpose], ...patch } }));
  }

  // Сохранить ключ для провайдера — применяется ко всем назначениям этого провайдера
  async function handleSaveProviderKey(e: FormEvent, provider: LlmProvider) {
    e.preventDefault();
    const key = providerKeys[provider].trim();
    if (!key) return;
    setError("");
    setSavingProvider(provider);
    try {
      const purposesForProvider = configs.filter((c) => c.provider === provider);
      if (purposesForProvider.length === 0) {
        setError(
          `Сначала сохраните хотя бы одно назначение с провайдером ${PROVIDER_LABEL[provider]}`,
        );
        return;
      }
      // Обновляем ключ во всех назначениях с этим провайдером
      await Promise.all(
        purposesForProvider.map((c) =>
          saas.upsertLlmConfig(c.purpose, {
            provider: c.provider,
            model: c.model,
            apiKey: key,
            ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
            ...(c.embedDim ? { embedDim: c.embedDim } : {}),
            ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
          }),
        ),
      );
      setProviderKeys((prev) => ({ ...prev, [provider]: "" }));
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProvider(null);
    }
  }

  async function savePurpose(purpose: LlmPurpose) {
    setError("");
    const f = forms[purpose];
    if (!f.model.trim()) {
      setError(`${purpose}: укажите модель`);
      return;
    }
    if (purpose === "embed" && !f.embedDim) {
      setError("embed: укажите размерность (например, 1536)");
      return;
    }
    const existing = configs.find((c) => c.purpose === purpose);
    const apiKey = providerKeys[f.provider].trim();
    // Ключ нужен, только если: провайдер требует его (не ollama) И его ещё нигде
    // нет — ни в этом назначении (existing.hasSecret), ни в другом с тем же
    // провайдером (providerHasKey, ключ переиспользуется на бэкенде).
    if (f.provider !== "ollama" && !apiKey && !existing?.hasSecret && !providerHasKey(f.provider)) {
      setError(`Введите API-ключ ${PROVIDER_LABEL[f.provider]} в поле на этой карточке.`);
      return;
    }
    setSavingPurpose(purpose);
    try {
      await saas.upsertLlmConfig(purpose, {
        provider: f.provider,
        model: f.model.trim(),
        ...(apiKey ? { apiKey } : {}),
        ...(f.baseUrl.trim() ? { baseUrl: f.baseUrl.trim() } : {}),
        ...(f.embedDim ? { embedDim: Number.parseInt(f.embedDim, 10) } : {}),
        ...(f.timeoutMs ? { timeoutMs: Number.parseInt(f.timeoutMs, 10) } : {}),
      });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        navigate("/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPurpose(null);
    }
  }

  function handleSubmitPurpose(e: FormEvent, purpose: LlmPurpose) {
    e.preventDefault();
    savePurpose(purpose);
  }

  async function handleDelete(purpose: LlmPurpose) {
    setConfirmDeletePurpose(null);
    try {
      await saas.deleteLlmConfig(purpose);
      const def = PURPOSES.find((p) => p.value === purpose)!;
      setForms((prev) => ({
        ...prev,
        [purpose]: {
          provider: def.defaultProvider,
          model: def.defaultModel,
          baseUrl: "",
          embedDim: "",
          timeoutMs: "",
        },
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Какие провайдеры реально используются в сохранённых конфигах
  const usedProviders = [...new Set(configs.map((c) => c.provider))].filter((p) =>
    KEYED_PROVIDERS.includes(p),
  );
  // Провайдер имеет сохранённый ключ хотя бы в одном назначении
  const providerHasKey = (p: LlmProvider) => configs.some((c) => c.provider === p && c.hasSecret);

  if (loading)
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Настройки LLM"
        description="BYOK — собственные ключи. Хранятся зашифрованными (AES-256-GCM), применяются live."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ── Ключи провайдеров ── */}
      <div className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          <KeyRoundIcon className="size-3.5" /> Ключи провайдеров
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(usedProviders.length > 0 ? usedProviders : KEYED_PROVIDERS).map((provider) => (
            <Card key={provider} className="py-4">
              <CardContent className="px-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{PROVIDER_LABEL[provider]}</span>
                  {providerHasKey(provider) ? (
                    <Badge variant="success" className="gap-1">
                      <CheckIcon className="size-3" /> есть
                    </Badge>
                  ) : (
                    <Badge variant="warning">нет ключа</Badge>
                  )}
                </div>
                <form onSubmit={(e) => handleSaveProviderKey(e, provider)} className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={providerKeys[provider]}
                    onChange={(e) =>
                      setProviderKeys((prev) => ({ ...prev, [provider]: e.target.value }))
                    }
                    placeholder={providerHasKey(provider) ? "•••••••• (обновить)" : "sk-…"}
                    className="text-xs h-8"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={savingProvider === provider || !providerKeys[provider].trim()}
                    className="shrink-0 h-8"
                  >
                    {savingProvider === provider ? "…" : "OK"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* ── Назначения ── */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Назначения
        </h2>
        <div className="grid gap-6 lg:grid-cols-3">
          {PURPOSES.map(({ value: purpose, label, hint }) => {
            const cfg = configs.find((c) => c.purpose === purpose);
            const f = forms[purpose];
            return (
              <Card key={purpose} className="group">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <CardTitle className="text-sm">{label}</CardTitle>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 ml-2">
                    {/* Иконка сохранения — только при изменениях */}
                    {isPurposeDirty(purpose) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6 text-primary hover:bg-primary/10"
                        disabled={savingPurpose === purpose}
                        onClick={() => savePurpose(purpose)}
                      >
                        {savingPurpose === purpose ? (
                          <span className="text-[10px]">…</span>
                        ) : (
                          <SaveIcon className="size-3" />
                        )}
                      </Button>
                    )}
                    {/* Иконка удаления — при наведении, только если есть сохранённый конфиг */}
                    {cfg &&
                      (confirmDeletePurpose === purpose ? (
                        <>
                          <span className="text-xs text-muted-foreground mr-1">Удалить?</span>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 px-2 text-xs"
                            onClick={() => handleDelete(purpose)}
                          >
                            Да
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            onClick={() => setConfirmDeletePurpose(null)}
                          >
                            Нет
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setConfirmDeletePurpose(purpose)}
                        >
                          <Trash2Icon className="size-3" />
                        </Button>
                      ))}
                  </div>
                </CardHeader>
                <CardContent>
                  {cfg && (
                    <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                      <code className="font-mono text-primary">{cfg.provider}</code>
                      <span className="text-muted-foreground">/</span>
                      <code className="font-mono break-all">{cfg.model}</code>
                      {providerHasKey(cfg.provider) ? (
                        <Badge variant="success" className="ml-auto text-[10px] py-0">
                          ключ есть
                        </Badge>
                      ) : (
                        <Badge variant="warning" className="ml-auto text-[10px] py-0">
                          без ключа
                        </Badge>
                      )}
                    </div>
                  )}
                  <form onSubmit={(e) => handleSubmitPurpose(e, purpose)} className="space-y-2.5">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Провайдер</Label>
                      <Select
                        value={f.provider}
                        onValueChange={(v) => updateForm(purpose, { provider: v as LlmProvider })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ALL_PROVIDERS.map((p) => (
                            <SelectItem key={p} value={p} className="text-xs">
                              {PROVIDER_LABEL[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* Inline API-ключ — пока у выбранного провайдера ключа нет.
                        Разрывает тупик: новое назначение (напр. Jina reranker) можно
                        сохранить сразу с ключом, не имея ещё карточки в «Ключи провайдеров». */}
                    {f.provider !== "ollama" && !providerHasKey(f.provider) && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">API-ключ {PROVIDER_LABEL[f.provider]}</Label>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          className="h-8 text-xs"
                          value={providerKeys[f.provider]}
                          onChange={(e) =>
                            setProviderKeys((prev) => ({ ...prev, [f.provider]: e.target.value }))
                          }
                          placeholder="sk-…"
                        />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Модель</Label>
                      <Input
                        className="h-8 text-xs"
                        value={f.model}
                        onChange={(e) => updateForm(purpose, { model: e.target.value })}
                        placeholder={
                          purpose === "embed" ? "text-embedding-3-small" : "google/gemini-2.5-flash"
                        }
                      />
                    </div>
                    {purpose === "embed" && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Размер вектора</Label>
                        <Input
                          className="h-8 text-xs"
                          inputMode="numeric"
                          value={f.embedDim}
                          onChange={(e) =>
                            updateForm(purpose, { embedDim: e.target.value.replace(/\D/g, "") })
                          }
                          placeholder="1536"
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Таймаут (мс)</Label>
                        <Input
                          className="h-8 text-xs"
                          inputMode="numeric"
                          value={f.timeoutMs}
                          onChange={(e) =>
                            updateForm(purpose, { timeoutMs: e.target.value.replace(/\D/g, "") })
                          }
                          placeholder="30000"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Base URL (опц.)</Label>
                        <Input
                          className="h-8 text-xs"
                          value={f.baseUrl}
                          onChange={(e) => updateForm(purpose, { baseUrl: e.target.value })}
                          placeholder={DEFAULT_BASE_URL[f.provider] ?? ""}
                        />
                      </div>
                    </div>
                    {!cfg && (
                      <Button
                        type="submit"
                        size="sm"
                        className="w-full"
                        disabled={savingPurpose !== null}
                      >
                        {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
                      </Button>
                    )}
                  </form>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
