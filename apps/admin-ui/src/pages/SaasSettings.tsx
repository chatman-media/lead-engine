import { AlertTriangleIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ApiError,
  clearToken,
  type LlmConfig,
  type LlmProvider,
  type LlmPurpose,
  saas,
} from "../api/saas.ts";

const PURPOSES: { value: LlmPurpose; label: string; hint: string }[] = [
  { value: "chat", label: "Chat — ответ ассистента", hint: "LLM для диалога с пользователем" },
  {
    value: "embed",
    label: "Embeddings — поиск по базе",
    hint: "Модель для векторизации документов и запросов",
  },
  {
    value: "vision",
    label: "Зрение — анализ документов",
    hint: "Модель для OCR, анализа фото и сканов (vision API). Нужна для загрузки документов.",
  },
];

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama (local)" },
];

interface FormState {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  embedDim: string;
  timeoutMs: string;
}

const EMPTY_FORM: FormState = {
  provider: "openai",
  model: "",
  apiKey: "",
  baseUrl: "",
  embedDim: "",
  timeoutMs: "",
};

export function SaasSettings() {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingPurpose, setSavingPurpose] = useState<LlmPurpose | null>(null);

  const [confirmDeletePurpose, setConfirmDeletePurpose] = useState<LlmPurpose | null>(null);
  const [forms, setForms] = useState<Record<LlmPurpose, FormState>>({
    chat: { ...EMPTY_FORM },
    embed: { ...EMPTY_FORM },
    vision: { ...EMPTY_FORM, provider: "openrouter", model: "google/gemini-2.5-flash" },
    judge: { ...EMPTY_FORM },
  });

  function applyConfigToForm(cfg: LlmConfig) {
    setForms((prev) => ({
      ...prev,
      [cfg.purpose]: {
        provider: cfg.provider,
        model: cfg.model,
        apiKey: "",
        baseUrl: cfg.baseUrl ?? "",
        embedDim: cfg.embedDim?.toString() ?? "",
        timeoutMs: cfg.timeoutMs?.toString() ?? "",
      },
    }));
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

  function updateForm(purpose: LlmPurpose, patch: Partial<FormState>) {
    setForms((prev) => ({ ...prev, [purpose]: { ...prev[purpose], ...patch } }));
  }

  async function handleSubmit(e: FormEvent, purpose: LlmPurpose) {
    e.preventDefault();
    setError("");
    const f = forms[purpose];
    if (!f.model.trim()) {
      setError(`${purpose}: укажите модель`);
      return;
    }
    if (purpose === "embed" && !f.embedDim) {
      setError("embed: укажите embedDim (например, 1536 для text-embedding-3-small)");
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
        ...(f.embedDim ? { embedDim: Number.parseInt(f.embedDim, 10) } : {}),
        ...(f.timeoutMs ? { timeoutMs: Number.parseInt(f.timeoutMs, 10) } : {}),
      });
      updateForm(purpose, { apiKey: "" });
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

  async function handleDelete(purpose: LlmPurpose) {
    setConfirmDeletePurpose(null);
    try {
      await saas.deleteLlmConfig(purpose);
      setForms((prev) => ({ ...prev, [purpose]: { ...EMPTY_FORM } }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border p-5 space-y-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-24" />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Настройки LLM"
        description="BYOK — собственные ключи для chat / embed. Хранятся зашифрованными (AES-256-GCM), применяются live."
      />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {PURPOSES.map(({ value: purpose, label, hint }) => {
          const cfg = configs.find((c) => c.purpose === purpose);
          const f = forms[purpose];
          return (
            <Card key={purpose}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div className="space-y-1">
                  <CardTitle>{label}</CardTitle>
                  <p className="text-sm text-muted-foreground">{hint}</p>
                </div>
                {cfg && (
                  confirmDeletePurpose === purpose ? (
                    <div className="flex items-center gap-1 text-sm">
                      <AlertTriangleIcon className="size-3.5 text-warning shrink-0" />
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(purpose)}>
                        Да
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDeletePurpose(null)}>
                        Нет
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmDeletePurpose(purpose)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )
                )}
              </CardHeader>
              <CardContent>
                {cfg && (
                  <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
                    <code className="font-mono text-primary">{cfg.provider}</code>
                    <span className="text-muted-foreground">/</span>
                    <code className="font-mono">{cfg.model}</code>
                    {cfg.hasSecret ? (
                      <Badge variant="success">ключ есть</Badge>
                    ) : (
                      <Badge variant="warning">без ключа</Badge>
                    )}
                  </div>
                )}
                <form onSubmit={(e) => handleSubmit(e, purpose)} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Провайдер</Label>
                    <Select
                      value={f.provider}
                      onValueChange={(v) => updateForm(purpose, { provider: v as LlmProvider })}
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
                      onChange={(e) => updateForm(purpose, { model: e.target.value })}
                      placeholder={
                        purpose === "embed"
                          ? "text-embedding-3-small"
                          : purpose === "vision"
                            ? "google/gemini-2.5-flash"
                            : "gpt-4o-mini"
                      }
                    />
                  </div>
                  {f.provider !== "ollama" && (
                    <div className="space-y-1.5">
                      <Label>API-ключ {cfg?.hasSecret ? "(пусто — не менять)" : ""}</Label>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={f.apiKey}
                        onChange={(e) => updateForm(purpose, { apiKey: e.target.value })}
                        placeholder={cfg?.hasSecret ? "•••••••• (сохранён)" : "sk-…"}
                      />
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    {purpose === "embed" && (
                      <div className="space-y-1.5">
                        <Label>Размер вектора</Label>
                        <Input
                          type="number"
                          value={f.embedDim}
                          onChange={(e) => updateForm(purpose, { embedDim: e.target.value })}
                          placeholder="1536"
                        />
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label>Таймаут (мс)</Label>
                      <Input
                        type="number"
                        value={f.timeoutMs}
                        onChange={(e) => updateForm(purpose, { timeoutMs: e.target.value })}
                        placeholder="30000"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Базовый URL (опционально)</Label>
                    <Input
                      value={f.baseUrl}
                      onChange={(e) => updateForm(purpose, { baseUrl: e.target.value })}
                      placeholder={
                        f.provider === "ollama"
                          ? "http://localhost:11434"
                          : "https://api.openai.com/v1"
                      }
                    />
                  </div>
                  <Button type="submit" disabled={savingPurpose !== null}>
                    {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          );
        })}
      </div>

    </div>
  );
}
