import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  clearToken,
  type LlmConfig,
  type LlmProvider,
  type LlmPurpose,
  saas,
} from "../api/saas.ts";

/**
 * Per-tenant LLM provider configuration UI. Form per purpose (chat/embed).
 * API ключ хранится encrypted в tenant_secrets (AES-256-GCM); UI пишет
 * один раз, обратно не читает (hasSecret-флаг показывает, что ключ есть).
 *
 * NB: backend применяет изменения только после рестарта apps/api —
 * текущий InMemoryLlmRouter резолвится на boot. Hot-reload — TODO.
 */

const PURPOSES: { value: LlmPurpose; label: string; hint: string }[] = [
  { value: "chat", label: "Chat (ответ ассистента)", hint: "LLM для диалога с пользователем" },
  {
    value: "embed",
    label: "Embeddings (поиск по KB)",
    hint: "Модель для векторизации документов и запросов",
  },
];

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama (local, без API key)" },
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
  const [forms, setForms] = useState<Record<LlmPurpose, FormState>>({
    chat: { ...EMPTY_FORM },
    embed: { ...EMPTY_FORM, provider: "openai" },
    vision: { ...EMPTY_FORM },
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate stable
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
      setError("embed: укажите embedDim (например, 1536 для OpenAI text-embedding-3-small)");
      return;
    }
    const existing = configs.find((c) => c.purpose === purpose);
    if (f.provider !== "ollama" && !f.apiKey && !existing?.hasSecret) {
      setError(`${purpose}: укажите API key (или сохраните уже существующий)`);
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
    if (!confirm(`Удалить конфиг ${purpose}? API key в tenant_secrets останется (manual cleanup).`))
      return;
    try {
      await saas.deleteLlmConfig(purpose);
      setForms((prev) => ({ ...prev, [purpose]: { ...EMPTY_FORM } }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <div className="dashboard-loading">
        <p>Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Настройки LLM</h1>
          <p className="dashboard-sub">
            BYOK — собственные API ключи для chat / embed. Хранятся encrypted (AES-256-GCM).
          </p>
        </div>
        <Link to="/dashboard" className="back-link">
          ← К базе знаний
        </Link>
      </header>

      {error && <div className="dashboard-error">{error}</div>}

      <div className="settings-warning">
        ⚠ Изменения вступают в силу после рестарта сервера. Hot-reload — TODO.
      </div>

      {PURPOSES.map(({ value: purpose, label, hint }) => {
        const cfg = configs.find((c) => c.purpose === purpose);
        const f = forms[purpose];
        return (
          <section key={purpose} className="settings-section">
            <div className="settings-header">
              <h2>{label}</h2>
              {cfg && (
                <button
                  type="button"
                  className="btn-danger-link"
                  onClick={() => handleDelete(purpose)}
                >
                  Удалить
                </button>
              )}
            </div>
            <p className="hint">{hint}</p>
            {cfg && (
              <p className="settings-status">
                Активен: <code>{cfg.provider}</code> / <code>{cfg.model}</code>{" "}
                {cfg.hasSecret ? (
                  <span className="badge">API key есть</span>
                ) : (
                  <span className="badge badge-warning">без API key</span>
                )}
              </p>
            )}
            <form className="settings-form" onSubmit={(e) => handleSubmit(e, purpose)}>
              <label>
                Provider
                <select
                  value={f.provider}
                  onChange={(e) =>
                    updateForm(purpose, { provider: e.target.value as LlmProvider })
                  }
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <input
                  type="text"
                  value={f.model}
                  onChange={(e) => updateForm(purpose, { model: e.target.value })}
                  placeholder={
                    purpose === "embed" ? "text-embedding-3-small" : "gpt-4o-mini"
                  }
                  required
                />
              </label>
              {f.provider !== "ollama" && (
                <label>
                  API key {cfg?.hasSecret ? "(оставьте пустым, чтобы не менять)" : ""}
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={f.apiKey}
                    onChange={(e) => updateForm(purpose, { apiKey: e.target.value })}
                    placeholder={cfg?.hasSecret ? "•••••••• (сохранён)" : "sk-..."}
                  />
                </label>
              )}
              <label>
                Base URL (опционально)
                <input
                  type="text"
                  value={f.baseUrl}
                  onChange={(e) => updateForm(purpose, { baseUrl: e.target.value })}
                  placeholder={
                    f.provider === "ollama"
                      ? "http://localhost:11434"
                      : "https://api.openai.com/v1"
                  }
                />
              </label>
              {purpose === "embed" && (
                <label>
                  Embed dim (обязательно)
                  <input
                    type="number"
                    value={f.embedDim}
                    onChange={(e) => updateForm(purpose, { embedDim: e.target.value })}
                    placeholder="1536"
                    required
                  />
                </label>
              )}
              <label>
                Timeout (ms, опционально)
                <input
                  type="number"
                  value={f.timeoutMs}
                  onChange={(e) => updateForm(purpose, { timeoutMs: e.target.value })}
                  placeholder="30000"
                />
              </label>
              <button type="submit" disabled={savingPurpose !== null}>
                {savingPurpose === purpose ? "Сохраняем…" : "Сохранить"}
              </button>
            </form>
          </section>
        );
      })}
    </div>
  );
}
